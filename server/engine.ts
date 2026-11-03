import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Attempt, ContinuationPlan, ServiceState, DeclaredOutcome, EventKind, HumanAction, NodeRunState, Run, RunEvent, RunMode, Workflow, WorkflowNode,
} from '../shared/types.ts';
import { emptyTotals } from '../shared/types.ts';
import { mockQuery } from './mockQuery.ts';
import { clip, redact } from './redact.ts';
import { rulesPrompt, snapshotRules } from './rules.ts';
import { readReuseCache, saveRun, writeReuseEntry } from './store.ts';
import { AttemptAccounting, sumTotals, type SessionSnapshot } from './usage.ts';
import { topoOrder } from './validate.ts';
import { pushLog, startService, waitForUrl, type ServiceHandle } from './service.ts';
import { depsPlan, diagnose, envWithNode, needsDeps, resolveNode, runOnce, type InstallPlan } from './nodeenv.ts';

const MAX_EVENTS = 6000;
const MAX_FEEDBACK_ROUNDS = 3;
const DONE = new Set(['completata', 'saltata', 'riusata']);

export type Broadcast = (msg: unknown) => void;

const active = new Map<string, RunEngine>();
export const getEngine = (id: string) => active.get(id);

/**
 * Quali fasi di un'esecuzione precedente si possono riprendere così come sono.
 * Una fase è ripresa se: esisteva già, è stata completata (o era già ripresa), la sua configurazione e le sue
 * fasi precedenti sono identiche, e tutte le fasi precedenti sono a loro volta riprese.
 */
export function planContinuation(wf: Workflow, from: Run): ContinuationPlan {
  const order = topoOrder(wf) ?? wf.nodes.map((n) => n.id);
  const reused = new Set<string>();
  const plan: ContinuationPlan = { fromRunId: from.id, reused: [], toRun: [] };
  const predsOf = (w: Workflow, id: string) => w.edges.filter((e) => e.target === id).map((e) => e.source).sort().join(',');
  for (const id of order) {
    const n = wf.nodes.find((x) => x.id === id)!;
    const old = from.snapshot.nodes.find((x) => x.id === id);
    const st = from.nodes[id];
    let reason = '';
    if (!old || !st) reason = 'fase nuova';
    else if (JSON.stringify(old.data) !== JSON.stringify(n.data)) reason = 'configurazione modificata';
    else if (predsOf(from.snapshot, id) !== predsOf(wf, id)) reason = 'collegamenti modificati';
    else if (n.data.kind === 'server') reason = 'server locale: va riavviato';
    else if (st.status !== 'completata' && st.status !== 'riusata') reason = `non completata nell'esecuzione precedente (${st.status.replace('_', ' ')})`;
    else if (!wf.edges.filter((e) => e.target === id).every((e) => reused.has(e.source))) reason = 'una fase precedente verrà rieseguita';
    if (reason) plan.toRun.push({ nodeId: id, label: n.data.label, reason });
    else { reused.add(id); plan.reused.push({ nodeId: id, label: n.data.label }); }
  }
  return plan;
}

export function startRun(wf: Workflow, mode: RunMode, budgetUsd?: number, from?: Run): RunEngine {
  const plan = from ? planContinuation(wf, from) : undefined;
  const run: Run = {
    id: `run_${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}_${randomUUID().slice(0, 6)}`,
    workflowId: wf.id,
    workflowName: wf.name,
    snapshot: structuredClone(wf),
    mode,
    status: 'in_corso',
    startedAt: new Date().toISOString(),
    budgetUsd,
    nodes: Object.fromEntries(wf.nodes.map((n) => [n.id, { nodeId: n.id, status: 'in_attesa', attempts: [], feedbackRounds: 0 } satisfies NodeRunState])),
    events: [],
    totals: emptyTotals(),
    notes: [],
    rules: snapshotRules(wf.settings),
    continuedFrom: from?.id,
  };
  // Fasi riprese: risultato, decisioni e sessione dell'esecuzione precedente, nessuna chiamata.
  for (const r of plan?.reused ?? []) {
    const old = from!.nodes[r.nodeId];
    const src = [...old.attempts].reverse().find((a) => a.status === 'ok') ?? old.attempts.at(-1);
    const withSession = [...old.attempts].reverse().find((a) => a.sessionId);
    const now = new Date().toISOString();
    run.nodes[r.nodeId] = {
      nodeId: r.nodeId, status: 'riusata', output: old.output, feedbackRounds: 0,
      attempts: src ? [{
        id: `${r.nodeId}#1`, nodeId: r.nodeId, index: 0, reason: 'riuso', startedAt: now, endedAt: now, status: 'ok',
        models: src.models, usage: emptyTotals(), usageSource: 'riusato',
        live: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, steps: 0, duplicatesSkipped: 0, subagentMessages: 0 },
        toolCalls: [], subagents: 0, resultText: src.resultText, declared: src.declared,
        reusedFrom: src.reusedFrom ?? { runId: from!.id, attemptId: src.id },
        // La sessione resta riprendibile (es. correzione chiesta in una nuova approvazione), con i totali già contati.
        sessionId: withSession?.sessionId, sessionCumulative: withSession?.sessionCumulative,
      }] : [],
    };
  }
  const eng = new RunEngine(run);
  active.set(run.id, eng);
  eng.start();
  return eng;
}

export class RunEngine {
  private listeners = new Set<Broadcast>();
  private controllers = new Map<string, AbortController>();
  private services = new Map<string, ServiceHandle>();
  /** Per le fasi server: versione di Node dedotta da un errore, installazione proponibile, tentativo automatico già fatto. */
  private serviceFixes = new Map<string, { range?: string; install?: InstallPlan; autoRetried?: boolean }>();
  private sessions = new Map<string, SessionSnapshot>();
  private running = new Set<string>();
  /** Approvazioni le cui fasi precedenti stanno applicando un feedback. */
  private reworking = new Set<string>();
  /** Fasi intermedie da rieseguire dopo una correzione richiesta in approvazione. */
  private afterCorrection = new Set<string>();
  private saveTimer: NodeJS.Timeout | null = null;
  private wf: Workflow;

  constructor(public run: Run) {
    this.wf = run.snapshot;
    for (const n of Object.values(run.nodes)) for (const a of n.attempts) if (a.sessionId && a.sessionCumulative) this.sessions.set(a.sessionId, a.sessionCumulative);
  }

