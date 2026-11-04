import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Attempt, ContinuationPlan, ServiceState, DeclaredOutcome, EventKind, HumanAction, NodeRunState, ReadyCheck, Run, RunEvent, RunMode, Workflow, WorkflowNode,
} from '../shared/types.ts';
import { emptyTotals } from '../shared/types.ts';
import { msg, type Msg, type Params, type Translate } from '../shared/i18n.ts';
import { serverT } from './i18n.ts';
import { mockQuery } from './mockQuery.ts';
import { clip, redact } from './redact.ts';
import { buildSkillBundle, discoverSkills, phaseSkills, PLUGIN_NAME, removeSkillBundles, skillSources, type SkillBundle } from './skills.ts';
import { rulesPrompt, snapshotRules } from './rules.ts';
import { activePrinciples, principlesText } from '../shared/principles.ts';
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

/** Lingua delle istruzioni inviate agli agenti e dei testi di un'esecuzione (impostazione del workflow). */
export const workflowLang = (wf: Workflow) => wf.settings.language ?? 'it';

/** Errore con messaggio localizzabile: l'API lo restituisce come {error, msg}. */
export class RegiaError extends Error {
  constructor(public readonly msg: Msg, text: string) {
    super(text);
  }
}

const tx = (t: Translate, m: Msg) => t(m.key, m.params);

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
  const t = serverT(workflowLang(wf));
  for (const id of order) {
    const n = wf.nodes.find((x) => x.id === id)!;
    const old = from.snapshot.nodes.find((x) => x.id === id);
    const st = from.nodes[id];
    let reason: Msg | undefined;
    if (!old || !st) reason = msg('continuation.newPhase');
    else if (JSON.stringify(old.data) !== JSON.stringify(n.data)) reason = msg('continuation.configChanged');
    else if (predsOf(from.snapshot, id) !== predsOf(wf, id)) reason = msg('continuation.linksChanged');
    else if (n.data.kind === 'server') reason = msg('continuation.serverRestart');
    else if (st.status !== 'completata' && st.status !== 'riusata') reason = msg('continuation.notCompleted', { status: st.status.replace('_', ' ') });
    else if (!wf.edges.filter((e) => e.target === id).every((e) => reused.has(e.source))) reason = msg('continuation.upstreamRerun');
    if (reason) plan.toRun.push({ nodeId: id, label: n.data.label, reason: tx(t, reason), reasonMsg: reason });
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
  /** Lingua dell'esecuzione: istruzioni agli agenti e testi di riserva dei messaggi. */
  private lang: string;
  private t: Translate;

  constructor(public run: Run) {
    this.wf = run.snapshot;
    this.lang = workflowLang(run.snapshot);
    this.t = serverT(this.lang);
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

  /** Testo di un messaggio nella lingua dell'esecuzione. */
  private tx(m: Msg): string {
    return this.t(m.key, m.params);
  }

  /** Evento generato da Regia: messaggio localizzabile più il testo nella lingua dell'esecuzione. */
  private say(kind: EventKind, m: Msg, extra: Partial<RunEvent> = {}) {
    const params: Params | undefined = m.params
      ? Object.fromEntries(Object.entries(m.params).map(([k, v]) => [k, typeof v === 'string' ? redact(v) : v]))
      : undefined;
    const safe: Msg = { key: m.key, params };
    this.event(kind, this.tx(safe), { ...extra, msg: safe });
  }

  /** Motivo dell'intervento: messaggio localizzabile e testo di riserva. */
  private setPending(st: NodeRunState, m: Msg | undefined, text?: string) {
    st.pendingMsg = m;
    st.pendingReason = text ?? (m ? this.tx(m) : undefined);
  }

  /** Errore con messaggio localizzabile nella lingua dell'esecuzione. */
  private fail(m: Msg): RegiaError {
    return new RegiaError(m, this.tx(m));
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
    const note = this.t('notes.unknownCost');
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
    this.say('run', this.run.mode === 'prova' ? msg('events.runStarted.test') : msg('events.runStarted.real'));
    if (this.run.continuedFrom) {
      const reused = Object.values(this.run.nodes).filter((n) => n.status === 'riusata');
      const phases = reused.map((n) => this.node(n.nodeId).data.label).join(', ');
      this.say('run', phases
        ? msg('events.continued', { from: this.run.continuedFrom, count: reused.length, phases })
        : msg('events.continuedNone', { from: this.run.continuedFrom }));
    }
    if (this.run.budgetUsd) this.say('limite', msg('events.budget', { amount: this.run.budgetUsd.toFixed(2) }));
    const r = this.run.rules;
    if (r?.applied) {
      if (r.global && r.regia) this.say('run', msg('events.rules.both', { path: r.globalPath }));
      else if (r.global) this.say('run', msg('events.rules.global', { path: r.globalPath }));
      else if (r.regia) this.say('run', msg('events.rules.regia'));
      else this.say('run', msg('events.rules.empty'));
    } else {
      this.say('run', msg('events.rules.off'));
    }
    if (r?.projectPath) this.say('run', msg('events.rules.project', { path: r.projectPath }));
    const principles = activePrinciples(this.wf.settings.principles);
    if (principles.length) this.say('run', msg('events.principles', { list: principles.map((p) => p.toUpperCase()).join(', ') }));
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
        this.stopAllServices('completed');
        this.run.endedAt = new Date().toISOString();
        this.say('run', msg('events.runCompleted'));
        active.delete(this.run.id);
      } else if (next === 'attesa_intervento') {
        this.say('intervento', msg('events.runPaused'));
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
      if (st.status === 'saltata') { parts.push(`## ${pn.data.label}\n${this.t('agent.skippedPhase')}`); continue; }
      const last = st.attempts.at(-1);
      const body = mode === 'completo' ? clip(last?.resultText ?? st.output ?? '', 12000) : st.output ?? '';
      parts.push(`## ${pn.data.label}\n${body}`);
    }
    return parts.length ? this.t('agent.previousResults', { results: parts.join('\n\n') }) : '';
  }

  private buildPrompt(n: WorkflowNode): string {
    const ctx = this.upstreamContext(n);
    return [
      this.wf.settings.goal ? this.t('agent.goal', { goal: this.wf.settings.goal }) : '',
      this.t('agent.task', { label: n.data.label, instructions: n.data.instructions }),
      ctx,
      agentProtocol(this.lang),
    ].filter(Boolean).join('\n\n');
  }

  /** Testo aggiunto al prompt di sistema della fase: ruolo, principi di progettazione e regole generali. */
  private systemAppend(d: WorkflowNode['data']): string {
    const principles = principlesText(this.wf.settings.principles, d.kind, this.t);
    return `${d.role ? `\n${this.t('agent.role', { role: d.role })}` : ''}${principles ? `\n\n${principles}` : ''}${rulesPrompt(this.run.rules, this.lang)}`;
  }

  private reuseKey(n: WorkflowNode, prompt: string) {
    const d = n.data;
    const h = createHash('sha256');
    h.update(JSON.stringify([this.run.mode, d.role, d.model, d.allowedTools, d.maxTurns, prompt, this.wf.settings.projectDir, this.wf.settings.loadProjectSettings, d.skills ?? null, this.wf.settings.skillSources ?? null]));
    // I principi cambiano il prompt di sistema: entrano nella chiave solo se attivi, così i risultati già in cache restano validi.
    const principles = activePrinciples(this.wf.settings.principles);
    if (principles.length) h.update(JSON.stringify(principles));
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
        this.setPending(st, msg('interventions.budgetReached'));
        st.pendingActions = ['salta', 'annulla'];
        this.say('limite', msg('events.notStartedBudget', { label: d.label }), { nodeId: n.id });
        this.nodeChanged(n.id);
        this.updateRunStatus();
        return;
      }
      const share = remaining / (this.running.size + 1);
      nodeBudget = nodeBudget === undefined ? share : Math.min(nodeBudget, share);
    }

    const prompt = resume
      ? this.t('agent.feedback', { feedback: resume.feedback, label: d.label, protocol: agentProtocol(this.lang) })
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
        this.say('fase', msg('events.reused', { label: d.label, run: hit.runId }), { nodeId: n.id, attemptId: a.id });
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
    this.setPending(st, undefined);
    st.activity = this.t('events.activity.starting');
    this.running.add(n.id);
    const ctrl = new AbortController();
    this.controllers.set(n.id, ctrl);
    const baseline = resume ? this.sessions.get(resume.sessionId) : undefined;
    const acc = new AttemptAccounting(a, baseline, this.run.mode === 'prova' ? 'simulato' : undefined);
    const startParams = {
      label: d.label, model: d.model || this.t('events.defaultModel'), tools: d.allowedTools.join(', ') || this.t('events.noTools'),
      limit: nodeBudget !== undefined ? nodeBudget.toFixed(3) : undefined,
    };
    const how = resume ? 'resumed' : reason === 'riprova' ? 'retry' : 'initial';
    this.say('fase', msg(`events.phaseStarted.${how}${nodeBudget !== undefined ? 'Limit' : ''}`, startParams), { nodeId: n.id, attemptId: a.id });
    this.nodeChanged(n.id);
    this.updateRunStatus();

    // Skill: solo quelle scelte per la fase, in un plugin preparato per questo tentativo.
    const found = phaseSkills(d, discoverSkills(this.wf.settings.projectDir, skillSources(this.wf.settings)));
    if (found.missing.length) this.say('errore', msg('events.skillsMissing', { label: d.label, skills: found.missing.map(skillLabel).join(', ') }), { nodeId: n.id, attemptId: a.id });
    let bundle: SkillBundle | undefined;
    if (found.selected.length) {
      try {
        bundle = buildSkillBundle(`${this.run.id}_${a.id}`, found.selected);
        this.say('fase', msg('events.skillsAvailable', { label: d.label, skills: found.selected.map((s) => s.name).join(', '), count: found.selected.length }), { nodeId: n.id, attemptId: a.id });
      } catch (err) {
        this.say('errore', msg('events.skillsBundleFailed', { label: d.label, error: redact((err as Error).message) }), { nodeId: n.id, attemptId: a.id });
      }
    }
    const tools = bundle && !d.allowedTools.includes('Skill') ? [...d.allowedTools, 'Skill'] : d.allowedTools;

    const stderrTail: string[] = [];
    const toolNames = new Map<string, string>();
    let gotResult = false;
    let lastLive = 0;
    /** Messaggio localizzabile dell'errore, quando la causa è riconosciuta da Regia. */
    let errorMsg: Msg | undefined;
    try {
      const stream = this.run.mode === 'prova'
        ? mockQuery({ phase: d, attemptIndex: a.index, resume: resume?.sessionId, maxBudgetUsd: nodeBudget, signal: ctrl.signal, lang: this.lang, skills: bundle ? Object.values(bundle.byId) : [] })
        : query({
          prompt,
          options: {
            cwd: this.wf.settings.projectDir,
            model: d.model || undefined,
            tools,
            allowedTools: tools,
            ...(bundle ? { plugins: [{ type: 'local' as const, path: bundle.path }], skills: bundle.names } : {}),
            permissionMode: 'dontAsk',
            systemPrompt: { type: 'preset', preset: 'claude_code', append: this.systemAppend(d) || undefined },
            maxTurns: d.maxTurns,
            maxBudgetUsd: nodeBudget,
            abortController: ctrl,
            resume: resume?.sessionId,
            settingSources: this.wf.settings.loadProjectSettings ? ['project'] : [],
            stderr: (s: string) => { stderrTail.push(redact(s)); if (stderrTail.length > 20) stderrTail.shift(); },
          },
        });

      for await (const raw of stream as AsyncIterable<Record<string, any>>) {
        const sm = raw;
        if (sm.type === 'system' && sm.subtype === 'init') {
          a.sessionId = sm.session_id;
          a.apiKeySource = sm.apiKeySource;
          if (sm.model && !a.models.includes(sm.model)) a.models.push(sm.model);
          this.say('fase', msg('events.sessionReady', { label: d.label, model: sm.model }), { nodeId: n.id, attemptId: a.id });
        } else if (sm.type === 'assistant') {
          acc.onAssistant(sm);
          const sub = Boolean(sm.parent_tool_use_id);
          for (const block of sm.message?.content ?? []) {
            if (block.type === 'text' && block.text?.trim()) {
              const text: string = block.text;
              for (const line of text.split('\n')) {
                const dec = parseDecisionLine(line);
                if (dec) this.decision(n.id, a.id, dec, 'dichiarata', sub);
              }
              const visible = text.replace(/```regia[\s\S]*?```/g, '').trim();
              if (visible) this.event('testo', visible, { nodeId: n.id, attemptId: a.id, subagent: sub });
            } else if (block.type === 'tool_use') {
              toolNames.set(block.id, block.name);
              const summary = summarizeTool(block.name, block.input ?? {}, this.t, this.wf.settings.projectDir);
              a.toolCalls.push({ name: block.name, key: createHash('sha1').update(block.name + JSON.stringify(block.input ?? {})).digest('hex').slice(0, 12) });
              st.activity = sub ? this.t('events.activity.subagent', { summary }) : summary;
              this.event('strumento', summary, { nodeId: n.id, attemptId: a.id, subagent: sub });
              const obs = observedDecision(block.name, block.input ?? {});
              if (obs && !sub) this.decision(n.id, a.id, obs, 'osservata', sub);
            }
            // I blocchi "thinking" non vengono mai mostrati: il ragionamento interno non è esposto.
          }
          const now = Date.now();
          if (now - lastLive > 300) { lastLive = now; this.nodeChanged(n.id); }
        } else if (sm.type === 'user') {
          for (const block of Array.isArray(sm.message?.content) ? sm.message.content : []) {
            if (block.type !== 'tool_result') continue;
            const name = toolNames.get(block.tool_use_id) ?? this.t('events.toolFallbackName');
            const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
            const where = { nodeId: n.id, attemptId: a.id, subagent: Boolean(sm.parent_tool_use_id) };
            const out = clip(content.trim(), 300);
            // L'output degli strumenti resta testo; solo le cornici scritte da Regia sono localizzabili.
            if (block.is_error) this.say('errore', msg('events.toolError', { name, content: clip(content, 400) }), where);
            else if (out) this.event('esito_strumento', `${name}: ${out}`, where);
            else this.say('esito_strumento', msg('events.toolNoOutput', { name }), where);
          }
        } else if (sm.type === 'system' && sm.subtype === 'task_started') {
          a.subagents++;
          this.say('subagente', msg('events.subagentStarted', { description: sm.description ?? '' }), { nodeId: n.id, attemptId: a.id, subagent: true });
          this.decision(n.id, a.id, msg('events.decisions.delegated', { description: sm.description ?? '' }), 'osservata', false);
        } else if (sm.type === 'system' && sm.subtype === 'task_notification') {
          const tokens: number | undefined = sm.usage?.total_tokens || undefined;
          const status = sm.status === 'completed' ? 'completed' : 'other';
          const p = { status: sm.status, summary: sm.summary ?? '', count: tokens };
          this.say('subagente', msg(`events.subagentEnded.${status}${tokens ? 'Tokens' : ''}`, p), { nodeId: n.id, attemptId: a.id, subagent: true });
        } else if (sm.type === 'rate_limit_event') {
          const r = sm.rate_limit_info ?? {};
          this.run.rateLimit = { status: r.status, type: r.rateLimitType, utilization: r.utilization, resetsAt: r.resetsAt };
          if (r.status !== 'allowed') {
            this.say('limite', r.rateLimitType
              ? msg('events.rateLimitType', { status: r.status, type: r.rateLimitType })
              : msg('events.rateLimit', { status: r.status }), { nodeId: n.id });
          }
        } else if (sm.type === 'system' && sm.subtype === 'api_retry') {
          this.say('errore', sm.error ? msg('events.apiRetryError', { error: String(sm.error) }) : msg('events.apiRetry'), { nodeId: n.id, attemptId: a.id });
        } else if (sm.type === 'result') {
          gotResult = true;
          const snap = acc.onResult(sm);
          if (snap) a.sessionCumulative = snap;
          if (snap && a.sessionId) this.sessions.set(a.sessionId, snap);
          if (snap && sm.session_id) this.sessions.set(sm.session_id, snap);
          a.sessionId = a.sessionId ?? sm.session_id;
          if (typeof sm.result === 'string') a.resultText = redact(sm.result);
          a.declared = parseDeclared(sm.result);
          for (const den of sm.permission_denials ?? []) {
            this.decision(n.id, a.id, msg('events.decisions.denied', { tool: den.tool_name }), 'osservata', false);
          }
          if (sm.subtype !== 'success' || sm.is_error) {
            errorMsg = sm.subtype === 'error_max_budget_usd' ? msg('interventions.error.phaseBudget')
              : sm.subtype === 'error_max_turns' ? msg('interventions.error.maxTurns')
              : undefined;
            const why = errorMsg ? this.tx(errorMsg) : (sm.errors?.join('; ') || sm.result || sm.subtype);
            a.error = redact(String(why));
          }
          this.say('consumi', usageMsg(a), { nodeId: n.id, attemptId: a.id });
        }
      }
      if (!gotResult) acc.applyPartial();
    } catch (err) {
      if (!gotResult) acc.applyPartial();
      const aborted = ctrl.signal.aborted;
      errorMsg = aborted ? msg('interventions.error.cancelled') : undefined;
      a.error = aborted ? this.tx(errorMsg!) : redact(`${(err as Error).message}${stderrTail.length ? `\n${stderrTail.join('').slice(-800)}` : ''}`);
      if (aborted) a.status = 'annullata';
    } finally {
      this.running.delete(n.id);
      this.controllers.delete(n.id);
      if (bundle) removeSkillBundles(`${this.run.id}_${a.id}`);
    }

    a.endedAt = new Date().toISOString();
    st.activity = undefined;
    if (a.status !== 'annullata') a.status = a.error ? 'errore' : 'ok';
    const declared = a.declared;
    const where = { nodeId: n.id, attemptId: a.id };
    if (a.status === 'annullata') {
      st.status = 'fallita';
      this.say('fase', msg('events.phaseCancelled', { label: d.label }), where);
    } else if (a.status === 'errore') {
      st.status = 'fallita';
      this.setPending(st, errorMsg, a.error);
      st.pendingActions = a.sessionId ? ['riprova', 'riprendi', 'salta', 'annulla'] : ['riprova', 'salta', 'annulla'];
      this.say('errore', msg('events.phaseFailed', { label: d.label, error: a.error }), where);
    } else if (declared?.esito === 'bloccato') {
      st.status = 'bloccata';
      // La sintesi è testo dell'agente: nessun messaggio localizzabile.
      this.setPending(st, undefined, declared.sintesi);
      st.pendingActions = ['riprendi', 'riprova', 'salta', 'annulla'];
      this.say('intervento', msg('events.agentBlocked', { label: d.label, summary: declared.sintesi }), where);
    } else if (declared?.esito === 'ko') {
      st.status = 'fallita';
      this.setPending(st, msg('interventions.declaredKo', { summary: declared.sintesi }));
      st.pendingActions = ['riprendi', 'riprova', 'salta', 'annulla'];
      this.say('errore', msg('events.agentKo', { label: d.label, summary: declared.sintesi }), where);
    } else {
      st.status = 'completata';
      st.output = declared
        ? `${declared.sintesi}${declared.decisioni.length ? `\n${this.t('agent.output.decisions')} ${declared.decisioni.map((x) => `- ${x}`).join('\n')}` : ''}`
        : clip(a.resultText ?? '', 3000);
      if (!declared) this.say('fase', msg('events.noOutcomeBlock', { label: d.label }), where);
      for (const dec of declared?.decisioni ?? []) this.decision(n.id, a.id, dec, 'dichiarata', false);
      this.say('risultato', msg('events.phaseCompleted', { label: d.label, summary: declared?.sintesi ?? clip(a.resultText ?? '', 300) }), where);
      if (key) writeReuseEntry(key, { runId: this.run.id, attemptId: a.id, output: st.output, declared, resultText: a.resultText, savedAt: new Date().toISOString() });
    }
    this.nodeChanged(n.id);
    this.runChanged();
    this.schedule();
  }

  /** Decisione: testo dell'agente (dichiarata) o messaggio di Regia (osservata). */
  private decision(nodeId: string, attemptId: string, what: string | Msg, source: 'dichiarata' | 'osservata', subagent: boolean) {
    const extra = { nodeId, attemptId, source, subagent } as const;
    if (typeof what === 'string') {
      const t = clip(redact(what), 300);
      this.run.nodes[nodeId].lastDecision = t;
      this.event('decisione', t, extra);
      return;
    }
    this.say('decisione', what, extra);
    this.run.nodes[nodeId].lastDecision = this.run.events.at(-1)?.text.slice(0, 300);
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
    this.stopService(n.id, 'restart');
    const cwd = d.subdir?.trim() ? path.resolve(this.wf.settings.projectDir, d.subdir.trim()) : this.wf.settings.projectDir;
    const command = (d.command ?? '').trim();
    const check: ReadyCheck = d.readyCheck ?? 'url';
    // Senza comando la fase verifica soltanto un servizio già attivo (sito su IIS, container, ambiente di test).
    const external = !command;
    const timeoutSec = d.readyTimeoutSec ?? (check === 'exit' ? 600 : 90);
    // La preparazione di Node (versione, dipendenze, diagnosi) vale solo per i progetti Node.
    const nodeProject = !external && (Boolean(d.nodeVersion?.trim()) || fs.existsSync(path.join(cwd, 'package.json')));
    const fix = this.serviceFixes.get(n.id) ?? {};
    this.serviceFixes.set(n.id, fix);
    const a = this.newAttempt(n.id, reason);
    a.usage.costUsd = 0;
    st.status = 'attiva';
    st.pendingActions = undefined;
    this.setPending(st, undefined);
    st.activity = this.t('events.activity.preparing');
    const svc: ServiceState = { command, cwd, url: d.url?.trim() || undefined, status: 'avvio', startedAt: new Date().toISOString(), log: [], readyCheck: external ? 'url' : check, external: external || undefined };
    st.service = svc;
    this.running.add(n.id);
    const sim = this.run.mode === 'prova';
    /** Evento della fase: il nome della fase è aggiunto ai parametri del messaggio. */
    const ev = (m: Msg, kind: EventKind = 'servizio') => this.say(kind, { key: m.key, params: { ...m.params, label: d.label } }, { nodeId: n.id, attemptId: a.id });
    this.nodeChanged(n.id);
    this.updateRunStatus();

    const finish = (ok: boolean, failure?: Msg, actions?: HumanAction[]) => {
      this.running.delete(n.id);
      a.endedAt = new Date().toISOString();
      st.activity = undefined;
      if (this.run.status === 'annullata') { a.status = 'annullata'; this.nodeChanged(n.id); return; }
      if (ok) {
        a.status = 'ok';
        st.status = 'completata';
        const out = external ? msg('agent.output.service.external', { url: svc.url })
          : svc.status === 'completato' ? msg('agent.output.service.done', { command })
          : svc.url ? msg('agent.output.service.activeUrl', { url: svc.url, command })
          : msg('agent.output.service.active', { command });
        st.output = this.tx(out)
          + (svc.pid && svc.status !== 'completato' ? ' (PID ' + svc.pid + ')' : '') + (svc.node ? ', Node ' + svc.node : '') + (sim ? this.t('agent.output.simulated') : '');
        a.resultText = st.output;
        ev(external ? msg('events.service.reachable', { url: svc.url })
          : svc.status === 'completato' ? msg('events.service.done')
          : svc.url ? msg('events.service.active', { url: svc.url })
          : msg('events.service.activeNoUrl'));
      } else {
        const reasonText = failure ? this.tx(failure) : '';
        a.status = 'errore';
        a.error = reasonText;
        st.status = 'fallita';
        // Le ultime righe dell'output restano testo, passate come parametro.
        if (svc.log.length) this.setPending(st, msg('interventions.serviceFailedLog', { reason: reasonText, log: svc.log.slice(-8).join('\n') }));
        else this.setPending(st, failure, reasonText);
        st.pendingActions = actions ?? ['riprova', 'salta', 'annulla'];
        ev(msg('events.service.startFailed', { reason: reasonText }), 'errore');
      }
      this.nodeChanged(n.id);
      this.runChanged();
      this.schedule();
    };

    // 1. Versione di Node richiesta dal progetto (.nvmrc / .node-version / engines, o quella dedotta da un errore precedente).
    let env: NodeJS.ProcessEnv = process.env;
    if (nodeProject) {
      const res = await resolveNode(cwd, d.nodeVersion?.trim() || fix.range, this.lang);
      if (res.ok) {
        svc.node = res.version;
        if (res.note) ev(msg('events.service.withLabel', { text: this.tx(res.note) }));
      } else if (sim) {
        ev(msg('events.service.simNeedsIntervention', { reason: res.message }));
      } else {
        fix.install = res.install;
        return finish(false, res.msg, res.install ? ['installa_node', 'riprova', 'salta', 'annulla'] : ['riprova', 'salta', 'annulla']);
      }
      env = envWithNode(res.ok ? res.dir : undefined);
    }

    if (sim) {
      await new Promise((r) => setTimeout(r, Number(process.env.REGIA_MOCK_SPEED ?? 600)));
      if (external) {
        ev(msg('events.service.simCheck', { url: svc.url }));
        svc.status = 'simulato';
        return finish(true);
      }
      st.activity = this.t('events.activity.command', { command });
      ev(msg('events.service.simStart', { command, cwd }));
      pushLog(svc.log, '> ' + command);
      if (check === 'url') {
        svc.url = svc.url ?? 'http://localhost:5173/';
        for (const l of [this.t('events.service.simReady'), '  Local:   ' + svc.url]) pushLog(svc.log, l);
      } else if (check === 'output') {
        pushLog(svc.log, d.readyPattern?.replace(/^\/(.*)\/[a-z]*$/, '$1') || this.t('events.service.simReady'));
      } else {
        pushLog(svc.log, check === 'exit' ? this.t('events.service.simDone') : this.t('events.service.simLaunched'));
      }
      svc.status = check === 'exit' ? 'completato' : 'simulato';
      return finish(true);
    }

    // Servizio esterno: nessun processo da avviare, solo la verifica dell'indirizzo.
    if (external) {
      const url = svc.url!;
      st.activity = this.t('events.activity.checking', { url });
      ev(msg('events.service.checking', { url }));
      this.nodeChanged(n.id);
      const ctrl = new AbortController();
      this.controllers.set(n.id, ctrl);
      const ok = await waitForUrl(url, timeoutSec * 1000, () => true, ctrl.signal);
      this.controllers.delete(n.id);
      svc.status = ok ? 'attivo' : 'errore';
      if (this.run.status === 'annullata') return finish(false, msg('interventions.service.cancelled'));
      return ok ? finish(true) : finish(false, msg('interventions.service.noResponse', { url, seconds: timeoutSec }));
    }

    // 2. Dipendenze mancanti (progetti Node): installazione automatica senza modificare il lockfile.
    const deps = nodeProject ? depsPlan(cwd) : null;
    if (deps && needsDeps(cwd)) {
      st.activity = this.t('events.activity.deps', { command: deps.display });
      ev(msg('events.service.depsMissing', { command: deps.display }));
      this.nodeChanged(n.id);
      let shown = 0;
      const code = await runOnce(deps.command, null, cwd, env, (l) => {
        pushLog(svc.log, redact(l));
        // Output del comando: resta testo, non viene tradotto.
        if (++shown <= 10) this.event('servizio', d.label + ': ' + redact(l), { nodeId: n.id, attemptId: a.id });
      });
      if (code !== 0) return finish(false, msg('interventions.service.depsInstallFailed', { command: deps.display, code: String(code) }));
      ev(msg('events.service.depsInstalled'));
    }

    // 3. Avvio e attesa, secondo il criterio scelto.
    st.activity = this.t('events.activity.command', { command });
    ev(svc.node ? msg('events.service.startWithNode', { command, cwd, version: svc.node }) : msg('events.service.start', { command, cwd }));
    this.nodeChanged(n.id);
    const ctrl = new AbortController();
    this.controllers.set(n.id, ctrl);
    const pattern = check === 'output' ? readyMatcher(d.readyPattern ?? '') : undefined;
    let lines = 0;
    let lastPush = 0;
    let urlResolve: (u: string) => void = () => undefined;
    const urlFromOutput = new Promise<string>((r) => { urlResolve = r; });
    let matchedResolve: () => void = () => undefined;
    const matched = new Promise<void>((r) => { matchedResolve = r; });
    let exitResolve: () => void = () => undefined;
    const exited = new Promise<void>((r) => { exitResolve = r; });
    const h = startService(command, cwd, {
      onLine: (line) => {
        pushLog(svc.log, line);
        if (++lines <= 25) this.event('servizio', line, { nodeId: n.id, attemptId: a.id });
        if (pattern?.(line)) matchedResolve();
        const now = Date.now();
        if (now - lastPush > 500) { lastPush = now; this.nodeChanged(n.id); }
      },
      onUrl: (u) => {
        // Negli altri criteri l'indirizzo trovato nell'output diventa solo un link comodo.
        if (check !== 'url' && !svc.url) svc.url = u;
        urlResolve(u);
      },
      onExit: (code) => {
        svc.exitCode = code;
        if (this.services.get(n.id) === h) this.services.delete(n.id);
        if (svc.status === 'attivo') {
          svc.status = 'terminato';
          this.say('errore', msg('events.service.exited', { label: d.label, code: String(code ?? '?') }), { nodeId: n.id });
        }
        this.nodeChanged(n.id);
        exitResolve();
        ctrl.abort();
      },
    }, env, check === 'process' || check === 'output');
    this.services.set(n.id, h);
    svc.pid = h.pid;
    const deadline = Date.now() + timeoutSec * 1000;
    const stopped = new Promise<void>((r) => ctrl.signal.addEventListener('abort', () => r(), { once: true }));
    const within = (p: Promise<unknown>, ms: number) => Promise.race([p, stopped, new Promise((r) => setTimeout(r, Math.max(0, ms)))]);
    let ok = false;
    let detached = false;
    let failure: Msg | undefined;
    const exitedDuringStart = () => msg('interventions.service.exitedDuringStart', { code: String(svc.exitCode ?? '?') });
    if (check === 'url') {
      let url = svc.url;
      if (!url) url = await Promise.race([urlFromOutput, within(new Promise(() => undefined), timeoutSec * 1000).then(() => undefined)]);
      if (url && !ctrl.signal.aborted) {
        svc.url = url;
        ok = await waitForUrl(url, Math.max(1000, deadline - Date.now()), () => !h.exited, ctrl.signal);
      }
      if (!ok) failure = h.exited ? exitedDuringStart() : url ? msg('interventions.service.noResponse', { url, seconds: timeoutSec }) : msg('interventions.service.noUrl', { seconds: timeoutSec });
    } else if (check === 'output') {
      let seen = false;
      void matched.then(() => { seen = true; });
      await within(matched, timeoutSec * 1000);
      await Promise.resolve();
      ok = seen && !h.exited;
      if (!ok) failure = h.exited ? exitedDuringStart() : msg('interventions.service.noOutput', { pattern: d.readyPattern ?? '', seconds: timeoutSec });
    } else if (check === 'process') {
      // Il programma deve restare aperto per qualche secondo; un lanciatore che termina con 0 (es. "start app.exe") va bene.
      await within(exited, Math.min(timeoutSec, 5) * 1000);
      if (!h.exited) ok = true;
      else if (svc.exitCode === 0) { ok = true; detached = true; }
      else failure = exitedDuringStart();
    } else {
      await within(exited, timeoutSec * 1000);
      if (h.exited && svc.exitCode === 0) { ok = true; detached = true; }
      else failure = h.exited ? msg('interventions.service.exitCode', { code: String(svc.exitCode ?? '?') }) : msg('interventions.service.notFinished', { seconds: timeoutSec });
    }
    this.controllers.delete(n.id);
    if (ok) {
      svc.status = detached ? 'completato' : 'attivo';
      if (detached) this.services.delete(n.id);
      fix.autoRetried = false;
      return finish(true);
    }
    const hadExited = h.exited;
    this.stopService(n.id, 'startFailed');
    svc.status = 'errore';
    if (this.run.status === 'annullata') return finish(false, msg('interventions.service.cancelled'));

    // 4. Diagnosi dall'output: correzione automatica se possibile, altrimenti l'intervento adatto.
    const diag = diagnose(svc.log, this.lang);
    const base = failure ?? (hadExited ? exitedDuringStart() : msg('interventions.service.noUrl', { seconds: timeoutSec }));
    if (diag?.kind === 'node' && nodeProject) {
      const range = diag.requiredRange ?? fix.range;
      const res2 = range ? await resolveNode(cwd, range, this.lang) : null;
      if (res2?.ok && res2.version !== svc.node && !fix.autoRetried) {
        fix.range = range;
        fix.autoRetried = true;
        ev(msg('events.service.nodeRetry', { diag: diag.message, version: res2.version, manager: res2.manager }));
        this.running.delete(n.id);
        a.status = 'errore';
        a.error = this.tx(base);
        a.endedAt = new Date().toISOString();
        return this.runService(n, 'riprova');
      }
      if (res2 && !res2.ok) {
        fix.range = range;
        fix.install = res2.install;
        return finish(false, msg('interventions.service.nodeUnresolved', { diag: diag.message, detail: res2.message }), res2.install ? ['installa_node', 'riprova', 'salta', 'annulla'] : undefined);
      }
      return finish(false, msg('interventions.service.nodeSetVersion', { diag: diag.message }));
    }
    if (diag?.kind === 'dipendenze' && deps) {
      return finish(false, msg('interventions.service.depsReinstall', { diag: diag.message, command: deps.display }), ['installa_dipendenze', 'riprova', 'salta', 'annulla']);
    }
    return finish(false, diag && diag.kind !== 'node' ? msg('interventions.service.withDiagnosis', { base: this.tx(base), diag: diag.message }) : base);
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
      if (!plan) { this.running.delete(n.id); throw this.fail(msg('api.noNodeInstall')); }
      label = plan.display;
      st.activity = this.t('events.activity.install', { command: label });
      this.say('servizio', msg('events.service.installNode', { label: d.label, command: label, version: plan.version }), { nodeId: n.id });
      this.nodeChanged(n.id);
      code = await runOnce(plan.command, plan.args, cwd, process.env, onLine);
      if (code === 0) fix.range = fix.range ?? plan.version;
    } else {
      const deps = depsPlan(cwd);
      if (!deps) { this.running.delete(n.id); throw this.fail(msg('api.noPackageJson')); }
      const res = await resolveNode(cwd, d.nodeVersion?.trim() || fix.range, this.lang);
      label = deps.display;
      st.activity = this.t('events.activity.deps', { command: label });
      this.say('servizio', msg('events.service.run', { label: d.label, command: label }), { nodeId: n.id });
      this.nodeChanged(n.id);
      code = await runOnce(deps.command, null, cwd, envWithNode(res.ok ? res.dir : undefined), onLine);
    }
    this.running.delete(n.id);
    if (code !== 0) {
      st.status = 'fallita';
      st.activity = undefined;
      this.setPending(st, msg('interventions.repairFailed', { command: label, code: String(code), log: svc.log.slice(-8).join('\n') }));
      st.pendingActions = ['riprova', 'salta', 'annulla'];
      this.say('errore', msg('events.service.repairFailed', { label: d.label, command: label }), { nodeId: n.id });
      this.nodeChanged(n.id);
      this.updateRunStatus();
      return;
    }
    this.say('servizio', msg('events.service.repairDone', { label: d.label, command: label }), { nodeId: n.id });
    fix.autoRetried = false;
    await this.runService(n, 'riprova');
  }

  private stopService(nodeId: string, why: StopReason) {
    const h = this.services.get(nodeId);
    const svc = this.run.nodes[nodeId]?.service;
    if (h) {
      this.services.delete(nodeId);
      if (svc && svc.status !== 'errore') svc.status = 'fermato';
      h.stop();
      this.say('servizio', msg(`events.service.stopped.${why}`, { label: this.node(nodeId).data.label }), { nodeId });
      this.nodeChanged(nodeId);
    } else if (svc?.status === 'simulato') {
      svc.status = 'fermato';
      this.nodeChanged(nodeId);
    }
  }

  private stopAllServices(why: StopReason) {
    for (const id of Object.keys(this.run.nodes)) this.stopService(id, why);
  }

  /** Azioni manuali sul server di una fase: ferma o riavvia, senza cambiare lo stato delle altre fasi. */
  async serviceAction(nodeId: string, action: 'ferma' | 'riavvia') {
    const n = this.node(nodeId);
    if (!n || n.data.kind !== 'server') throw this.fail(msg('api.notServer'));
    if (action === 'ferma') return this.stopService(nodeId, 'manual');
    if (this.running.has(nodeId)) throw this.fail(msg('api.serverStarting'));
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
    // Le istruzioni dell'approvazione sono testo del workflow: nessun messaggio localizzabile.
    // Con dei principi attivi si aggiunge la checklist per chi approva.
    const checklist = principlesText(this.wf.settings.principles, 'approvazione', this.t);
    this.setPending(st, undefined, [n.data.instructions, checklist].filter(Boolean).join('\n\n'));
    this.say('intervento', msg('events.awaitingApproval', { label: n.data.label }), { nodeId: n.id });
    this.nodeChanged(n.id);
  }

  async human(nodeId: string, action: HumanAction, feedback = '') {
    const st = this.run.nodes[nodeId];
    const n = this.node(nodeId);
    if (!st || !n) throw this.fail(msg('api.phaseNotFound'));
    if (action === 'annulla') return this.cancel();
    if (!st.pendingActions?.includes(action)) throw this.fail(msg('api.actionUnavailable', { action }));
    const fb = redact(feedback.trim());
    this.say('intervento', fb
      ? msg('events.humanActionFeedback', { label: n.data.label, action, feedback: clip(fb, 300) })
      : msg('events.humanAction', { label: n.data.label, action }), { nodeId });
    st.pendingActions = undefined;
    this.setPending(st, undefined);

    if (n.data.kind === 'approvazione') {
      if (action === 'approva') {
        st.status = 'completata';
        st.output = fb ? this.t('agent.output.approvedWith', { feedback: fb }) : this.t('agent.output.approved');
        this.nodeChanged(nodeId);
        this.schedule();
        return;
      }
      if (action === 'respingi') {
        if (!fb) { st.pendingActions = ['approva', 'respingi', 'annulla']; throw this.fail(msg('api.rejectNeedsComment')); }
        st.feedbackRounds++;
        if (st.feedbackRounds > MAX_FEEDBACK_ROUNDS) {
          st.status = 'fallita';
          st.pendingActions = ['approva', 'annulla'];
          this.setPending(st, msg('interventions.maxFeedbackRounds', { count: MAX_FEEDBACK_ROUNDS }));
          this.nodeChanged(nodeId);
          this.updateRunStatus();
          return;
        }
        // Il feedback va alla fase che ha prodotto il lavoro: la più vicina a monte che può modificare file
        // (altrimenti le fasi immediatamente precedenti). Le fasi intermedie (test, revisione) vengono rieseguite.
        const targets = this.reworkTargets(nodeId);
        const between = this.nodesBetween(targets, nodeId);
        st.status = 'in_attesa';
        st.activity = this.t('events.activity.correction', { phases: targets.map((t) => this.node(t).data.label).join(', ') });
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
      if (n.data.kind !== 'server') throw this.fail(msg('api.serverOnly'));
      void this.repairService(n, action);
      return;
    }

    if (action === 'salta') {
      st.status = 'saltata';
      st.output = this.t('agent.output.skipped');
      this.nodeChanged(nodeId);
      this.schedule();
    } else if (action === 'riprova') {
      st.status = 'in_attesa';
      this.nodeChanged(nodeId);
      void this.startNode(n, 'riprova');
    } else if (action === 'riprendi') {
      const sess = [...st.attempts].reverse().find((x) => x.sessionId)?.sessionId;
      if (!sess) throw this.fail(msg('api.noSession'));
      void this.runAgent(n, 'ripresa_con_feedback', { sessionId: sess, feedback: fb || this.t('agent.continue') });
    }
  }

  cancel() {
    this.run.status = 'annullata';
    this.run.endedAt = new Date().toISOString();
    for (const c of this.controllers.values()) c.abort();
    this.stopAllServices('cancelled');
    for (const s of Object.values(this.run.nodes)) {
      s.pendingActions = undefined;
      if (s.status === 'in_attesa' || s.status === 'attesa_intervento') s.status = 'saltata';
    }
    this.say('run', msg('events.runCancelled'));
    for (const id of Object.keys(this.run.nodes)) this.send({ t: 'node', node: this.run.nodes[id] });
    this.runChanged();
    active.delete(this.run.id);
    setTimeout(() => this.persist(true), 300);
  }
}

