import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Attempt, ContinuationPlan, LaunchPlan, PointRef, ReviewPoints, RunReference, ServiceState, DeclaredOutcome, EventKind, HumanAction, InterruptedWork, NodeRunState, ReadyCheck, Run, RunEvent, RunMode, ShowTarget, Workflow, WorkflowNode, WorkflowSettings, PhaseQuestion, UserStory,
} from '../shared/types.ts';
import { emptyTotals, isAgentKind, RESUMABLE } from '../shared/types.ts';
import { msg, type Msg, type Params, type Translate } from '../shared/i18n.ts';
import { serverT } from './i18n.ts';
import { mockQuery } from './mockQuery.ts';
import { clip, redact } from './redact.ts';
import { buildSkillBundle, discoverSkills, phaseSkills, PLUGIN_NAME, removeSkillBundles, skillSources, type SkillBundle } from './skills.ts';
import { rulesPrompt, snapshotRules } from './rules.ts';
import { activePrinciples, principlesText } from '../shared/principles.ts';
import { runReport } from '../shared/report.ts';
import { grantLevel, lacksLevel, type PermissionLevel } from '../shared/permissions.ts';
import { DATA_DIR, getRun, getWorkflow, readReuseCache, saveRun, saveWorkflow, writeReuseEntry } from './store.ts';
import { adbPath } from './mobile.ts';
import { watchAppLog, type AppLogWatcher } from './uat.ts';
import { scrcpyStatus, startMirror, type MirrorHandle } from './scrcpy.ts';
import { startMirrorStream, type MirrorStream } from './mirror.ts';
import { report } from './reports.ts';
import { storyDir, storyPrompt } from './story.ts';
import { gitState } from './folder.ts';
import { cacheTtlMs, interruptedSummary, interruptNodes, isInterruptedNote } from './resume.ts';
import { AttemptAccounting, sumTotals, type SessionSnapshot } from './usage.ts';
import { topoOrder } from './validate.ts';
import { pushLog, startService, waitForUrl, type ServiceHandle } from './service.ts';
import { describeTree, logsDir, processTree, ServiceTrace } from './servicetrace.ts';
import { depsPlan, diagnose, envWithNode, needsDeps, resolveNode, runOnce, type InstallPlan } from './nodeenv.ts';
import { openBrowser, planLaunch } from './launch.ts';

const MAX_EVENTS = 6000;
/** Punti proposti al massimo da una revisione. */
const MAX_POINTS = 25;
/** Turni massimi per rispondere a una domanda (può rileggere qualche file). */
const QUESTION_TURNS = 10;
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

/** Resoconto compatto di un'esecuzione precedente, fotografato per passarlo agli agenti. */
export function makeReference(ref: Run, lang: string): RunReference {
  return {
    runId: ref.id, workflowName: ref.workflowName, startedAt: ref.startedAt, status: ref.status,
    text: clip(runReport(ref, serverT(lang), lang, { compact: true }), 12000),
  };
}

/**
 * reference: esecuzione di riferimento scelta all'avvio (solo per i workflow con referenceRun);
 * in una continuazione senza nuova scelta resta quella dell'esecuzione di partenza.
 */
