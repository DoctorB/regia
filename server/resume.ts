// Sospensione e ripresa: come si porta un'esecuzione fermata a metà in uno stato riprendibile
// e cosa riceve un agente quando la sua fase riparte.
import type { Translate } from '../shared/i18n.ts';
import type { GitState, InterruptedWork, ResumeCheck, Run } from '../shared/types.ts';
import { serverT } from './i18n.ts';
import { clip } from './redact.ts';
import { getRun, listRuns, saveRun } from './store.ts';

/**
 * Durata della cache del prompt. Entro questo tempo dall'ultima attività una sessione si riprende così com'è
 * (la cache è ancora valida); oltre, riprenderla significherebbe riscrivere in cache tutta la conversazione,
 * quindi la fase riparte con una sessione nuova e il riassunto del lavoro già fatto.
 */
export function cacheTtlMs(): number {
  const s = Number(process.env.REGIA_CACHE_TTL_SEC);
  return (process.env.REGIA_CACHE_TTL_SEC && Number.isFinite(s) && s >= 0 ? s : 300) * 1000;
}

/** Ultima attività registrata di un tentativo (ultimo evento). */
function lastActivity(run: Run, attemptId: string): string | undefined {
  for (let i = run.events.length - 1; i >= 0; i--) if (run.events[i].attemptId === attemptId) return run.events[i].ts;
  return undefined;
}

/** App ancora in funzione (o in avvio) per una fase Avvio app: alla ripresa va riavviata. */
const SERVICE_UP = new Set(['avvio', 'attivo', 'simulato']);

/**
 * Porta un'esecuzione fermata a metà in uno stato da cui si può riprendere. Si può chiamare più volte.
 * - fasi agente attive: tornano in attesa, con il tentativo interrotto e la sessione da cui ripartire;
 * - fasi Avvio app attive o con l'app in funzione: tornano in attesa, l'app viene riavviata alla ripresa;
 * - approvazioni e interventi in attesa: restano in attesa della persona;
 * - esecuzioni salvate da versioni precedenti (fasi "fallita" senza interventi): trattate come interrotte.
 */
export function interruptNodes(run: Run, now = new Date().toISOString()) {
  const kindOf = (id: string) => run.snapshot.nodes.find((n) => n.id === id)?.data.kind;
  for (const st of Object.values(run.nodes)) {
    st.activity = undefined;
    for (const a of st.attempts) {
      if (a.status !== 'attiva') continue;
      a.status = 'interrotta';
      a.endedAt = a.endedAt ?? lastActivity(run, a.id) ?? now;
    }
    const legacy = st.status === 'fallita' && !st.pendingActions?.length;
    const kind = kindOf(st.nodeId);
    if (kind === 'approvazione') {
      if (st.status === 'attiva' || legacy) { st.status = 'in_attesa'; st.pendingActions = undefined; }
      continue;
    }
    if (kind === 'server') {
      const up = st.status === 'completata' && st.service && SERVICE_UP.has(st.service.status);
      if (st.status === 'attiva' || legacy || up) {
        st.status = 'in_attesa';
        st.pendingActions = undefined;
      }
      continue;
    }
    if (st.status !== 'attiva' && !legacy) continue;
    st.status = 'in_attesa';
    st.pendingActions = undefined;
    st.pendingMsg = undefined;
    st.pendingReason = undefined;
    const last = st.attempts.at(-1);
    if (last && !st.interrupted) {
      st.interrupted = {
        attemptId: last.id,
        sessionId: last.sessionId ?? last.resumedSessionId,
        feedback: last.feedback,
        lastActivityAt: lastActivity(run, last.id) ?? last.endedAt ?? last.startedAt,
      };
    }
  }
}

/** Nota aggiunta a un'esecuzione interrotta dalla chiusura di Regia (nella lingua dell'esecuzione). */
export const interruptedNote = (run: Run) => serverT(run.snapshot.settings.language ?? 'it')('notes.interrupted');
/** Nota scritta dalle versioni precedenti, rimossa alla ripresa. */
const LEGACY_NOTE = 'Esecuzione interrotta: il server è stato riavviato mentre era attiva.';
export const isInterruptedNote = (run: Run, note: string) => note === LEGACY_NOTE || note === interruptedNote(run);

/** All'avvio di Regia: le esecuzioni rimaste attive da un avvio precedente diventano interrotte e riprendibili. */
export function recoverInterruptedRuns() {
  for (const s of listRuns()) {
    if (s.status !== 'in_corso' && s.status !== 'attesa_intervento') continue;
    const run = getRun(s.id);
    if (!run) continue;
    const at = run.events.at(-1)?.ts ?? new Date().toISOString();
    run.status = 'interrotta';
    run.suspendedAt = at;
    run.endedAt = at;
    interruptNodes(run, at);
    const note = interruptedNote(run);
    if (!run.notes.includes(note)) run.notes.push(note);
    saveRun(run);
  }
}

/**
 * Riassunto del lavoro di un tentativo interrotto, per una sessione nuova: passi e decisioni registrati
 * (anche dei tentativi interrotti precedenti della stessa catena) e l'eventuale correzione in corso.
 */
export function interruptedSummary(run: Run, nodeId: string, intr: InterruptedWork, t: Translate, locale = 'it-IT'): string {
  const st = run.nodes[nodeId];
  const ids = new Set<string>();
  const end = st.attempts.findIndex((a) => a.id === intr.attemptId);
  for (let i = end; i >= 0; i--) {
    ids.add(st.attempts[i].id);
    if (st.attempts[i].reason !== 'ripresa_dopo_interruzione') break;
  }
  const steps = run.events
    .filter((e) => e.attemptId && ids.has(e.attemptId) && !e.subagent && (e.kind === 'strumento' || e.kind === 'decisione' || e.kind === 'testo'))
    .map((e) => `- ${clip(e.text.replace(/\s+/g, ' ').trim(), e.kind === 'testo' ? 400 : 200)}`)
    .slice(-60);
  const date = new Date(intr.lastActivityAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
  const parts = [t('agent.interrupted.summary', { date, steps: steps.length ? steps.join('\n') : t('agent.interrupted.noSteps') })];
  if (intr.feedback) parts.push(t('agent.interrupted.feedback', { feedback: intr.feedback }));
  return parts.join('\n\n');
}

/** Confronto tra lo stato git registrato e quello attuale. */
export function compareGit(before: GitState | undefined, now: GitState | undefined): ResumeCheck {
  return {
    before, now,
    branchChanged: Boolean(before?.branch && now?.branch && before.branch !== now.branch),
    headChanged: Boolean(before?.head && now?.head && before.head !== now.head),
  };
}