/** Motivo dell'arresto di un server locale (chiave events.service.stopped.*). */
type StopReason = 'completed' | 'restart' | 'startFailed' | 'manual' | 'cancelled';

/**
 * Protocollo di risposta chiesto agli agenti, nella lingua del workflow.
 * Le parti lette da Regia restano invariate in ogni lingua: il blocco ```regia, le chiavi esito/sintesi/decisioni
 * e i valori ok/ko/bloccato. Le righe di decisione iniziano con "DECISIONE:" (it) o "DECISION:" (en).
 */
export function agentProtocol(lang = 'it'): string {
  const t = serverT(lang);
  return t('agent.protocol');
}

/** Riga di decisione dichiarata dall'agente: "DECISIONE:" o "DECISION:", in qualsiasi lingua, anche in grassetto. */
const DECISION_LINE = /^\s*\**\s*(?:DECISIONE|DECISION)\s*\**\s*:\s*\**\s*(.+)$/i;

export function parseDecisionLine(line: string): string | null {
  const m = line.match(DECISION_LINE);
  const text = m?.[1].trim();
  return text ? text : null;
}

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

/** Testo atteso nell'output: "/espressione/opzioni" come espressione regolare, altrimenti testo senza distinzione di maiuscole. */
export function readyMatcher(p: string): (line: string) => boolean {
  const s = p.trim();
  if (!s) return () => false;
  const m = s.match(/^\/(.+)\/([a-z]*)$/);
  if (m) {
    try {
      const re = new RegExp(m[1], m[2].replace(/[gy]/g, ''));
      return (l) => re.test(l);
    } catch { /* non è un'espressione valida: si usa come testo */ }
  }
  const low = s.toLowerCase();
  return (l) => l.toLowerCase().includes(low);
}