export function startRun(wf: Workflow, mode: RunMode, from?: Run, reference?: Run, story?: { story?: UserStory; error?: Msg }): RunEngine {
  const plan = from ? planContinuation(wf, from) : undefined;
  const run: Run = {
    id: `run_${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}_${randomUUID().slice(0, 6)}`,
    workflowId: wf.id,
    workflowName: wf.name,
    snapshot: structuredClone(wf),
    mode,
    status: 'in_corso',
    startedAt: new Date().toISOString(),
    nodes: Object.fromEntries(wf.nodes.map((n) => [n.id, { nodeId: n.id, status: 'in_attesa', attempts: [], feedbackRounds: 0 } satisfies NodeRunState])),
    events: [],
    totals: emptyTotals(),
    notes: [],
    rules: snapshotRules(wf.settings),
    continuedFrom: from?.id,
    reference: wf.settings.referenceRun ? (reference ? makeReference(reference, workflowLang(wf)) : from?.reference) : undefined,
    story: story?.story,
    storyError: story?.error,
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

/**
 * Riprende un'esecuzione sospesa o interrotta: le fasi completate restano, quelle fermate a metà ripartono
 * (sulla stessa sessione se la cache del prompt è ancora valida, altrimenti con il riassunto del lavoro fatto),
 * approvazioni e interventi in attesa tornano disponibili.
 */
export function resumeRun(id: string): RunEngine {
  const run = getRun(id);
  if (!run || active.has(id) || !RESUMABLE.includes(run.status)) {
    const m = msg(run ? 'api.notResumable' : 'api.runNotFound');
    throw new RegiaError(m, serverT(run ? workflowLang(run.snapshot) : 'it')(m.key));
  }
  interruptNodes(run);
  const eng = new RunEngine(run);
  active.set(run.id, eng);
  eng.resume();
  return eng;
}

/** Attesa predefinita della fase "mostra": le build mobili e desktop sono lente la prima volta. */
const SHOW_TIMEOUT_SEC: Record<ShowTarget, number> = { dispositivo: 1200, browser: 180, desktop: 600 };
/** Proroga per i comandi ancora attivi allo scadere del tempo: silenzio massimo e durata massima complessiva. */
const WAIT_IDLE_SEC = Number(process.env.REGIA_WAIT_IDLE_SEC) || 300;
const WAIT_MAX_SEC = Number(process.env.REGIA_WAIT_MAX_SEC) || 3600;

export class RunEngine {
  private listeners = new Set<Broadcast>();
  private controllers = new Map<string, AbortController>();
  private services = new Map<string, ServiceHandle>();
  /** Log di diagnosi dell'ultimo comando avviato da ogni fase (data/logs/<esecuzione>/). */
  private traces = new Map<string, ServiceTrace>();
  /** Per le fasi server: versione di Node dedotta da un errore, installazione proponibile, tentativo automatico già fatto. */
  private serviceFixes = new Map<string, { range?: string; install?: InstallPlan; autoRetried?: boolean }>();
  private sessions = new Map<string, SessionSnapshot>();
  /** Schermi dei telefoni trasmessi dal vivo durante i collaudi, per fase. */
  private mirrors = new Map<string, MirrorStream>();
  private running = new Set<string>();
  /** Approvazioni le cui fasi precedenti stanno applicando un feedback. */
  private reworking = new Set<string>();
  /** Fasi intermedie da rieseguire dopo una correzione richiesta in approvazione. */
  private afterCorrection = new Set<string>();
  private saveTimer: NodeJS.Timeout | null = null;
  /** Dopo una sospensione l'esecuzione appartiene al file salvato: nessuna scrittura tardiva. */
  private frozen = false;
  private wf: Workflow;
  /** Lingua dell'esecuzione: istruzioni agli agenti e testi di riserva dei messaggi. */
  private lang: string;
  private t: Translate;

  constructor(public run: Run) {
    this.wf = run.snapshot;
    this.lang = workflowLang(run.snapshot);
    this.t = serverT(this.lang);
    for (const n of Object.values(run.nodes)) for (const a of n.attempts) if (a.sessionId && a.sessionCumulative) this.sessions.set(a.sessionId, a.sessionCumulative);
    // Domande rimaste a metà (sospensione o chiusura di Regia): restano senza risposta, si possono rifare.
    for (const n of Object.values(run.nodes)) for (const q of n.questions ?? []) {
      if (q.sessionId && q.attempt.sessionCumulative) this.sessions.set(q.sessionId, q.attempt.sessionCumulative);
      if (q.status === 'in_corso') { q.status = 'errore'; q.error = this.t('agent.questionInterrupted'); q.attempt.status = 'interrotta'; }
    }
  }

  /** Cartelle di lavoro in più per gli agenti: aggiuntive del workflow, immagini della user story, prove del collaudo. */
  private agentDirs(uatDir?: string): string[] {
    return [...existingExtraDirs(this.wf.settings), ...(this.run.story?.images.length ? [storyDir(this.run.story)] : []), ...(uatDir ? [uatDir] : [])];
  }

  /** Schermo dal vivo del collaudo in corso nella fase, se c'è. */
  mirror(nodeId: string): MirrorStream | undefined {
    return this.mirrors.get(nodeId);
  }

  subscribe(fn: Broadcast) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private send(msg: unknown) {
    for (const l of this.listeners) l(msg);
  }

  private persist(immediate = false) {
    if (this.frozen) return;
    if (immediate) {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = null;
      saveRun(this.run);
      return;
    }
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; if (!this.frozen) saveRun(this.run); }, 800);
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
    if (kind === 'errore' && this.run.mode === 'reale' && REPORTED.has(m.key)) {
      const st = extra.nodeId ? this.run.nodes[extra.nodeId] : undefined;
      const node = extra.nodeId ? this.wf.nodes.find((x) => x.id === extra.nodeId) : undefined;
      report({
        source: 'fase', key: m.key, kind: node?.data.kind, lang: this.lang, message: this.tx(safe),
        // Con il log di diagnosi: tempi, pause, processi rimasti attivi e ultime righe con il loro istante.
        detail: (extra.nodeId ? this.traces.get(extra.nodeId)?.reportDetail() : undefined)
          || (st?.service?.log.length ? st.service.log.slice(-30).join('\n') : undefined),
      });
    }
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
    const all = Object.values(this.run.nodes).flatMap((n) => [...n.attempts, ...(n.questions ?? []).map((q) => q.attempt)].map((a) => a.usage));
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
    const ref = this.run.reference;
    if (ref) this.say('run', msg('events.reference', { name: ref.workflowName, id: ref.runId }));
    if (this.run.story) this.say('run', msg('events.story.loaded', { type: this.run.story.type ?? '', id: this.run.story.id, title: this.run.story.title, count: this.run.story.images.length }));
    else if (this.run.storyError) this.say('errore', msg('events.story.failed', { error: this.tx(this.run.storyError) }));
    const dirs = extraDirs(this.wf.settings);
    if (dirs.length) this.say('run', msg('events.extraDirs', { dirs: dirs.join(', '), count: dirs.length }));
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
    void this.captureGit();
    this.schedule();
  }

  /** Ripresa dopo una sospensione o un'interruzione (l'esecuzione è già stata preparata da interruptNodes). */
  resume() {
    this.run.notes = this.run.notes.filter((n) => !isInterruptedNote(this.run, n));
    this.run.status = 'in_corso';
    this.run.endedAt = undefined;
    const phases = Object.values(this.run.nodes).filter((s) => s.interrupted).map((s) => this.node(s.nodeId).data.label).join(', ');
    this.say('run', phases ? msg('events.runResumed', { phases }) : msg('events.runResumedNone'));
    this.persist(true);
    this.schedule();
  }

  /**
   * Sospende l'esecuzione: le fasi in corso si fermano e il loro lavoro resta registrato, le app avviate
   * vengono chiuse, approvazioni e interventi restano in attesa. Riprendi riparte da qui, anche dopo un riavvio.
   */
  async suspend() {
    if (this.run.status !== 'in_corso' && this.run.status !== 'attesa_intervento') throw this.fail(msg('api.notSuspendable'));
    const now = new Date().toISOString();
    this.run.status = 'sospesa';
    this.run.suspendedAt = now;
    this.run.endedAt = now;
    // Salvata subito: l'elenco delle esecuzioni, riletto dall'interfaccia al cambio di stato, la mostra già sospesa.
    this.persist(true);
    this.say('run', msg('events.runSuspended'));
    for (const c of this.controllers.values()) c.abort();
    // Le fasi in corso registrano l'interruzione appena il loro flusso si chiude (di solito in pochi istanti).
    const t0 = Date.now();
    while (this.running.size && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 50));
    interruptNodes(this.run, now);
    this.stopAllServices('suspended');
    await this.captureGit();
    for (const id of Object.keys(this.run.nodes)) this.send({ t: 'node', node: this.run.nodes[id] });
    this.runChanged();
    this.persist(true);
    this.frozen = true;
    active.delete(this.run.id);
  }

  /** Letto dopo un await: lo stato può essere cambiato nel frattempo (TypeScript non lo vede). */
  private isSuspended() {
    return this.run.status === 'sospesa';
  }

  /** Ramo e commit del progetto, per avvisare alla ripresa se sono cambiati nel frattempo. */
  private async captureGit() {
    const g = await gitState(this.wf.settings.projectDir);
    if (g && !this.frozen) { this.run.git = g; this.persist(); }
  }

  /** Riparte una fase agente interrotta: stessa sessione se la cache è ancora valida, altrimenti sessione nuova con il riassunto. */
  private resumeInterrupted(n: WorkflowNode) {
    const st = this.run.nodes[n.id];
    const intr = st.interrupted!;
    st.interrupted = undefined;
    const idle = Date.now() - Date.parse(intr.lastActivityAt);
    const p = { label: n.data.label, minutes: Math.max(0, Math.round(idle / 60000)) };
    if (intr.sessionId && idle < cacheTtlMs()) {
      this.say('fase', msg('events.interrupted.session', p), { nodeId: n.id });
      const prompt = this.t('agent.interrupted.session', { label: n.data.label, protocol: agentProtocol(this.lang, n.data.kind) });
      return this.runAgent(n, 'ripresa_dopo_interruzione', { sessionId: intr.sessionId, feedback: intr.feedback ?? '', prompt }, { feedback: intr.feedback, fallback: intr });
    }
    this.say('fase', msg(intr.sessionId ? 'events.interrupted.summary' : 'events.interrupted.noSession', p), { nodeId: n.id });
    return this.runAgent(n, 'ripresa_dopo_interruzione', undefined, { extra: interruptedSummary(this.run, n.id, intr, this.t, this.lang), feedback: intr.feedback });
  }

  private schedule() {
    if (['annullata', 'completata', 'fallita', 'interrotta', 'sospesa'].includes(this.run.status)) return;
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
      if (st.interrupted && isAgentKind(n.data.kind)) {
        void this.resumeInterrupted(n);
        continue;
      }
      const reason = this.afterCorrection.delete(n.id) ? 'dopo_correzione' : st.attempts.length ? 'riprova' : 'iniziale';
      void this.startNode(n, reason);
    }
    this.updateRunStatus();
  }

  private updateRunStatus() {
    const states = Object.values(this.run.nodes);
    if (['annullata', 'interrotta', 'sospesa'].includes(this.run.status)) return;
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

  private buildPrompt(n: WorkflowNode, extra?: string): string {
    const ctx = this.upstreamContext(n);
    return [
      this.wf.settings.goal ? this.t('agent.goal', { goal: this.wf.settings.goal }) : '',
      this.run.story ? storyPrompt(this.run.story, this.t) : '',
      this.run.reference ? this.t('agent.reference', {
        name: this.run.reference.workflowName,
        date: new Date(this.run.reference.startedAt).toLocaleString(this.lang, { dateStyle: 'short', timeStyle: 'short' }),
        report: this.run.reference.text,
      }) : '',
      this.t('agent.task', { label: n.data.label, instructions: n.data.instructions }),
      ctx,
      extra,
      agentProtocol(this.lang, n.data.kind),
    ].filter(Boolean).join('\n\n');
  }

  /** Testo aggiunto al prompt di sistema della fase: ruolo, principi di progettazione e regole generali. */
  private systemAppend(d: WorkflowNode['data']): string {
    const principles = principlesText(this.wf.settings.principles, d.kind, this.t);
    return `${d.role ? `\n${this.t('agent.role', { role: d.role })}` : ''}${principles ? `\n\n${principles}` : ''}${rulesPrompt(this.run.rules, this.lang)}${this.extraDirsPrompt()}`;
  }

  /** Cartelle aggiuntive del workflow: valgono anche senza regole generali, perché ampliano quelle consentite. */
  private extraDirsPrompt(): string {
    const dirs = extraDirs(this.wf.settings);
    return dirs.length ? `\n\n${this.t('agent.extraDirs', { dirs: dirs.map((x) => `- ${x}`).join('\n') })}` : '';
  }

  private reuseKey(n: WorkflowNode, prompt: string) {
    const d = n.data;
    const h = createHash('sha256');
    h.update(JSON.stringify([this.run.mode, d.role, d.model, d.allowedTools, d.maxTurns, prompt, this.wf.settings.projectDir, this.wf.settings.loadProjectSettings, d.skills ?? null, this.wf.settings.skillSources ?? null, extraDirs(this.wf.settings)]));
    // I principi cambiano il prompt di sistema: entrano nella chiave solo se attivi, così i risultati già in cache restano validi.
    const principles = activePrinciples(this.wf.settings.principles);
    if (principles.length) h.update(JSON.stringify(principles));
    h.update(projectFingerprint(this.wf.settings.projectDir));
    return h.digest('hex');
  }

  private newAttempt(nodeId: string, reason: Attempt['reason']): Attempt {
    const st = this.run.nodes[nodeId];
    const a = blankAttempt(`${nodeId}#${st.attempts.length + 1}`, nodeId, st.attempts.length, reason);
    st.attempts.push(a);
    return a;
  }

  /**
   * resume: riprende una sessione (prompt = feedback, o il testo indicato). opts.extra: testo aggiunto al prompt di
   * una sessione nuova; opts.feedback: correzione in corso da ricordare se la fase viene interrotta;
   * opts.fallback: se la sessione non si può riprendere, la fase riparte con il riassunto.
   */
  private async runAgent(n: WorkflowNode, reason: Attempt['reason'], resume?: { sessionId: string; feedback: string; prompt?: string }, opts: { extra?: string; feedback?: string; fallback?: InterruptedWork; uat?: { dir: string; watcher?: AppLogWatcher; mirror?: MirrorHandle; live?: MirrorStream } } = {}) {
    if (this.run.status === 'sospesa') return;
    const st = this.run.nodes[n.id];
    const d = n.data;
    const prompt = resume
      ? resume.prompt ?? this.t('agent.feedback', { feedback: resume.feedback, label: d.label, protocol: agentProtocol(this.lang, d.kind) })
      : this.buildPrompt(n, opts.extra);

    let key: string | undefined;
    if (d.reuseResult && !resume && !opts.extra) {
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
    const feedback = reason === 'ripresa_con_feedback' ? resume?.feedback : opts.feedback;
    if (feedback) a.feedback = feedback;
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
    };
    const how = reason === 'ripresa_dopo_interruzione' ? (resume ? 'interruptedSession' : 'interruptedSummary')
      : resume ? 'resumed' : reason === 'riprova' ? 'retry' : 'initial';
    this.say('fase', msg(`events.phaseStarted.${how}`, startParams), { nodeId: n.id, attemptId: a.id });
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
    /** Task dei subagenti avviati in questo tentativo (gli altri task, ad esempio Bash, non sono subagenti). */
    const agentTasks = new Set<string>();
    /** Messaggio localizzabile dell'errore, quando la causa è riconosciuta da Regia. */
    let errorMsg: Msg | undefined;
    try {
      const stream = this.run.mode === 'prova'
        ? mockQuery({ phase: d, attemptIndex: st.attempts.filter((x) => !x.step).indexOf(a), resume: resume?.sessionId, signal: ctrl.signal, lang: this.lang, skills: bundle ? Object.values(bundle.byId) : [], projectDir: this.wf.settings.projectDir, extraDirs: extraDirs(this.wf.settings) })
        : query({
          prompt,
          options: {
            cwd: this.wf.settings.projectDir,
            // Senza richieste di permesso, Claude Code nega le scritture fuori dalle cartelle di lavoro: queste le ampliano.
            // Il collaudo salva gli screenshot nella cartella delle prove, fuori dal progetto.
            ...(this.agentDirs(opts.uat?.dir).length ? { additionalDirectories: this.agentDirs(opts.uat?.dir) } : {}),
            model: d.model || undefined,
            tools,
            allowedTools: tools,
            ...(bundle ? { plugins: [{ type: 'local' as const, path: bundle.path }], skills: bundle.names } : {}),
            permissionMode: 'dontAsk',
            systemPrompt: { type: 'preset', preset: 'claude_code', append: this.systemAppend(d) || undefined },
            maxTurns: d.maxTurns,
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
          // Anche i comandi Bash lunghi sono "task": contano come subagenti solo quelli di tipo local_agent (o senza tipo, CLI meno recenti).
          if (sm.task_type && sm.task_type !== 'local_agent') continue;
          if (sm.task_id) agentTasks.add(sm.task_id);
          a.subagents++;
          this.say('subagente', msg('events.subagentStarted', { description: sm.description ?? '' }), { nodeId: n.id, attemptId: a.id, subagent: true });
          this.decision(n.id, a.id, msg('events.decisions.delegated', { description: sm.description ?? '' }), 'osservata', false);
        } else if (sm.type === 'system' && sm.subtype === 'task_notification') {
          if (sm.task_id && !agentTasks.has(sm.task_id)) continue;
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
            errorMsg = sm.subtype === 'error_max_turns' ? msg('interventions.error.maxTurns') : undefined;
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
      if (opts.uat) {
        opts.uat.mirror?.stop();
        opts.uat.live?.stop();
        this.mirrors.delete(n.id);
        if (st.uat) st.uat.live = false;
        this.closeUat(st, a, opts.uat.dir, opts.uat.watcher);
      }
    }

    a.endedAt = new Date().toISOString();
    st.activity = undefined;
    // Sospensione: il tentativo resta interrotto e la fase riprenderà da qui (interruptNodes).
    if (this.isSuspended()) {
      a.status = 'interrotta';
      a.error = undefined;
      this.nodeChanged(n.id);
      this.runChanged();
      return;
    }
    if (a.status !== 'annullata') a.status = a.error ? 'errore' : 'ok';
    // Sessione non più disponibile (es. dati della CLI cancellati): si riparte subito con il riassunto.
    if (a.status === 'errore' && opts.fallback && a.live.steps === 0) {
      this.say('fase', msg('events.interrupted.sessionUnavailable', { label: d.label }), { nodeId: n.id, attemptId: a.id });
      st.interrupted = { ...opts.fallback, sessionId: undefined };
      st.status = 'in_attesa';
      this.nodeChanged(n.id);
      this.runChanged();
      this.schedule();
      return;
    }
    void this.captureGit();
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
    } else if (declared?.esito === 'bloccato' || declared?.esito === 'ko') {
      // Se l'agente si è fermato per un permesso che la fase davvero non ha, lo si concede con un clic.
      const ask = declared.permesso && lacksLevel(d.allowedTools, declared.permesso) ? declared.permesso : undefined;
      st.missingPermission = ask;
      // Lo stesso per una cartella esterna, se non è già tra quelle consentite.
      const askDir = declared.cartella && !this.dirAllowed(declared.cartella) ? path.resolve(declared.cartella) : undefined;
      st.missingDir = askDir;
      const actions: HumanAction[] = ['riprendi', 'riprova', 'salta', 'annulla'];
      st.pendingActions = [...(ask ? ['consenti' as const] : []), ...(askDir ? ['consenti_cartella' as const] : []), ...actions];
      if (declared.esito === 'bloccato') {
        st.status = 'bloccata';
        // La sintesi è testo dell'agente: nessun messaggio localizzabile.
        this.setPending(st, undefined, declared.sintesi);
        this.say('intervento', msg('events.agentBlocked', { label: d.label, summary: declared.sintesi }), where);
      } else {
        st.status = 'fallita';
        this.setPending(st, msg('interventions.declaredKo', { summary: declared.sintesi }));
        this.say('errore', msg('events.agentKo', { label: d.label, summary: declared.sintesi }), where);
      }
      if (ask) this.say('intervento', msg(`events.permissionAsked.${ask}`, { label: d.label }), where);
      if (askDir) this.say('intervento', msg('events.dirAsked', { label: d.label, path: askDir }), where);
    } else {
      st.status = 'completata';
      // I punti restano anche nel testo per le fasi successive (ad esempio un rapporto che unisce le revisioni).
      st.output = declared
        ? `${declared.sintesi}${declared.decisioni.length ? `\n${this.t('agent.output.decisions')} ${declared.decisioni.map((x) => `- ${x}`).join('\n')}` : ''}`
          + (declared.punti?.length ? `\n${this.t('agent.output.points')}\n${declared.punti.map((x) => `- ${x}`).join('\n')}` : '')
          + (declared.puntiOmessi?.length ? `\n${this.t('agent.output.pointsOmitted', { count: declared.puntiOmessi.length })}` : '')
          + (declared.manuali?.length ? `\n${this.t('agent.output.manual')}\n${declared.manuali.map((x) => `- ${x}`).join('\n')}` : '')
        : clip(a.resultText ?? '', 3000);
      if (!declared) this.say('fase', msg('events.noOutcomeBlock', { label: d.label }), where);
      // I punti scartati non compaiono altrove: il blocco di esito è tolto dal testo mostrato negli eventi.
      if (declared?.puntiOmessi?.length) {
        const points = declared.puntiOmessi.map((x) => `- ${x}`).join('\n');
        this.say('fase', msg('events.pointsOmitted', { label: d.label, count: declared.puntiOmessi.length, max: MAX_POINTS, points }), where);
      }
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
    if (this.run.status === 'sospesa') return Promise.resolve();
    if (n.data.kind === 'collaudo') return this.runCollaudo(n, reason);
    return n.data.kind === 'server' ? this.runService(n, reason) : this.runAgent(n, reason);
  }

  /** Collaudo: build, installazione e avvio come "Mostra sul telefono", poi l'agente prova l'app mentre Regia ne segue il log. */
  private runCollaudo(n: WorkflowNode, reason: Attempt['reason']) {
    return this.runService(n, reason, (plan) => { void this.runUat(n, reason, plan); });
  }

  private async runUat(n: WorkflowNode, reason: Attempt['reason'], plan: LaunchPlan | undefined) {
    const st = this.run.nodes[n.id];
    const round = (st.uat?.round ?? 0) + 1;
    const dir = path.join(DATA_DIR, 'uat', this.run.id, n.id, String(round));
    fs.mkdirSync(dir, { recursive: true });
    const device = plan?.device;
    const appId = plan?.appId;
    st.uat = { round, device: device?.name, appId, screenshots: [] };
    const logFile = path.join(dir, 'app-log.txt');
    const where = { nodeId: n.id };
    let watcher: AppLogWatcher | undefined;
    // Il log si registra solo con un dispositivo Android vero (in prova non c'è).
    if (this.run.mode === 'reale' && device && plan?.platform === 'android') {
      watcher = watchAppLog(adbPath(), device.id, appId, logFile, (what) => {
        this.say('errore', msg('events.uat.crash', { label: n.data.label, what: clip(what, 300) }), where);
      });
      this.say('fase', msg(appId ? 'events.uat.logStarted' : 'events.uat.logStartedAll', { label: n.data.label, app: appId ?? '' }), where);
    }
    // Schermo del telefono dal vivo nella pagina (server di scrcpy sul telefono, video H.264), e a richiesta anche
    // nella finestra di scrcpy. Sola visione; tutto si chiude con il collaudo.
    let live: MirrorStream | undefined;
    let mirror: MirrorHandle | undefined;
    if (this.run.mode === 'reale' && device && plan?.platform === 'android' && !n.data.show?.noMirror) {
      try {
        live = await startMirrorStream(adbPath(), device.id, (reason) => {
          this.mirrors.delete(n.id);
          if (st.uat) st.uat.live = false;
          this.say('fase', msg('events.uat.mirrorEnded', { label: n.data.label, reason: clip(redact(reason), 200) }), where);
          this.nodeChanged(n.id);
        });
        this.mirrors.set(n.id, live);
        st.uat.live = true;
        this.say('fase', msg('events.uat.mirrorLive', { label: n.data.label }), where);
        this.nodeChanged(n.id);
      } catch (e) {
        this.say('errore', msg('events.uat.mirrorFailed', { label: n.data.label, error: clip(redact((e as Error).message), 300) }), where);
      }
    }
    if (this.run.mode === 'reale' && device && plan?.platform === 'android' && !n.data.show?.noMirror && n.data.show?.mirrorWindow) {
      const sc = scrcpyStatus();
      if (sc.installed && sc.path) {
        mirror = startMirror(sc.path, device.id, `Regia · ${n.data.label}`, adbPath(), (code, output) => {
          if (code) this.say('errore', msg('events.uat.mirrorFailed', { label: n.data.label, error: clip(redact(output.trim()), 300) || String(code) }), where);
        });
        this.say('fase', msg('events.uat.mirrorStarted', { label: n.data.label }), where);
      } else {
        this.say('fase', msg('events.uat.mirrorMissing', { label: n.data.label }), where);
      }
    }
    const extra = this.t('agent.uat.context', {
      device: device ? `${device.name} (${device.id})` : this.t('agent.uat.noDevice'),
      serial: device?.id ?? '',
      adb: slash(adbPath()),
      app: appId ?? this.t('agent.uat.unknownApp'),
      dir: slash(dir),
      log: watcher ? slash(logFile) : this.t('agent.uat.noLog'),
      windows: process.platform === 'win32' ? this.t('agent.uat.windows') : '',
    });
    await this.runAgent(n, reason, undefined, { extra, uat: { dir, watcher, mirror, live } });
  }

  /** Fine del giro di collaudo: chiude il log, raccoglie gli screenshot e aggiunge crash e ANR alle anomalie. */
  private closeUat(st: NodeRunState, a: Attempt, dir: string, watcher: AppLogWatcher | undefined) {
    const log = watcher?.stop();
    if (!st.uat) return;
    try { st.uat.screenshots = fs.readdirSync(dir).filter((x) => /\.(png|jpe?g)$/i.test(x)).sort(); } catch { /* cartella assente */ }
    if (!log) return;
    st.uat.log = log;
    if (log.crashes.length && a.declared) {
      const found = log.crashes.map((c) => this.t('agent.uat.crashPoint', { what: c }));
      a.declared.punti = [...(a.declared.punti ?? []), ...found].slice(0, MAX_POINTS);
    }
  }

  /**
   * Fase "server": prepara l'ambiente (versione di Node richiesta dal progetto, dipendenze), avvia il comando
   * e lo tiene attivo fino alla fine dell'esecuzione. In caso di errore legge l'output, riconosce le cause comuni,
   * ritenta da solo quando può e altrimenti propone l'intervento adatto.
   */
  private async runService(n: WorkflowNode, reason: Attempt['reason'], then?: (plan: LaunchPlan | undefined) => void): Promise<void> {
    const st = this.run.nodes[n.id];
    // Il collaudo è sempre su un dispositivo, anche se la fase è stata creata cambiando tipo.
    const d = n.data.kind === 'collaudo' && !n.data.show ? { ...n.data, show: { target: 'dispositivo' as const } } : n.data;
    this.stopService(n.id, 'restart');
    const baseCwd = d.subdir?.trim() ? path.resolve(this.wf.settings.projectDir, d.subdir.trim()) : this.wf.settings.projectDir;
    let cwd = baseCwd;
    // Fase "mostra" (telefono, browser, desktop): comando, cartella e criterio sono decisi dal rilevamento, più avanti.
    const show = d.show;
    let command = show ? '' : (d.command ?? '').trim();
    let check: ReadyCheck = d.readyCheck ?? 'url';
    let readyPattern = d.readyPattern ?? '';
    // Senza comando la fase verifica soltanto un servizio già attivo (sito su IIS, container, ambiente di test).
    let external = !command && !show;
    const timeoutSec = d.readyTimeoutSec ?? (show ? SHOW_TIMEOUT_SEC[show.target] : check === 'exit' ? 600 : 90);
    // La preparazione di Node (versione, dipendenze, diagnosi) vale solo per i progetti Node.
    let nodeProject = !external && !show && (Boolean(d.nodeVersion?.trim()) || fs.existsSync(path.join(cwd, 'package.json')));
    const fix = this.serviceFixes.get(n.id) ?? {};
    this.serviceFixes.set(n.id, fix);
    const a = this.newAttempt(n.id, reason);
    a.usage.costUsd = 0;
    if (then) a.step = 'build';
    let launched: LaunchPlan | undefined;
    st.status = 'attiva';
    st.pendingActions = undefined;
    this.setPending(st, undefined);
    st.activity = this.t('events.activity.preparing');
    const svc: ServiceState = { command, cwd, url: d.url?.trim() || undefined, status: 'avvio', startedAt: new Date().toISOString(), log: [], readyCheck: external ? 'url' : check, external: external || undefined };
    st.service = svc;
    this.running.add(n.id);
    // Il log di diagnosi del tentativo precedente non deve finire nelle segnalazioni di questo.
    this.traces.get(n.id)?.close();
    this.traces.delete(n.id);
    const sim = this.run.mode === 'prova';
    /** Evento della fase: il nome della fase è aggiunto ai parametri del messaggio. */
    const ev = (m: Msg, kind: EventKind = 'servizio') => this.say(kind, { key: m.key, params: { ...m.params, label: d.label } }, { nodeId: n.id, attemptId: a.id });
    this.nodeChanged(n.id);
    this.updateRunStatus();

    const finish = (ok: boolean, failure?: Msg, actions?: HumanAction[]) => {
      const tr = this.traces.get(n.id);
      if (tr) {
        tr.note(ok ? 'esito: avvio riuscito' : `esito: avvio non riuscito — ${failure ? this.tx(failure) : ''}`);
        // Un servizio rimasto attivo continua a scrivere nel log; si chiude quando il processo termina.
        if (!this.services.has(n.id)) tr.close();
      }
      this.running.delete(n.id);
      a.endedAt = new Date().toISOString();
      st.activity = undefined;
      if (this.run.status === 'annullata') { a.status = 'annullata'; this.nodeChanged(n.id); return; }
      if (this.run.status === 'sospesa') { a.status = 'interrotta'; this.nodeChanged(n.id); return; }
      // Collaudo: app installata e aperta, ora tocca all'agente (stessa fase, nessun completamento qui).
      if (ok && then) {
        a.status = 'ok';
        st.service = undefined;
        ev(msg('events.uat.installed'));
        this.nodeChanged(n.id);
        then(launched);
        return;
      }
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
        // Apri nel browser: la pagina pronta si apre da sola (non nelle prove).
        if (show?.target === 'browser' && svc.url && !sim) {
          const o = openBrowser(svc.url, show.browser);
          ev(o.fallback ? msg('events.service.browserFallback', { url: svc.url, browser: show.browser ?? '' })
            : o.browser ? msg('events.service.browserOpened', { url: svc.url, browser: o.browser })
            : msg('events.service.browserOpenedDefault', { url: svc.url }));
        }
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

    // 0. Fase "mostra": progetto (e dispositivo) rilevati, comando e criterio di pronto.
    let planEnv: Record<string, string> | undefined;
    let companion: LaunchPlan['companion'];
    if (show) {
      st.activity = this.t(show.target === 'dispositivo' ? 'events.activity.detectingDevice' : 'events.activity.detectingProject');
      this.nodeChanged(n.id);
      const plan = await planLaunch(baseCwd, show, d.url ?? '', { simulate: sim });
      launched = plan;
      if (this.run.status === 'annullata' || this.run.status === 'sospesa') return finish(false, msg('interventions.service.cancelled'));
      cwd = path.join(baseCwd, plan.dir);
      svc.cwd = cwd;
      if (plan.problem && !sim) return finish(false, plan.problem);
      if (plan.problem) ev(msg('events.service.simNeedsIntervention', { reason: this.tx(plan.problem) }));
      else if (show.target === 'dispositivo') ev(msg(sim ? 'events.service.mobilePlanSim' : 'events.service.mobilePlan', { framework: plan.project, device: plan.device?.name, platform: plan.platform === 'ios' ? 'iOS' : 'Android' }));
      else if (plan.project) ev(msg('events.service.launchPlan', { project: plan.project }));
      for (const note of plan.notes) ev(msg('events.service.withLabel', { text: this.tx(note) }));
      command = plan.command ?? (plan.problem ? this.t('events.service.mobileSimCommand') : '');
      check = plan.check;
      readyPattern = plan.readyPattern ?? '';
      external = !command;
      svc.command = command;
      svc.readyCheck = external ? 'url' : check;
      svc.external = external || undefined;
      if (plan.url) svc.url = plan.url;
      planEnv = plan.env;
      if (plan.companion?.enabled) {
        companion = plan.companion;
        ev(msg('events.service.companion', { project: companion.project, dir: companion.dir || '.' }));
      }
      nodeProject = !external && (Boolean(d.nodeVersion?.trim()) || fs.existsSync(path.join(cwd, 'package.json')));
    }

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
    if (planEnv) env = { ...env, ...planEnv };

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
      const ok = url.startsWith('file:') ? fs.existsSync(fileURLToPath(url)) : await waitForUrl(url, timeoutSec * 1000, () => true, ctrl.signal);
      this.controllers.delete(n.id);
      svc.status = ok ? 'attivo' : 'errore';
      if (this.run.status === 'annullata') return finish(false, msg('interventions.service.cancelled'));
      return ok ? finish(true) : finish(false, msg('interventions.service.noResponse', { url, seconds: timeoutSec }));
    }

    // Log di diagnosi: tutto l'output con l'istante di ogni riga, le pause e gli eventi di Regia.
    const traceName = `${n.id}-${st.attempts.length}.log`;
    const trace = new ServiceTrace(path.join(logsDir(this.run.id), traceName), {
      fase: `${d.label} (${d.kind}${show ? `, ${show.target}` : ''})`,
      comando: redact(command),
      cartella: cwd,
      criterio: check,
      testo_atteso: check === 'output' ? readyPattern : undefined,
      attesa: `${timeoutSec} s (proroga se scrive ancora: silenzio massimo ${Math.min(WAIT_IDLE_SEC, Math.max(1, Math.floor(timeoutSec / 2)))} s, massimo ${Math.max(timeoutSec, WAIT_MAX_SEC)} s)`,
      node: svc.node,
      backend: companion ? `${companion.command} in ${companion.dir || '.'}` : undefined,
      sistema: `${process.platform} ${process.arch}, Node ${process.version}`,
    });
    this.traces.set(n.id, trace);
    svc.trace = traceName;

    // 2. Dipendenze mancanti (progetti Node): installazione automatica senza modificare il lockfile.
    const deps = nodeProject ? depsPlan(cwd) : null;
    if (deps && needsDeps(cwd)) {
      st.activity = this.t('events.activity.deps', { command: deps.display });
      ev(msg('events.service.depsMissing', { command: deps.display }));
      this.nodeChanged(n.id);
      trace.note(`installazione dipendenze: ${deps.display}`);
      let shown = 0;
      const code = await runOnce(deps.command, null, cwd, env, (l) => {
        trace.line(redact(l), '[dipendenze]');
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
    const pattern = check === 'output' ? readyMatcher(readyPattern) : undefined;
    let lines = 0;
    let lastPush = 0;
    let urlResolve: (u: string) => void = () => undefined;
    const urlFromOutput = new Promise<string>((r) => { urlResolve = r; });
    let matchedResolve: () => void = () => undefined;
    const matched = new Promise<void>((r) => { matchedResolve = r; });
    let exitResolve: () => void = () => undefined;
    const exited = new Promise<void>((r) => { exitResolve = r; });
    // Backend del sito (es. be/ accanto a fe/): parte insieme e si ferma con la fase; il suo output va nel log.
    let side: ServiceHandle | undefined;
    if (companion) {
      const c = companion;
      let shown = 0;
      side = startService(c.command, path.join(baseCwd, c.dir), {
        onLine: (line) => {
          trace.line(line, `[${c.dir || '.'}]`);
          pushLog(svc.log, `[${c.dir || '.'}] ${line}`);
          if (++shown <= 10) this.event('servizio', `${c.project}: ${line}`, { nodeId: n.id, attemptId: a.id });
        },
        onUrl: () => undefined,
        onExit: (code) => {
          trace.note(`backend ${c.project} terminato (codice ${code ?? '?'})`);
          if (this.services.get(n.id) === handle) this.say('errore', msg('events.service.companionExited', { label: d.label, project: c.project, code: String(code ?? '?') }), { nodeId: n.id });
        },
      }, env);
      ev(msg('events.service.start', { command: c.command, cwd: path.join(baseCwd, c.dir) }));
    }
    let handle: ServiceHandle | undefined;
    const startedAt = Date.now();
    let lastOutput = startedAt;
    trace.note(`avvio del comando (attesa ${timeoutSec} s)`);
    const h = startService(command, cwd, {
      onLine: (line) => {
        lastOutput = Date.now();
        trace.line(line);
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
        trace.note(`processo terminato (codice ${code ?? '?'})`);
        // A fase già conclusa (servizio rimasto attivo) il log si chiude qui; altrimenti lo chiude l'esito.
        if (!this.running.has(n.id)) trace.close();
        // Se l'app si chiude, si ferma anche il backend avviato con lei.
        if (this.services.get(n.id) === handle) { this.services.delete(n.id); side?.stop(); }
        if (svc.status === 'attivo') {
          svc.status = 'terminato';
          this.say('errore', msg('events.service.exited', { label: d.label, code: String(code ?? '?') }), { nodeId: n.id });
        }
        this.nodeChanged(n.id);
        exitResolve();
        ctrl.abort();
      },
    }, env, check === 'process' || check === 'output');
    const both = side;
    handle = both ? { pid: h.pid, get exited() { return h.exited; }, stop: () => { h.stop(); both.stop(); } } : h;
    this.services.set(n.id, handle);
    svc.pid = h.pid;
    const deadline = Date.now() + timeoutSec * 1000;
    const stopped = new Promise<void>((r) => ctrl.signal.addEventListener('abort', () => r(), { once: true }));
    // Il timer dell'attesa massima viene cancellato appena l'attesa finisce, altrimenti resterebbe attivo fino alla scadenza.
    const within = async (p: Promise<unknown>, ms: number) => {
      let t: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([p, stopped, new Promise((r) => { t = setTimeout(r, Math.max(0, ms)); })]);
      } finally {
        clearTimeout(t);
      }
    };
    // Attesa che segue l'attività: allo scadere del tempo, se il comando scrive ancora output (es. una build Gradle
    // lunga) si continua ad aspettare finché resta in silenzio per idleSec, fino al massimo assoluto.
    const idleSec = Math.min(WAIT_IDLE_SEC, Math.max(1, Math.floor(timeoutSec / 2)));
    const maxMs = Math.max(timeoutSec, WAIT_MAX_SEC) * 1000;
    let extended = false;
    const waitActive = async (p: Promise<unknown>) => {
      let done = false;
      void p.then(() => { done = true; });
      for (;;) {
        await within(p, Math.min(startedAt + maxMs, Math.max(startedAt + timeoutSec * 1000, lastOutput + idleSec * 1000)) - Date.now());
        await Promise.resolve();
        const now = Date.now();
        if (done || ctrl.signal.aborted) return;
        if (now - startedAt >= maxMs || now - lastOutput >= idleSec * 1000) {
          trace.note(`attesa finita: in corso da ${Math.round((now - startedAt) / 1000)} s, nessuna riga da ${Math.round((now - lastOutput) / 1000)} s`);
          return;
        }
        if (!extended) {
          extended = true;
          trace.note(`tempo normale scaduto: il comando scrive ancora (ultima riga ${Math.round((now - lastOutput) / 1000)} s fa), proroga`);
          ev(msg('events.service.stillWorking', { seconds: timeoutSec, max: maxMs / 1000 }));
        }
      }
    };
    /** Motivo del tempo scaduto: il limite normale, il silenzio dopo la proroga o il massimo assoluto. */
    const timedOut = (normal: Msg) => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      if (!extended) return normal;
      return elapsed * 1000 >= maxMs ? msg('interventions.service.tooLong', { seconds: maxMs / 1000 })
        : msg('interventions.service.stalled', { seconds: elapsed, idle: idleSec });
    };
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
      await waitActive(Promise.race([matched, exited]));
      await Promise.resolve();
      ok = seen && !h.exited;
      if (!ok) failure = h.exited ? exitedDuringStart() : timedOut(msg('interventions.service.noOutput', { pattern: readyPattern, seconds: timeoutSec }));
    } else if (check === 'process') {
      // Il programma deve restare aperto per qualche secondo; un lanciatore che termina con 0 (es. "start app.exe") va bene.
      await within(exited, Math.min(timeoutSec, 5) * 1000);
      if (!h.exited) ok = true;
      else if (svc.exitCode === 0) { ok = true; detached = true; }
      else failure = exitedDuringStart();
    } else {
      await waitActive(exited);
      if (h.exited && svc.exitCode === 0) { ok = true; detached = true; }
      else failure = h.exited ? msg('interventions.service.exitCode', { code: String(svc.exitCode ?? '?') }) : timedOut(msg('interventions.service.notFinished', { seconds: timeoutSec }));
    }
    this.controllers.delete(n.id);
    if (ok) {
      svc.status = detached ? 'completato' : 'attivo';
      if (detached) this.services.delete(n.id);
      fix.autoRetried = false;
      return finish(true);
    }
    const hadExited = h.exited;
    // Comando ancora in corso allo scadere: prima di fermarlo si annota cosa sta girando e da quanto tace,
    // così si distingue una build lenta da una bloccata (es. in attesa di una conferma sul dispositivo).
    if (!hadExited && failure && !ctrl.signal.aborted && this.run.status !== 'annullata' && this.run.status !== 'sospesa') {
      const procs = h.pid ? await processTree(h.pid) : [];
      trace.procs = procs;
      trace.note(procs.length ? `processi ancora attivi (${procs.length}):` : 'processi ancora attivi: nessuno trovato');
      for (const p of procs) trace.note(`  pid ${p.pid} (padre ${p.ppid}) ${p.name} · cpu ${p.cpuSec ?? '?'} s · da ${p.ageSec ?? '?'} s · ${redact(p.command ?? '')}`);
      const s = trace.summary();
      const base = this.tx(failure);
      failure = s.lines && s.silentSec >= idleSec
        ? msg('interventions.service.silentSince', { base, silent: s.silentSec, last: clip(s.lastLine ?? '', 200) })
        : s.lines ? msg('interventions.service.stillWriting', { base, silent: s.silentSec }) : msg('interventions.service.noLines', { base });
      if (procs.length) failure = msg('interventions.service.processes', { base: this.tx(failure), procs: describeTree(procs) });
    }
    this.stopService(n.id, 'startFailed');
    svc.status = 'errore';
    if (this.run.status === 'annullata') return finish(false, msg('interventions.service.cancelled'));

    // 4. Diagnosi dall'output: correzione automatica se possibile, altrimenti l'intervento adatto.
    // Un comando che doveva terminare ed è ancora in corso allo scadere del tempo è solo lento (es. build Gradle):
    // le parole trovate nel suo output non spiegano il fallimento.
    const diag = check === 'exit' && !hadExited ? null : diagnose(svc.log, this.lang);
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
    const cwd = st.service?.cwd ?? (d.subdir?.trim() ? path.resolve(this.wf.settings.projectDir, d.subdir.trim()) : this.wf.settings.projectDir);
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

  /**
   * Punti proposti dalle fasi che un respingi farebbe rieseguire (tipicamente le revisioni tra
   * l'implementazione e l'approvazione, anche se non collegate direttamente), più le fasi collegate
   * direttamente. Conta l'ultimo tentativo di ciascuna; ordine del workflow.
   */
  private reviewPointsFor(approvalId: string): ReviewPoints[] {
    const ids = new Set([...this.nodesBetween(this.reworkTargets(approvalId), approvalId), ...this.preds(approvalId)]);
    return this.wf.nodes
      .filter((x) => ids.has(x.id) && x.data.kind !== 'approvazione' && this.run.nodes[x.id]?.status === 'completata')
      .map((x) => {
        const declared = this.run.nodes[x.id].attempts.at(-1)?.declared;
        return { nodeId: x.id, label: x.data.label, items: declared?.punti ?? [], ...(declared?.puntiOmessi?.length ? { omitted: declared.puntiOmessi.length } : {}) };
      })
      .filter((p) => p.items.length);
  }

  /** Ultima sessione della fase, da cui riprendere una conversazione. */
  private lastSession(nodeId: string) {
    return [...(this.run.nodes[nodeId]?.attempts ?? [])].reverse().find((a) => a.sessionId)?.sessionId;
  }

  /**
   * Fasi a cui chi approva può fare una domanda: quelle che l'approvazione esamina, con un agente, completate e con
   * una sessione da riprendere. Prima le revisioni, che di solito sono quelle da interrogare.
   */
  private askableFor(approvalId: string): { nodeId: string; label: string }[] {
    const targets = this.reworkTargets(approvalId);
    const ids = new Set([...targets, ...this.nodesBetween(targets, approvalId), ...this.preds(approvalId)]);
    return this.wf.nodes
      .filter((x) => ids.has(x.id) && isAgentKind(x.data.kind) && this.run.nodes[x.id]?.status === 'completata' && this.lastSession(x.id))
      .sort((a, b) => Number(b.data.kind === 'revisione') - Number(a.data.kind === 'revisione'))
      .map((x) => ({ nodeId: x.id, label: x.data.label }));
  }

  /**
   * Domanda di chiarimento a una fase già completata, mentre l'approvazione aspetta. La fase risponde in una copia della
   * sua sessione (quella originale resta intatta), può solo leggere, e niente viene rieseguito.
   */
  ask(approvalId: string, targetId: string, question: string): PhaseQuestion {
    const st = this.run.nodes[approvalId];
    const n = this.node(approvalId);
    if (!st || !n || n.data.kind !== 'approvazione') throw this.fail(msg('api.phaseNotFound'));
    if (st.status !== 'attesa_intervento' || !st.pendingActions?.includes('approva')) throw this.fail(msg('api.questionUnavailable'));
    const text = redact(question.trim()).slice(0, 2000);
    if (!text) throw this.fail(msg('api.questionEmpty'));
    if (st.questions?.some((x) => x.status === 'in_corso')) throw this.fail(msg('api.questionBusy'));
    const target = this.node(targetId);
    if (!target || !(st.askable ?? []).some((x) => x.nodeId === targetId)) throw this.fail(msg('api.questionTarget'));
    // Le domande successive alla stessa fase, nello stesso giro, continuano la conversazione già aperta.
    const prev = [...(st.questions ?? [])].reverse().find((x) => x.targetId === targetId && x.round === st.feedbackRounds && x.sessionId && x.status === 'risposta');
    const from = prev?.sessionId ?? this.lastSession(targetId);
    if (!from) throw this.fail(msg('api.questionTarget'));
    const qs = (st.questions ??= []);
    const id = `q${qs.length + 1}`;
    const entry: PhaseQuestion = {
      id, targetId, question: text, status: 'in_corso', askedAt: new Date().toISOString(), round: st.feedbackRounds,
      attempt: blankAttempt(`${approvalId}?${id}`, targetId, 0, 'domanda'),
    };
    qs.push(entry);
    this.say('intervento', msg('events.questionAsked', { label: n.data.label, target: target.data.label, question: clip(text, 300) }), { nodeId: approvalId });
    this.nodeChanged(approvalId);
    void this.answer(approvalId, target, entry, from, !prev);
    return entry;
  }

  private async answer(approvalId: string, target: WorkflowNode, q: PhaseQuestion, from: string, fork: boolean) {
    const d = target.data;
    const a = q.attempt;
    const ctrl = new AbortController();
    const key = a.id;
    this.controllers.set(key, ctrl);
    const acc = new AttemptAccounting(a, this.sessions.get(from), this.run.mode === 'prova' ? 'simulato' : undefined);
    const tools = ['Read', 'Glob', 'Grep'];
    const dirs = this.agentDirs();
    let text = '';
    let gotResult = false;
    try {
      const stream = this.run.mode === 'prova'
        ? mockQuery({ phase: d, attemptIndex: 0, resume: from, fork, question: q.question, signal: ctrl.signal, lang: this.lang })
        : query({
          prompt: this.t('agent.question', { question: q.question }),
          options: {
            cwd: this.wf.settings.projectDir,
            ...(dirs.length ? { additionalDirectories: dirs } : {}),
            model: d.model || undefined,
            tools,
            allowedTools: tools,
            permissionMode: 'dontAsk',
            systemPrompt: { type: 'preset', preset: 'claude_code', append: this.systemAppend(d) || undefined },
            maxTurns: QUESTION_TURNS,
            abortController: ctrl,
            resume: from,
            forkSession: fork,
            settingSources: this.wf.settings.loadProjectSettings ? ['project'] : [],
          },
        });
      for await (const sm of stream as AsyncIterable<Record<string, any>>) {
        if (sm.type === 'system' && sm.subtype === 'init') {
          q.sessionId = sm.session_id;
          a.sessionId = sm.session_id;
          if (sm.model && !a.models.includes(sm.model)) a.models.push(sm.model);
        } else if (sm.type === 'assistant') {
          acc.onAssistant(sm);
          if (!sm.parent_tool_use_id) for (const b of sm.message?.content ?? []) if (b.type === 'text' && b.text?.trim()) text = b.text;
        } else if (sm.type === 'result') {
          gotResult = true;
          const snap = acc.onResult(sm);
          if (snap) a.sessionCumulative = snap;
          if (snap && sm.session_id) this.sessions.set(sm.session_id, snap);
          q.sessionId = sm.session_id ?? q.sessionId;
          if (typeof sm.result === 'string' && sm.result.trim()) text = sm.result;
        }
      }
      if (!gotResult) acc.applyPartial();
      const answer = redact(text.replace(/```regia[\s\S]*?```/g, '').trim()).slice(0, 8000);
      if (!answer) throw new Error(this.t('agent.noAnswer'));
      q.answer = answer;
      q.status = 'risposta';
      a.status = 'ok';
      this.say('testo', msg('events.questionAnswered', { target: d.label, answer: clip(answer, 300) }), { nodeId: approvalId });
    } catch (err) {
      if (!gotResult) acc.applyPartial();
      q.status = 'errore';
      a.status = ctrl.signal.aborted ? 'annullata' : 'errore';
      q.error = ctrl.signal.aborted ? this.t('agent.questionCancelled') : redact((err as Error).message).slice(0, 500);
      this.say('errore', msg('events.questionFailed', { target: d.label, error: q.error }), { nodeId: approvalId });
    } finally {
      a.endedAt = new Date().toISOString();
      this.controllers.delete(key);
    }
    if (this.frozen) return;
    this.nodeChanged(approvalId);
    this.runChanged();
  }

  /** Feedback per la fase da correggere: i punti scelti, raggruppati per fase, e il commento libero. */
  private composeFeedback(st: NodeRunState, refs: PointRef[], comment: string): string {
    const parts: string[] = [];
    for (const group of st.reviewPoints ?? []) {
      const chosen = [...new Set(refs.filter((r) => r.nodeId === group.nodeId).map((r) => r.index))]
        .sort((a, b) => a - b).map((i) => group.items[i]).filter(Boolean);
      if (chosen.length) parts.push(this.t('agent.chosenPoints', { label: group.label, points: chosen.map((x) => `- ${x}`).join('\n') }));
    }
    if (comment) parts.push(parts.length ? this.t('agent.extraComment', { comment }) : comment);
    return parts.join('\n\n');
  }

  private requestApproval(n: WorkflowNode) {
    const st = this.run.nodes[n.id];
    st.status = 'attesa_intervento';
    st.pendingActions = ['approva', 'respingi', 'annulla'];
    // Le istruzioni dell'approvazione sono testo del workflow: nessun messaggio localizzabile.
    // Con dei principi attivi si aggiunge la checklist per chi approva.
    const checklist = principlesText(this.wf.settings.principles, 'approvazione', this.t);
    this.setPending(st, undefined, [n.data.instructions, checklist].filter(Boolean).join('\n\n'));
    const points = this.reviewPointsFor(n.id);
    st.reviewPoints = points.length ? points : undefined;
    const askable = this.askableFor(n.id);
    st.askable = askable.length ? askable : undefined;
    this.say('intervento', msg('events.awaitingApproval', { label: n.data.label }), { nodeId: n.id });
    this.nodeChanged(n.id);
  }

  /**
   * Concede un permesso alla fase: aggiorna la copia del workflow dell'esecuzione (resta nel registro)
   * e il workflow salvato, così la volta successiva la fase parte già con quel permesso.
   */
  private grantPermission(n: WorkflowNode, level: PermissionLevel) {
    const before = n.data.allowedTools;
    n.data.allowedTools = grantLevel(before, level);
    const added = n.data.allowedTools.filter((x) => !before.includes(x));
    this.say('intervento', msg(`events.permissionGranted.${level}`, { label: n.data.label, tools: added.join(', ') }), { nodeId: n.id });
    const saved = getWorkflow(this.run.workflowId);
    const sn = saved?.nodes.find((x) => x.id === n.id);
    if (saved && sn) {
      sn.data.allowedTools = grantLevel(sn.data.allowedTools, level);
      saveWorkflow(saved);
      this.say('intervento', msg('events.permissionSaved', { label: n.data.label }), { nodeId: n.id });
    }
    this.runChanged();
  }

  /** La cartella è già tra quelle in cui la fase può lavorare (progetto o cartelle aggiuntive)? */
  private dirAllowed(dir: string) {
    return [this.wf.settings.projectDir, ...extraDirs(this.wf.settings)].some((p) => p && isInsideDir(dir, p));
  }

  /** Aggiunge una cartella esterna al workflow dell'esecuzione e a quello salvato, come per i permessi. */
  private grantDir(n: WorkflowNode, dir: string) {
    const add = (s: WorkflowSettings) => { s.extraDirs = [...extraDirs(s).filter((x) => !isInsideDir(x, dir)), dir]; };
    // La cartella chiesta può non esistere ancora (es. una cartella di output): si crea, così Claude Code la accetta.
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* resta segnalata dalla validazione */ }
    add(this.wf.settings);
    this.say('intervento', msg('events.dirGranted', { label: n.data.label, path: dir }), { nodeId: n.id });
    const saved = getWorkflow(this.run.workflowId);
    if (saved) {
      add(saved.settings);
      saveWorkflow(saved);
      this.say('intervento', msg('events.dirSaved', { path: dir }), { nodeId: n.id });
    }
    this.runChanged();
  }

  async human(nodeId: string, action: HumanAction, feedback = '', points: PointRef[] = []) {
    const st = this.run.nodes[nodeId];
    const n = this.node(nodeId);
    if (!st || !n) throw this.fail(msg('api.phaseNotFound'));
    if (action === 'annulla') return this.cancel();
    if (!st.pendingActions?.includes(action)) throw this.fail(msg('api.actionUnavailable', { action }));
    for (const q of st.questions ?? []) if (q.status === 'in_corso') this.controllers.get(q.attempt.id)?.abort();
    // Respingendo, i punti scelti tra quelli proposti diventano parte del feedback per la fase da correggere.
    const fb = action === 'respingi' && n.data.kind === 'approvazione'
      ? this.composeFeedback(st, points, redact(feedback.trim()))
      : redact(feedback.trim());
    if (n.data.kind === 'approvazione' && (action === 'approva' || (action === 'respingi' && fb))) st.reviewPoints = undefined;
    this.say('intervento', fb
      ? msg('events.humanActionFeedback', { label: n.data.label, action, feedback: clip(fb, 300) })
      : msg('events.humanAction', { label: n.data.label, action }), { nodeId });
    st.pendingActions = undefined;
    this.setPending(st, undefined);
    const granted = st.missingPermission;
    const grantedDir = st.missingDir;
    st.missingPermission = undefined;
    st.missingDir = undefined;

    if (action === 'consenti' || action === 'consenti_cartella') {
      let note: string;
      if (action === 'consenti') {
        if (!granted) throw this.fail(msg('api.actionUnavailable', { action }));
        this.grantPermission(n, granted);
        note = this.t(`agent.permissionGranted.${granted}`);
      } else {
        if (!grantedDir) throw this.fail(msg('api.actionUnavailable', { action }));
        this.grantDir(n, grantedDir);
        note = this.t('agent.dirGranted', { path: grantedDir });
      }
      // Stessa sessione, ora con il nuovo permesso: l'agente riparte da dove si era fermato.
      const sess = [...st.attempts].reverse().find((x) => x.sessionId)?.sessionId;
      st.status = 'in_attesa';
      this.nodeChanged(nodeId);
      if (sess) void this.runAgent(n, 'ripresa_con_feedback', { sessionId: sess, feedback: note });
      else void this.startNode(n, 'riprova');
      return;
    }

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
        // Nessun limite ai cicli: ogni ciclo parte solo da un respingimento con commento, quindi decide la persona.
        st.feedbackRounds++;
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
type StopReason = 'completed' | 'restart' | 'startFailed' | 'manual' | 'cancelled' | 'suspended';

/**
 * Protocollo di risposta chiesto agli agenti, nella lingua del workflow.
 * Le parti lette da Regia restano invariate in ogni lingua: il blocco ```regia, le chiavi esito/sintesi/decisioni
 * e i valori ok/ko/bloccato. Le righe di decisione iniziano con "DECISIONE:" (it) o "DECISION:" (en).
 */
export function agentProtocol(lang = 'it', kind?: WorkflowNode['data']['kind']): string {
  const t = serverT(lang);
  // Le revisioni elencano a parte le modifiche proposte: chi approva sceglie quali far applicare.
  if (kind === 'revisione') return `${t('agent.protocol')}\n${t('agent.protocolPoints', { max: MAX_POINTS })}`;
  // Il collaudo usa gli stessi punti per le anomalie, più gli scenari da provare a mano.
  if (kind === 'collaudo') return `${t('agent.protocol')}\n${t('agent.protocolUat', { max: MAX_POINTS })}`;
  return t('agent.protocol');
}

/** Riga di decisione dichiarata dall'agente: "DECISIONE:" o "DECISION:", in qualsiasi lingua, anche in grassetto. */
const DECISION_LINE = /^\s*\**\s*(?:DECISIONE|DECISION)\s*\**\s*:\s*\**\s*(.+)$/i;

export function parseDecisionLine(line: string): string | null {
  const m = line.match(DECISION_LINE);
  const text = m?.[1].trim();
  return text ? text : null;
}

/** Percorso con le barre "/": la shell degli agenti su Windows è bash, dove le barre rovesciate sono caratteri di escape. */
const slash = (p: string) => p.replace(/\\/g, '/');

/**
 * Errori che finiscono nelle segnalazioni (se la persona ha dato il consenso): quelli che dipendono da Regia o dal suo
 * ambiente. Non i test falliti, gli esiti "ko" degli agenti, gli errori degli strumenti o i crash dell'app collaudata.
 */
const REPORTED = new Set([
  'events.phaseFailed', 'events.service.startFailed', 'events.uat.mirrorFailed', 'events.skillsBundleFailed', 'events.questionFailed',
]);

/** Tentativo vuoto, con i contatori azzerati. */
function blankAttempt(id: string, nodeId: string, index: number, reason: Attempt['reason']): Attempt {
  return {
    id, nodeId, index, reason, startedAt: new Date().toISOString(), status: 'attiva',
    models: [], usage: emptyTotals(), usageSource: 'nessuno',
    live: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, steps: 0, duplicatesSkipped: 0, subagentMessages: 0 },
    toolCalls: [], subagents: 0,
  };
}

/** Cartelle aggiuntive valide del workflow: percorsi assoluti, normalizzati, senza doppioni. */
export function extraDirs(s: WorkflowSettings): string[] {
  const out: string[] = [];
  for (const d of s.extraDirs ?? []) {
    const p = d.trim();
    if (p && path.isAbsolute(p) && !out.some((x) => isInsideDir(p, x) && isInsideDir(x, p))) out.push(path.resolve(p));
  }
  return out;
}

/** Solo le cartelle aggiuntive che esistono: le altre restano segnalate dalla validazione. */
export const existingExtraDirs = (s: WorkflowSettings) => extraDirs(s).filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });

/** `dir` coincide con `parent` o sta al suo interno (su Windows senza distinguere maiuscole). */
export function isInsideDir(dir: string, parent: string) {
  const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const rel = path.relative(norm(parent), norm(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function parseDeclared(text: unknown): DeclaredOutcome | undefined {
  if (typeof text !== 'string') return undefined;
  const blocks = [...text.matchAll(/```regia\s*([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (!last) return undefined;
  try {
    const j = JSON.parse(last);
    const esito = ['ok', 'ko', 'bloccato'].includes(j.esito) ? j.esito : 'ok';
    // Oltre il limite si tengono i primi (il protocollo chiede l'ordine per importanza); gli altri vanno nel registro.
    const all: string[] = Array.isArray(j.punti)
      ? j.punti.map((x: unknown) => redact(String(x ?? '')).trim().slice(0, 500)).filter(Boolean)
      : [];
    const punti = all.slice(0, MAX_POINTS);
    const manuali: string[] = Array.isArray(j.manuali)
      ? j.manuali.map((x: unknown) => redact(String(x ?? '')).trim().slice(0, 500)).filter(Boolean).slice(0, MAX_POINTS)
      : [];
    const puntiOmessi = all.slice(MAX_POINTS, 100);
    return {
      esito,
      sintesi: redact(String(j.sintesi ?? '')).slice(0, 2000),
      decisioni: Array.isArray(j.decisioni) ? j.decisioni.slice(0, 10).map((x: unknown) => redact(String(x)).slice(0, 300)) : [],
      ...(punti.length ? { punti } : {}),
      ...(puntiOmessi.length ? { puntiOmessi } : {}),
      ...(manuali.length ? { manuali } : {}),
      // Il permesso conta solo se la fase si è fermata.
      ...(esito !== 'ok' && (j.permesso === 'modifica' || j.permesso === 'internet') ? { permesso: j.permesso as PermissionLevel } : {}),
      ...(esito !== 'ok' && typeof j.cartella === 'string' && path.isAbsolute(j.cartella.trim()) ? { cartella: j.cartella.trim().slice(0, 500) } : {}),
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