  subscribe(fn: Broadcast) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private send(msg: unknown) {
    for (const l of this.listeners) l(msg);
  }

  private persist(immediate = false) {
    if (immediate) {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = null;
      saveRun(this.run);
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; saveRun(this.run); }, 800);
  }

  private event(kind: EventKind, text: string, extra: Partial<RunEvent> = {}) {
    const e: RunEvent = { seq: (this.run.events.at(-1)?.seq ?? 0) + 1, ts: new Date().toISOString(), kind, text: clip(redact(text), 2000), ...extra };
    this.run.events.push(e);
    if (this.run.events.length > MAX_EVENTS) this.run.events.splice(0, this.run.events.length - MAX_EVENTS);
    this.send({ t: 'event', e });
    this.persist();
  }

  private nodeChanged(nodeId: string) {
    this.send({ t: 'node', node: this.run.nodes[nodeId] });
    this.persist();
  }

  private runChanged() {
    const all = Object.values(this.run.nodes).flatMap((n) => n.attempts.map((a) => a.usage));
    const s = sumTotals(all);
    const { unknownCost, ...totals } = s;
    this.run.totals = totals;
    const note = 'Alcune fasi si sono interrotte senza un risultato finale: il loro costo non è noto e non è incluso nel totale.';
    if (unknownCost && !this.run.notes.includes(note)) this.run.notes.push(note);
    this.send({ t: 'run', run: { status: this.run.status, totals: this.run.totals, notes: this.run.notes, rateLimit: this.run.rateLimit, endedAt: this.run.endedAt } });
    this.persist();
  }

  private node(id: string): WorkflowNode {
    return this.wf.nodes.find((n) => n.id === id)!;
  }

  private preds(id: string) {
    return this.wf.edges.filter((e) => e.target === id).map((e) => e.source);
  }

  start() {
    this.event('run', `Esecuzione avviata in modalità ${this.run.mode === 'prova' ? 'di prova (nessuna chiamata a pagamento)' : 'reale'}.`);
    if (this.run.continuedFrom) {
      const reused = Object.values(this.run.nodes).filter((n) => n.status === 'riusata');
      this.event('run', `Continua dall'esecuzione ${this.run.continuedFrom}: ${reused.length} fasi riprese senza chiamate (${reused.map((n) => this.node(n.nodeId).data.label).join(', ') || 'nessuna'}).`);
    }
    if (this.run.budgetUsd) this.event('limite', `Limite di spesa stimata per l'esecuzione: ${this.run.budgetUsd.toFixed(2)} USD.`);
    const r = this.run.rules;
    if (r?.applied) {
      const src = [r.global ? `regole personali (${r.globalPath})` : null, r.regia ? 'regole di Regia' : null].filter(Boolean).join(' e ');
      this.event('run', src ? `Regole generali applicate a ogni fase: ${src}.` : 'Regole generali attive, ma nessun testo di regole trovato.');
    } else {
      this.event('run', 'Regole generali non applicate (disattivate nelle impostazioni del workflow).');
    }
    if (r?.projectPath) this.event('run', `CLAUDE.md del progetto caricato dalla CLI: ${r.projectPath}.`);
    this.persist(true);
    this.schedule();
  }

  private spent() {
    return this.run.totals.costUsd ?? 0;
  }

  private schedule() {
    if (['annullata', 'completata', 'fallita', 'interrotta'].includes(this.run.status)) return;
    const states = this.run.nodes;
    for (const n of this.wf.nodes) {
      const st = states[n.id];
      if (st.status !== 'in_attesa' || this.reworking.has(n.id)) continue;
      if (!this.preds(n.id).every((p) => DONE.has(states[p].status))) continue;
      if (n.data.kind === 'approvazione') {
        this.requestApproval(n);
        continue;
      }
      if (this.running.size >= this.wf.settings.maxParallel) break;
      const reason = this.afterCorrection.delete(n.id) ? 'dopo_correzione' : st.attempts.length ? 'riprova' : 'iniziale';
      void this.startNode(n, reason);
    }
    this.updateRunStatus();
  }

  private updateRunStatus() {
    const states = Object.values(this.run.nodes);
    if (['annullata', 'interrotta'].includes(this.run.status)) return;
    let next = this.run.status;
    if (states.every((s) => DONE.has(s.status))) next = 'completata';
    else if (this.running.size > 0) next = 'in_corso';
    else if (states.some((s) => s.pendingActions?.length)) next = 'attesa_intervento';
    else if (states.some((s) => s.status === 'in_attesa')) next = 'in_corso';
    if (next !== this.run.status) {
      this.run.status = next;
      if (next === 'completata') {
        this.stopAllServices('esecuzione completata');
        this.run.endedAt = new Date().toISOString();
        this.event('run', 'Esecuzione completata.');
        active.delete(this.run.id);
      } else if (next === 'attesa_intervento') {
        this.event('intervento', 'L\'esecuzione è in pausa: serve un tuo intervento.');
      }
    }
    this.runChanged();
    if (next === 'completata') this.persist(true);
  }

  private upstreamContext(n: WorkflowNode): string {
    const mode = n.data.contextMode;
    if (mode === 'nessuno') return '';
    const parts: string[] = [];
    for (const p of this.preds(n.id)) {
      const st = this.run.nodes[p];
      const pn = this.node(p);
      if (st.status === 'saltata') { parts.push(`## ${pn.data.label}\n(fase saltata)`); continue; }
      const last = st.attempts.at(-1);
      const body = mode === 'completo' ? clip(last?.resultText ?? st.output ?? '', 12000) : st.output ?? '';
      parts.push(`## ${pn.data.label}\n${body}`);
    }
    return parts.length ? `# Risultati delle fasi precedenti\n${parts.join('\n\n')}` : '';
  }

  private buildPrompt(n: WorkflowNode): string {
    const ctx = this.upstreamContext(n);
    return [
      this.wf.settings.goal ? `# Obiettivo del workflow\n${this.wf.settings.goal}` : '',
      `# Il tuo compito: ${n.data.label}\n${n.data.instructions}`,
      ctx,
      PROTOCOL,
    ].filter(Boolean).join('\n\n');
  }

  private reuseKey(n: WorkflowNode, prompt: string) {
    const d = n.data;
    const h = createHash('sha256');
    h.update(JSON.stringify([this.run.mode, d.role, d.model, d.allowedTools, d.maxTurns, prompt, this.wf.settings.projectDir, this.wf.settings.loadProjectSettings]));
    h.update(projectFingerprint(this.wf.settings.projectDir));
    return h.digest('hex');
  }

  private newAttempt(nodeId: string, reason: Attempt['reason']): Attempt {
    const st = this.run.nodes[nodeId];
    const a: Attempt = {
      id: `${nodeId}#${st.attempts.length + 1}`, nodeId, index: st.attempts.length, reason, startedAt: new Date().toISOString(), status: 'attiva',
      models: [], usage: emptyTotals(), usageSource: 'nessuno',
      live: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, steps: 0, duplicatesSkipped: 0, subagentMessages: 0 },
      toolCalls: [], subagents: 0,
    };
    st.attempts.push(a);
    return a;
  }

  private async runAgent(n: WorkflowNode, reason: Attempt['reason'], resume?: { sessionId: string; feedback: string }) {
    const st = this.run.nodes[n.id];
    const d = n.data;
    // Limite di spesa dell'esecuzione: la parte rimanente è divisa tra le fasi attive.
    let nodeBudget = d.maxBudgetUsd;
    if (this.run.budgetUsd !== undefined) {
      const remaining = this.run.budgetUsd - this.spent();
      if (remaining <= 0) {
        st.status = 'fallita';
        st.pendingReason = 'Limite di spesa dell\'esecuzione raggiunto prima di avviare la fase.';
        st.pendingActions = ['salta', 'annulla'];
        this.event('limite', `${d.label}: non avviata, limite di spesa dell'esecuzione raggiunto.`, { nodeId: n.id });
        this.nodeChanged(n.id);
        this.updateRunStatus();
        return;
      }
      const share = remaining / (this.running.size + 1);
      nodeBudget = nodeBudget === undefined ? share : Math.min(nodeBudget, share);
    }

    const prompt = resume
      ? `Feedback della persona che supervisiona il workflow:\n${resume.feedback}\n\nTieni conto di questo feedback e completa di nuovo il compito "${d.label}".\n\n${PROTOCOL}`
      : this.buildPrompt(n);

    let key: string | undefined;
    if (d.reuseResult && !resume) {
      key = this.reuseKey(n, prompt);
      const hit = readReuseCache()[key];
      if (hit) {
        const a = this.newAttempt(n.id, 'riuso');
        a.status = 'ok';
        a.endedAt = a.startedAt;
        a.usageSource = 'riusato';
        a.reusedFrom = { runId: hit.runId, attemptId: hit.attemptId };
        a.resultText = hit.resultText;
        a.declared = hit.declared as DeclaredOutcome | undefined;
        st.output = hit.output;
        st.status = 'riusata';
        st.activity = undefined;
        this.event('fase', `${d.label}: risultato riusato dall'esecuzione ${hit.runId} (configurazione, input e file del progetto invariati). Nessuna chiamata effettuata.`, { nodeId: n.id, attemptId: a.id });
        this.nodeChanged(n.id);
        this.runChanged();
        this.schedule();
        return;
      }
    }

    const a = this.newAttempt(n.id, reason);
    if (resume) a.resumedSessionId = resume.sessionId;
    st.status = 'attiva';
    st.pendingActions = undefined;
    st.pendingReason = undefined;
    st.activity = 'Avvio…';
    this.running.add(n.id);
    const ctrl = new AbortController();
    this.controllers.set(n.id, ctrl);
    const baseline = resume ? this.sessions.get(resume.sessionId) : undefined;
    const acc = new AttemptAccounting(a, baseline, this.run.mode === 'prova' ? 'simulato' : undefined);
    this.event('fase', `${d.label}: avviata${resume ? ' (ripresa della sessione con feedback)' : reason === 'riprova' ? ' (nuovo tentativo)' : ''}. Modello: ${d.model || 'predefinito'}; strumenti: ${d.allowedTools.join(', ') || 'nessuno'}${nodeBudget !== undefined ? `; limite ${nodeBudget.toFixed(3)} USD` : ''}.`, { nodeId: n.id, attemptId: a.id });
    this.nodeChanged(n.id);
    this.updateRunStatus();

    const stderrTail: string[] = [];
    const toolNames = new Map<string, string>();
    let gotResult = false;
    let lastLive = 0;
    try {
      const stream = this.run.mode === 'prova'
        ? mockQuery({ phase: d, attemptIndex: a.index, resume: resume?.sessionId, maxBudgetUsd: nodeBudget, signal: ctrl.signal })
        : query({
          prompt,
          options: {
            cwd: this.wf.settings.projectDir,
            model: d.model || undefined,
            tools: d.allowedTools,
            allowedTools: d.allowedTools,
            permissionMode: 'dontAsk',
            systemPrompt: { type: 'preset', preset: 'claude_code', append: `${d.role ? `\nRuolo in questo workflow: ${d.role}` : ''}${rulesPrompt(this.run.rules)}` || undefined },
            maxTurns: d.maxTurns,
            maxBudgetUsd: nodeBudget,
            abortController: ctrl,
            resume: resume?.sessionId,
            settingSources: this.wf.settings.loadProjectSettings ? ['project'] : [],
            stderr: (s: string) => { stderrTail.push(redact(s)); if (stderrTail.length > 20) stderrTail.shift(); },
          },
        });

      for await (const raw of stream as AsyncIterable<Record<string, any>>) {
        const msg = raw;
        if (msg.type === 'system' && msg.subtype === 'init') {
          a.sessionId = msg.session_id;
          a.apiKeySource = msg.apiKeySource;
          if (msg.model && !a.models.includes(msg.model)) a.models.push(msg.model);
          this.event('fase', `${d.label}: sessione pronta (modello ${msg.model}).`, { nodeId: n.id, attemptId: a.id });
        } else if (msg.type === 'assistant') {
          acc.onAssistant(msg);
          const sub = Boolean(msg.parent_tool_use_id);
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'text' && block.text?.trim()) {
              const text: string = block.text;
              for (const line of text.split('\n')) {
                const m = line.match(/^\s*\**DECISIONE\**\s*:\s*(.+)$/i);
                if (m) this.decision(n.id, a.id, m[1].trim(), 'dichiarata', sub);
              }
              const visible = text.replace(/```regia[\s\S]*?```/g, '').trim();
              if (visible) this.event('testo', visible, { nodeId: n.id, attemptId: a.id, subagent: sub });
            } else if (block.type === 'tool_use') {
              toolNames.set(block.id, block.name);
              const summary = summarizeTool(block.name, block.input ?? {});
              a.toolCalls.push({ name: block.name, key: createHash('sha1').update(block.name + JSON.stringify(block.input ?? {})).digest('hex').slice(0, 12) });
              st.activity = `${sub ? 'Subagente · ' : ''}${summary}`;
              this.event('strumento', summary, { nodeId: n.id, attemptId: a.id, subagent: sub });
              const obs = observedDecision(block.name, block.input ?? {});
              if (obs && !sub) this.decision(n.id, a.id, obs, 'osservata', sub);
            }
            // I blocchi "thinking" non vengono mai mostrati: il ragionamento interno non è esposto.
          }
          const now = Date.now();
          if (now - lastLive > 300) { lastLive = now; this.nodeChanged(n.id); }
        } else if (msg.type === 'user') {
          for (const block of Array.isArray(msg.message?.content) ? msg.message.content : []) {
            if (block.type !== 'tool_result') continue;
            const name = toolNames.get(block.tool_use_id) ?? 'strumento';
            const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
            if (block.is_error) this.event('errore', `${name} ha restituito un errore: ${clip(content, 400)}`, { nodeId: n.id, attemptId: a.id, subagent: Boolean(msg.parent_tool_use_id) });
            else this.event('esito_strumento', `${name}: ${clip(content.trim(), 300) || '(nessun output)'}`, { nodeId: n.id, attemptId: a.id, subagent: Boolean(msg.parent_tool_use_id) });
          }
        } else if (msg.type === 'system' && msg.subtype === 'task_started') {
          a.subagents++;
          this.event('subagente', `Subagente avviato: ${msg.description ?? ''}`, { nodeId: n.id, attemptId: a.id, subagent: true });
          this.decision(n.id, a.id, `Ha delegato a un subagente: ${msg.description ?? ''}`, 'osservata', false);
        } else if (msg.type === 'system' && msg.subtype === 'task_notification') {
          const tok = msg.usage?.total_tokens ? ` (${msg.usage.total_tokens.toLocaleString('it-IT')} token riportati dal subagente, già inclusi nei totali della fase)` : '';
          this.event('subagente', `Subagente ${msg.status === 'completed' ? 'completato' : msg.status}: ${msg.summary ?? ''}${tok}`, { nodeId: n.id, attemptId: a.id, subagent: true });
        } else if (msg.type === 'rate_limit_event') {
          const r = msg.rate_limit_info ?? {};
          this.run.rateLimit = { status: r.status, type: r.rateLimitType, utilization: r.utilization, resetsAt: r.resetsAt };
          if (r.status !== 'allowed') this.event('limite', `Limite di utilizzo dell'abbonamento: ${r.status}${r.rateLimitType ? ` (${r.rateLimitType})` : ''}.`, { nodeId: n.id });
        } else if (msg.type === 'system' && msg.subtype === 'api_retry') {
          this.event('errore', `Nuovo tentativo di chiamata API in corso${msg.error ? `: ${msg.error}` : ''}.`, { nodeId: n.id, attemptId: a.id });
        } else if (msg.type === 'result') {
          gotResult = true;
          const snap = acc.onResult(msg);
          if (snap) a.sessionCumulative = snap;
          if (snap && a.sessionId) this.sessions.set(a.sessionId, snap);
          if (snap && msg.session_id) this.sessions.set(msg.session_id, snap);
          a.sessionId = a.sessionId ?? msg.session_id;
          if (typeof msg.result === 'string') a.resultText = redact(msg.result);
          a.declared = parseDeclared(msg.result);
          for (const den of msg.permission_denials ?? []) {
            this.decision(n.id, a.id, `Strumento negato dalla configurazione: ${den.tool_name}`, 'osservata', false);
          }
          if (msg.subtype !== 'success' || msg.is_error) {
            const why = msg.subtype === 'error_max_budget_usd' ? 'limite di spesa della fase raggiunto'
              : msg.subtype === 'error_max_turns' ? 'numero massimo di turni raggiunto'
              : (msg.errors?.join('; ') || msg.result || msg.subtype);
            a.error = redact(String(why));
          }
          this.event('consumi', usageLine(a), { nodeId: n.id, attemptId: a.id });
        }
      }
      if (!gotResult) acc.applyPartial();
    } catch (err) {
      if (!gotResult) acc.applyPartial();
      const aborted = ctrl.signal.aborted;
      a.error = aborted ? 'Annullata' : redact(`${(err as Error).message}${stderrTail.length ? `\n${stderrTail.join('').slice(-800)}` : ''}`);
      if (aborted) a.status = 'annullata';
    } finally {
      this.running.delete(n.id);
      this.controllers.delete(n.id);
    }

    a.endedAt = new Date().toISOString();
    st.activity = undefined;
    if (a.status !== 'annullata') a.status = a.error ? 'errore' : 'ok';
    const declared = a.declared;
    if (a.status === 'annullata') {
      st.status = 'fallita';
      this.event('fase', `${d.label}: annullata.`, { nodeId: n.id, attemptId: a.id });
    } else if (a.status === 'errore') {
      st.status = 'fallita';
      st.pendingReason = a.error;
      st.pendingActions = a.sessionId ? ['riprova', 'riprendi', 'salta', 'annulla'] : ['riprova', 'salta', 'annulla'];
      this.event('errore', `${d.label}: fallita — ${a.error}`, { nodeId: n.id, attemptId: a.id });
    } else if (declared?.esito === 'bloccato') {
      st.status = 'bloccata';
      st.pendingReason = declared.sintesi;
      st.pendingActions = ['riprendi', 'riprova', 'salta', 'annulla'];
      this.event('intervento', `${d.label}: l'agente dichiara di essere bloccato — ${declared.sintesi}`, { nodeId: n.id, attemptId: a.id });
    } else if (declared?.esito === 'ko') {
      st.status = 'fallita';
      st.pendingReason = `Esito negativo dichiarato: ${declared.sintesi}`;
      st.pendingActions = ['riprendi', 'riprova', 'salta', 'annulla'];
      this.event('errore', `${d.label}: esito negativo — ${declared.sintesi}`, { nodeId: n.id, attemptId: a.id });
    } else {
      st.status = 'completata';
      st.output = declared
        ? `${declared.sintesi}${declared.decisioni.length ? `\nDecisioni: ${declared.decisioni.map((x) => `- ${x}`).join('\n')}` : ''}`
        : clip(a.resultText ?? '', 3000);
      if (!declared) this.event('fase', `${d.label}: l'agente non ha restituito il blocco di esito previsto; uso il testo finale come risultato.`, { nodeId: n.id, attemptId: a.id });
      for (const dec of declared?.decisioni ?? []) this.decision(n.id, a.id, dec, 'dichiarata', false);
      this.event('risultato', `${d.label}: completata — ${declared?.sintesi ?? clip(a.resultText ?? '', 300)}`, { nodeId: n.id, attemptId: a.id });
      if (key) writeReuseEntry(key, { runId: this.run.id, attemptId: a.id, output: st.output, declared, resultText: a.resultText, savedAt: new Date().toISOString() });
    }
    this.nodeChanged(n.id);
    this.runChanged();
    this.schedule();
  }

  private decision(nodeId: string, attemptId: string, text: string, source: 'dichiarata' | 'osservata', subagent: boolean) {
    const t = clip(redact(text), 300);
    this.run.nodes[nodeId].lastDecision = t;
    this.event('decisione', t, { nodeId, attemptId, source, subagent });
  }

  private startNode(n: WorkflowNode, reason: Attempt['reason']) {
    return n.data.kind === 'server' ? this.runService(n, reason) : this.runAgent(n, reason);
  }

  /**
   * Fase "server": prepara l'ambiente (versione di Node richiesta dal progetto, dipendenze), avvia il comando
   * e lo tiene attivo fino alla fine dell'esecuzione. In caso di errore legge l'output, riconosce le cause comuni,
   * ritenta da solo quando può e altrimenti propone l'intervento adatto.
   */
  private async runService(n: WorkflowNode, reason: Attempt['reason']): Promise<void> {
    const st = this.run.nodes[n.id];
    const d = n.data;
    this.stopService(n.id, 'riavvio');
    const cwd = d.subdir?.trim() ? path.resolve(this.wf.settings.projectDir, d.subdir.trim()) : this.wf.settings.projectDir;
    const command = (d.command ?? '').trim();
    const timeoutSec = d.readyTimeoutSec ?? 90;
    const fix = this.serviceFixes.get(n.id) ?? {};
    this.serviceFixes.set(n.id, fix);
    const a = this.newAttempt(n.id, reason);
    a.usage.costUsd = 0;
    st.status = 'attiva';
    st.pendingActions = undefined;
    st.pendingReason = undefined;
    st.activity = 'Preparazione…';
    const svc: ServiceState = { command, cwd, url: d.url?.trim() || undefined, status: 'avvio', startedAt: new Date().toISOString(), log: [] };
    st.service = svc;
    this.running.add(n.id);
    const sim = this.run.mode === 'prova';
    const ev = (text: string, kind: EventKind = 'servizio') => this.event(kind, d.label + ': ' + text, { nodeId: n.id, attemptId: a.id });
    this.nodeChanged(n.id);
    this.updateRunStatus();

    const finish = (ok: boolean, failure?: string, actions?: HumanAction[]) => {
      this.running.delete(n.id);
      a.endedAt = new Date().toISOString();
      st.activity = undefined;
      if (this.run.status === 'annullata') { a.status = 'annullata'; this.nodeChanged(n.id); return; }
      if (ok) {
        a.status = 'ok';
        st.status = 'completata';
        st.output = 'Server locale attivo: ' + svc.url + '\nComando: ' + command + (svc.pid ? ' (PID ' + svc.pid + ')' : '') + (svc.node ? ', Node ' + svc.node : '') + (sim ? ' — simulato' : '');
        a.resultText = st.output;
        ev('server attivo su ' + svc.url + ". Resta attivo fino alla fine dell'esecuzione.");
      } else {
        a.status = 'errore';
        a.error = failure;
        st.status = 'fallita';
        st.pendingReason = failure + (svc.log.length ? '\n\nUltime righe:\n' + svc.log.slice(-8).join('\n') : '');
        st.pendingActions = actions ?? ['riprova', 'salta', 'annulla'];
        ev('avvio non riuscito — ' + failure, 'errore');
      }
      this.nodeChanged(n.id);
      this.runChanged();
      this.schedule();
    };

    // 1. Versione di Node richiesta dal progetto (.nvmrc / .node-version / engines, o quella dedotta da un errore precedente).
    const res = await resolveNode(cwd, d.nodeVersion?.trim() || fix.range);
    if (res.ok) {
      svc.node = res.version;
      if (res.note) ev(res.note);
    } else if (sim) {
      ev('in un\'esecuzione reale servirebbe un intervento: ' + res.message);
    } else {
      fix.install = res.install;
      return finish(false, res.message, res.install ? ['installa_node', 'riprova', 'salta', 'annulla'] : ['riprova', 'salta', 'annulla']);
    }
    const env = envWithNode(res.ok ? res.dir : undefined);

    if (sim) {
      st.activity = 'Avvio: ' + command;
      ev('avvio di "' + command + '" in ' + cwd + ' (simulato: nessun comando eseguito).');
      await new Promise((r) => setTimeout(r, Number(process.env.REGIA_MOCK_SPEED ?? 600)));
      svc.url = svc.url ?? 'http://localhost:5173/';
      for (const l of ['> ' + command, 'Server di sviluppo pronto (simulato).', '  Local:   ' + svc.url]) pushLog(svc.log, l);
      svc.status = 'simulato';
      return finish(true);
    }

    // 2. Dipendenze mancanti: installazione automatica senza modificare il lockfile.
    const deps = depsPlan(cwd);
    if (deps && needsDeps(cwd)) {
      st.activity = 'Installazione dipendenze: ' + deps.display;
      ev('node_modules non presente: eseguo "' + deps.display + '".');
      this.nodeChanged(n.id);
      let shown = 0;
      const code = await runOnce(deps.command, null, cwd, env, (l) => { pushLog(svc.log, redact(l)); if (++shown <= 10) ev(redact(l)); });
      if (code !== 0) return finish(false, 'Installazione delle dipendenze non riuscita ("' + deps.display + '", codice ' + code + ').');
      ev('dipendenze installate.');
    }

    // 3. Avvio e attesa dell'indirizzo.
    st.activity = 'Avvio: ' + command;
    ev('avvio di "' + command + '" in ' + cwd + (svc.node ? ' con Node ' + svc.node : '') + '.');
    this.nodeChanged(n.id);
    const ctrl = new AbortController();
    this.controllers.set(n.id, ctrl);
    let lines = 0;
    let lastPush = 0;
    let urlResolve: (u: string) => void = () => undefined;
    const urlFromOutput = new Promise<string>((r) => { urlResolve = r; });
    const h = startService(command, cwd, {
      onLine: (line) => {
        pushLog(svc.log, line);
        if (++lines <= 25) this.event('servizio', line, { nodeId: n.id, attemptId: a.id });
        const now = Date.now();
        if (now - lastPush > 500) { lastPush = now; this.nodeChanged(n.id); }
      },
      onUrl: (u) => urlResolve(u),
      onExit: (code) => {
        svc.exitCode = code;
        if (this.services.get(n.id) === h) this.services.delete(n.id);
        if (svc.status === 'attivo') {
          svc.status = 'terminato';
          this.event('errore', d.label + ': il server si è chiuso (codice ' + (code ?? '?') + ').', { nodeId: n.id });
        } else if (svc.status === 'avvio') {
          svc.status = 'errore';
        }
        this.nodeChanged(n.id);
        ctrl.abort();
      },
    }, env);
    this.services.set(n.id, h);
    svc.pid = h.pid;
    const deadline = Date.now() + timeoutSec * 1000;
    let url = svc.url;
    if (!url) {
      url = await Promise.race([
        urlFromOutput,
        new Promise<undefined>((r) => setTimeout(() => r(undefined), timeoutSec * 1000)),
        new Promise<undefined>((r) => ctrl.signal.addEventListener('abort', () => r(undefined), { once: true })),
      ]);
    }
    let ok = false;
    if (url && !ctrl.signal.aborted) {
      svc.url = url;
      ok = await waitForUrl(url, Math.max(1000, deadline - Date.now()), () => !h.exited, ctrl.signal);
    }
    this.controllers.delete(n.id);
    if (ok) {
      svc.status = 'attivo';
      fix.autoRetried = false;
      return finish(true);
    }
    const exited = h.exited;
    this.stopService(n.id, 'avvio non riuscito');
    svc.status = 'errore';
    if (this.run.status === 'annullata') return finish(false, 'esecuzione annullata');

    // 4. Diagnosi dall'output: correzione automatica se possibile, altrimenti l'intervento adatto.
    const diag = diagnose(svc.log);
    const base = exited
      ? "il comando è terminato durante l'avvio (codice " + (svc.exitCode ?? '?') + ')'
      : url ? url + ' non risponde entro ' + timeoutSec + ' secondi'
        : "nessun indirizzo locale trovato nell'output entro " + timeoutSec + ' secondi (indicalo nel campo URL della fase)';
    if (diag?.kind === 'node') {
      const range = diag.requiredRange ?? fix.range;
      const res2 = range ? await resolveNode(cwd, range) : null;
      if (res2?.ok && res2.version !== svc.node && !fix.autoRetried) {
        fix.range = range;
        fix.autoRetried = true;
        ev(diag.message + ' Riprovo automaticamente con Node ' + res2.version + ' (' + res2.manager + ').');
        this.running.delete(n.id);
        a.status = 'errore';
        a.error = base;
        a.endedAt = new Date().toISOString();
        return this.runService(n, 'riprova');
      }
      if (res2 && !res2.ok) {
        fix.range = range;
        fix.install = res2.install;
        return finish(false, diag.message + ' ' + res2.message, res2.install ? ['installa_node', 'riprova', 'salta', 'annulla'] : undefined);
      }
      return finish(false, diag.message + ' Indica la versione nel campo "Versione di Node" della fase e riprova.');
    }
    if (diag?.kind === 'dipendenze' && deps) {
      return finish(false, diag.message + ' Si possono reinstallare con "' + deps.display + '".', ['installa_dipendenze', 'riprova', 'salta', 'annulla']);
    }
    return finish(false, diag ? base + '. ' + diag.message : base);
  }

  /** Installa la versione di Node mancante o le dipendenze, su richiesta esplicita, poi riavvia la fase. */
  private async repairService(n: WorkflowNode, what: 'installa_node' | 'installa_dipendenze') {
    const st = this.run.nodes[n.id];
    const d = n.data;
    const fix = this.serviceFixes.get(n.id) ?? {};
    const cwd = d.subdir?.trim() ? path.resolve(this.wf.settings.projectDir, d.subdir.trim()) : this.wf.settings.projectDir;
    const svc = st.service ?? { command: d.command ?? '', cwd, status: 'avvio' as const, startedAt: new Date().toISOString(), log: [] };
    st.service = svc;
    st.status = 'attiva';
    this.running.add(n.id);
    let code: number | null;
    let label: string;
    let shown = 0;
    const onLine = (l: string) => { pushLog(svc.log, redact(l)); if (++shown <= 15) this.event('servizio', redact(l), { nodeId: n.id }); };
    if (what === 'installa_node') {
      const plan = fix.install;
      if (!plan) { this.running.delete(n.id); throw new Error('Nessuna installazione di Node disponibile'); }
      label = plan.display;
      st.activity = 'Installazione: ' + label;
      this.event('servizio', d.label + ': eseguo "' + label + '" (scarica Node ' + plan.version + '; la versione di sistema non cambia).', { nodeId: n.id });
      this.nodeChanged(n.id);
      code = await runOnce(plan.command, plan.args, cwd, process.env, onLine);
      if (code === 0) fix.range = fix.range ?? plan.version;
    } else {
      const deps = depsPlan(cwd);
      if (!deps) { this.running.delete(n.id); throw new Error('Nessun package.json nella cartella'); }
      const res = await resolveNode(cwd, d.nodeVersion?.trim() || fix.range);
      label = deps.display;
      st.activity = 'Installazione dipendenze: ' + label;
      this.event('servizio', d.label + ': eseguo "' + label + '".', { nodeId: n.id });
      this.nodeChanged(n.id);
      code = await runOnce(deps.command, null, cwd, envWithNode(res.ok ? res.dir : undefined), onLine);
    }
    this.running.delete(n.id);
    if (code !== 0) {
      st.status = 'fallita';
      st.activity = undefined;
      st.pendingReason = '"' + label + '" non è riuscito (codice ' + code + ').\n\nUltime righe:\n' + svc.log.slice(-8).join('\n');
      st.pendingActions = ['riprova', 'salta', 'annulla'];
      this.event('errore', d.label + ': "' + label + '" non riuscito.', { nodeId: n.id });
      this.nodeChanged(n.id);
      this.updateRunStatus();
      return;
    }
    this.event('servizio', d.label + ': "' + label + '" completato. Riavvio il server.', { nodeId: n.id });
    fix.autoRetried = false;
    await this.runService(n, 'riprova');
  }

  private stopService(nodeId: string, why: string) {
    const h = this.services.get(nodeId);
    const svc = this.run.nodes[nodeId]?.service;
    if (h) {
      this.services.delete(nodeId);
      if (svc && svc.status !== 'errore') svc.status = 'fermato';
      h.stop();
      this.event('servizio', this.node(nodeId).data.label + ': server fermato (' + why + ').', { nodeId });
      this.nodeChanged(nodeId);
    } else if (svc?.status === 'simulato') {
      svc.status = 'fermato';
      this.nodeChanged(nodeId);
    }
  }

  private stopAllServices(why: string) {
    for (const id of Object.keys(this.run.nodes)) this.stopService(id, why);
  }

  /** Azioni manuali sul server di una fase: ferma o riavvia, senza cambiare lo stato delle altre fasi. */
  async serviceAction(nodeId: string, action: 'ferma' | 'riavvia') {
    const n = this.node(nodeId);
    if (!n || n.data.kind !== 'server') throw new Error('La fase non è un server locale');
    if (action === 'ferma') return this.stopService(nodeId, 'richiesta manuale');
    if (this.running.has(nodeId)) throw new Error('Il server si sta già avviando');
    await this.runService(n, 'riprova');
  }

  private reworkTargets(approvalId: string): string[] {
    const canWrite = (id: string) => this.node(id).data.allowedTools.some((t) => ['Edit', 'Write', 'NotebookEdit'].includes(t));
    // Risale il grafo (anche attraverso approvazioni precedenti) fino alla fase più vicina che può modificare file.
    let frontier = this.preds(approvalId);
    const seen = new Set<string>();
    while (frontier.length) {
      const writers = frontier.filter((f) => this.node(f).data.kind !== 'approvazione' && canWrite(f));
      if (writers.length) return writers;
      for (const f of frontier) seen.add(f);
      frontier = [...new Set(frontier.flatMap((f) => this.preds(f)))].filter((p) => !seen.has(p));
    }
    return this.preds(approvalId).filter((p) => this.node(p).data.kind !== 'approvazione');
  }

  /** Fasi che stanno su un percorso tra i target e l'approvazione (esclusi entrambi). */
  private nodesBetween(targets: string[], approvalId: string): string[] {
    const down = new Set<string>();
    const stack = [...targets];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const e of this.wf.edges) if (e.source === cur && !down.has(e.target)) { down.add(e.target); stack.push(e.target); }
    }
    const up = new Set<string>();
    const st2 = [approvalId];
    while (st2.length) for (const p of this.preds(st2.pop()!)) if (!up.has(p)) { up.add(p); st2.push(p); }
    return [...down].filter((x) => up.has(x) && x !== approvalId && !targets.includes(x));
  }

  private requestApproval(n: WorkflowNode) {
    const st = this.run.nodes[n.id];
    st.status = 'attesa_intervento';
    st.pendingActions = ['approva', 'respingi', 'annulla'];
    st.pendingReason = n.data.instructions;
    this.event('intervento', `${n.data.label}: in attesa della tua approvazione.`, { nodeId: n.id });
    this.nodeChanged(n.id);
  }

  async human(nodeId: string, action: HumanAction, feedback = '') {
    const st = this.run.nodes[nodeId];
    const n = this.node(nodeId);
    if (!st || !n) throw new Error('Fase inesistente');
    if (action === 'annulla') return this.cancel();
    if (!st.pendingActions?.includes(action)) throw new Error(`Azione "${action}" non disponibile per questa fase`);
    const fb = redact(feedback.trim());
    this.event('intervento', `Intervento su ${n.data.label}: ${action}${fb ? ` — "${clip(fb, 300)}"` : ''}`, { nodeId });
    st.pendingActions = undefined;
    st.pendingReason = undefined;

    if (n.data.kind === 'approvazione') {
      if (action === 'approva') {
        st.status = 'completata';
        st.output = `Approvato dalla persona${fb ? `: ${fb}` : '.'}`;
        this.nodeChanged(nodeId);
        this.schedule();
        return;
      }
      if (action === 'respingi') {
        if (!fb) { st.pendingActions = ['approva', 'respingi', 'annulla']; throw new Error('Per respingere serve un commento con le correzioni richieste'); }
        st.feedbackRounds++;
        if (st.feedbackRounds > MAX_FEEDBACK_ROUNDS) {
          st.status = 'fallita';
          st.pendingActions = ['approva', 'annulla'];
          st.pendingReason = `Raggiunto il numero massimo di ${MAX_FEEDBACK_ROUNDS} cicli di correzione.`;
          this.nodeChanged(nodeId);
          this.updateRunStatus();
          return;
        }
        // Il feedback va alla fase che ha prodotto il lavoro: la più vicina a monte che può modificare file
        // (altrimenti le fasi immediatamente precedenti). Le fasi intermedie (test, revisione) vengono rieseguite.
        const targets = this.reworkTargets(nodeId);
        const between = this.nodesBetween(targets, nodeId);
        st.status = 'in_attesa';
        st.activity = `Correzione in corso: ${targets.map((t) => this.node(t).data.label).join(', ')}`;
        this.reworking.add(nodeId);
        for (const b of between) {
          const bs = this.run.nodes[b];
          bs.status = 'in_attesa';
          bs.output = undefined;
          this.afterCorrection.add(b);
          this.nodeChanged(b);
        }
        this.nodeChanged(nodeId);
        for (const t of targets) {
          const sess = [...this.run.nodes[t].attempts].reverse().find((x) => x.sessionId)?.sessionId;
          this.run.nodes[t].status = 'in_attesa';
          if (sess) await this.runAgent(this.node(t), 'ripresa_con_feedback', { sessionId: sess, feedback: fb });
          else await this.startNode(this.node(t), 'riprova');
          if ((this.run.nodes[t].status as string) !== 'completata') break;
        }
        st.activity = undefined;
        this.reworking.delete(nodeId);
        this.nodeChanged(nodeId);
        this.schedule();
        return;
      }
    }

    if (action === 'installa_node' || action === 'installa_dipendenze') {
      if (n.data.kind !== 'server') throw new Error('Azione disponibile solo per il server locale');
      void this.repairService(n, action);
      return;
    }

    if (action === 'salta') {
      st.status = 'saltata';
      st.output = '(fase saltata dalla persona)';
      this.nodeChanged(nodeId);
      this.schedule();
    } else if (action === 'riprova') {
      st.status = 'in_attesa';
      this.nodeChanged(nodeId);
      void this.startNode(n, 'riprova');
    } else if (action === 'riprendi') {
      const sess = [...st.attempts].reverse().find((x) => x.sessionId)?.sessionId;
      if (!sess) throw new Error('Nessuna sessione da riprendere');
      void this.runAgent(n, 'ripresa_con_feedback', { sessionId: sess, feedback: fb || 'Continua dal punto in cui ti eri fermato.' });
    }
  }

  cancel() {
    this.run.status = 'annullata';
    this.run.endedAt = new Date().toISOString();
    for (const c of this.controllers.values()) c.abort();
    this.stopAllServices('esecuzione annullata');
    for (const s of Object.values(this.run.nodes)) {
      s.pendingActions = undefined;
      if (s.status === 'in_attesa' || s.status === 'attesa_intervento') s.status = 'saltata';
    }
    this.event('run', 'Esecuzione annullata.');
    for (const id of Object.keys(this.run.nodes)) this.send({ t: 'node', node: this.run.nodes[id] });
    this.runChanged();
    active.delete(this.run.id);
    setTimeout(() => this.persist(true), 300);
  }
}