/** Nome della skill come lo vede l'utente, senza il prefisso del plugin di Regia. */
const skillName = (s: unknown) => String(s ?? '').replace(new RegExp(`^${PLUGIN_NAME}:`), '').replace(/^\//, '');
const skillLabel = (id: string) => id.replace(/^(progetto|personale):/, '');

function summarizeTool(name: string, input: Record<string, any>, t: Translate, projectDir = ''): string {
  // Percorso relativo alla cartella del progetto; fuori dal progetto, solo gli ultimi segmenti.
  const rel = (p: unknown) => {
    if (typeof p !== 'string') return '';
    const r = projectDir ? path.relative(projectDir, path.resolve(projectDir, p)) : '';
    const inside = Boolean(r) && !r.startsWith('..') && !path.isAbsolute(r);
    return (inside ? r : p).replace(/\\/g, '/').split('/').slice(inside ? 0 : -3).join('/');
  };
  switch (name) {
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': return `${name} ${rel(input.file_path ?? input.notebook_path)}`;
    case 'Bash': return `Bash: ${clip(String(input.command ?? ''), 160)}`;
    case 'Glob': return `Glob ${input.pattern ?? ''}`;
    case 'Grep': return `Grep "${clip(String(input.pattern ?? ''), 80)}"`;
    case 'Agent': case 'Task': return t('events.tool.subagent', { description: input.description ?? '' });
    case 'WebFetch': return `WebFetch ${input.url ?? ''}`;
    case 'WebSearch': return `WebSearch "${input.query ?? ''}"`;
    case 'Skill': return t('events.tool.skill', { skill: skillName(input.skill) });
    default: return name;
  }
}

function observedDecision(name: string, input: Record<string, any>): Msg | null {
  const f = typeof input.file_path === 'string' ? input.file_path.replace(/\\/g, '/').split('/').slice(-2).join('/') : '';
  if (name === 'Edit' || name === 'Write') return msg('events.decisions.edit', { file: f });
  if (name === 'Bash') return msg('events.decisions.bash', { command: clip(String(input.command ?? ''), 120) });
  if (name === 'Skill') return msg('events.decisions.skill', { skill: skillName(input.skill) });
  return null;
}

function usageMsg(a: Attempt): Msg {
  const u = a.usage;
  const p: Params = {
    source: a.usageSource, input: u.inputTokens, output: u.outputTokens, cacheWrite: u.cacheCreationInputTokens, cacheRead: u.cacheReadInputTokens,
    turns: a.numTurns ?? '?', duplicates: a.live.duplicatesSkipped,
  };
  return u.costUsd === null ? msg('events.usage.unknown', p) : msg('events.usage.known', { ...p, cost: u.costUsd.toFixed(4) });
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