const PROTOCOL = `# Protocollo di risposta
- Quando prendi una decisione rilevante (cosa leggere, cosa modificare, come verificare), scrivi una riga che inizia con "DECISIONE:" seguita da una spiegazione breve, una sola frase.
- Lavora solo nella cartella del progetto e solo con gli strumenti che hai a disposizione.
- Termina SEMPRE la risposta con questo blocco, in JSON valido:
\`\`\`regia
{"esito": "ok" | "ko" | "bloccato", "sintesi": "risultato in 1-3 frasi, utile alla fase successiva", "decisioni": ["decisione principale e motivo", "..."]}
\`\`\`
Usa "ko" se il compito non è riuscito (es. test falliti), "bloccato" se non puoi procedere senza un intervento umano (spiega cosa serve nella sintesi).`;

export function parseDeclared(text: unknown): DeclaredOutcome | undefined {
  if (typeof text !== 'string') return undefined;
  const blocks = [...text.matchAll(/```regia\s*([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (!last) return undefined;
  try {
    const j = JSON.parse(last);
    const esito = ['ok', 'ko', 'bloccato'].includes(j.esito) ? j.esito : 'ok';
    return {
      esito,
      sintesi: redact(String(j.sintesi ?? '')).slice(0, 2000),
      decisioni: Array.isArray(j.decisioni) ? j.decisioni.slice(0, 10).map((x: unknown) => redact(String(x)).slice(0, 300)) : [],
    };
  } catch {
    return undefined;
  }
}

function summarizeTool(name: string, input: Record<string, any>): string {
  const rel = (p: unknown) => (typeof p === 'string' ? p.replace(/\\/g, '/').split('/').slice(-3).join('/') : '');
  switch (name) {
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': return `${name} ${rel(input.file_path ?? input.notebook_path)}`;
    case 'Bash': return `Bash: ${clip(String(input.command ?? ''), 160)}`;
    case 'Glob': return `Glob ${input.pattern ?? ''}`;
    case 'Grep': return `Grep "${clip(String(input.pattern ?? ''), 80)}"`;
    case 'Agent': case 'Task': return `Subagente: ${input.description ?? ''}`;
    case 'WebFetch': return `WebFetch ${input.url ?? ''}`;
    case 'WebSearch': return `WebSearch "${input.query ?? ''}"`;
    default: return name;
  }
}

function observedDecision(name: string, input: Record<string, any>): string | null {
  const f = typeof input.file_path === 'string' ? input.file_path.replace(/\\/g, '/').split('/').slice(-2).join('/') : '';
  if (name === 'Edit' || name === 'Write') return `Ha scelto di modificare ${f}`;
  if (name === 'Bash') return `Ha scelto di eseguire: ${clip(String(input.command ?? ''), 120)}`;
  return null;
}

function usageLine(a: Attempt) {
  const u = a.usage;
  const cost = u.costUsd === null ? 'costo non disponibile' : `${u.costUsd.toFixed(4)} USD stimati`;
  return `Consumi (${a.usageSource}): input ${u.inputTokens}, output ${u.outputTokens}, cache scritta ${u.cacheCreationInputTokens}, cache letta ${u.cacheReadInputTokens}; ${cost}; turni ${a.numTurns ?? '?'}; messaggi duplicati ignorati ${a.live.duplicatesSkipped}.`;
}

/** Impronta leggera dei file del progetto (percorso, dimensione, data di modifica). */
export function projectFingerprint(dir: string): string {
  const h = createHash('sha256');
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__']);
  let count = 0;
  const walk = (d: string) => {
    if (count > 5000) return;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    entries.sort((x, y) => x.name.localeCompare(y.name));
    for (const e of entries) {
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const s = fs.statSync(p);
        h.update(`${path.relative(dir, p)}|${s.size}|${s.mtimeMs}\n`);
        count++;
      }
    }
  };
  walk(dir);
  return h.digest('hex');
}
