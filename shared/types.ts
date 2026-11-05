// Tipi condivisi tra server e interfaccia.
import type { Msg } from './i18n.ts';
export type { Msg } from './i18n.ts';

export type PhaseKind = 'analisi' | 'implementazione' | 'test' | 'revisione' | 'approvazione' | 'server' | 'personalizzata';

/** Fasi eseguite da un agente (le altre sono gestite da Regia: approvazione umana, server locale). */
export const isAgentKind = (k: PhaseKind) => k !== 'approvazione' && k !== 'server';
export type ContextMode = 'sintesi' | 'completo' | 'nessuno';

export interface PhaseConfig {
  label: string;
  kind: PhaseKind;
  /** Ruolo dell'agente, aggiunto al prompt di sistema. */
  role: string;
  /** Istruzioni operative della fase (per l'approvazione: cosa deve verificare la persona). */
  instructions: string;
  /** Alias ('haiku', 'sonnet', 'opus') o id completo; vuoto = modello predefinito della CLI. */
  model: string;
  allowedTools: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Quanto dei risultati delle fasi precedenti passare come contesto. */
  contextMode: ContextMode;
  /** Riusa il risultato di un'esecuzione precedente se configurazione, input e file del progetto non sono cambiati. */
  reuseResult: boolean;
  /** Skill di Claude Code utilizzabili dalla fase: 'all' tutte quelle disponibili, oppure gli id scelti. Assente = nessuna. */
  skills?: 'all' | string[];
  /** Solo fase "server" (Avvio app): comando da avviare (es. npm run dev, dotnet run, flutter run). Vuoto = solo verifica dell'indirizzo. */
  command?: string;
  /** Solo fase "server": come capire che l'app è pronta. Assente = 'url'. */
  readyCheck?: ReadyCheck;
  /** Solo fase "server" con readyCheck 'output': testo (o /espressione/) atteso in una riga dell'output. */
  readyPattern?: string;
  /** Solo fase "server": URL da controllare ('url') o da mostrare come link; se vuoto si usa il primo indirizzo locale stampato. */
  url?: string;
  /** Solo fase "server": sottocartella del progetto in cui avviare il comando. */
  subdir?: string;
  /** Solo fase "server": secondi di attesa prima di considerare fallito l'avvio. */
  readyTimeoutSec?: number;
  /** Solo fase "server": versione di Node da usare (es. 24, 22.23); vuoto = automatica da .nvmrc / engines. */
  nodeVersion?: string;
}

export type ServiceStatus = 'avvio' | 'attivo' | 'fermato' | 'terminato' | 'errore' | 'simulato' | 'completato';

/**
 * Come la fase "Avvio app" capisce che l'app è pronta:
 * - url: un indirizzo risponde (web, API, sito su IIS o in un container);
 * - output: compare un testo nell'output (emulatori, build in modalità watch, app mobile);
 * - process: il programma resta aperto qualche secondo (app desktop);
 * - exit: il comando termina con codice 0 (build, installazione su un dispositivo, deploy locale).
 */
export type ReadyCheck = 'url' | 'output' | 'process' | 'exit';
export const READY_CHECKS: readonly ReadyCheck[] = ['url', 'output', 'process', 'exit'];

export interface ServiceState {
  command: string;
  cwd: string;
  url?: string;
  pid?: number;
  status: ServiceStatus;
  startedAt: string;
  exitCode?: number | null;
  /** Ultime righe di output (oscurate da eventuali segreti). */
  log: string[];
  /** Versione di Node usata per il comando. */
  node?: string;
  readyCheck?: ReadyCheck;
  /** Nessun comando: Regia verifica soltanto un servizio già attivo (es. IIS) e non lo avvia né lo ferma. */
  external?: boolean;
}

export interface WorkflowNode {
  id: string;
  position: { x: number; y: number };
  data: PhaseConfig;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
}

export interface WorkflowSettings {
  /** Cartella su cui lavorano gli agenti (cwd). */
  projectDir: string;
  /** Obiettivo generale, incluso nel prompt di ogni fase. */
  goal: string;
  /** Limite di spesa stimata per esecuzione, in USD. */
  runBudgetUsd?: number;
  maxParallel: number;
  /** Carica CLAUDE.md e .claude/settings.json del progetto. */
  loadProjectSettings: boolean;
  /** Aggiunge le regole generali (~/.claude/CLAUDE.md e regole di Regia) alle istruzioni di ogni agente. Assente = sì. */
  applyGeneralRules?: boolean;
  /** Lingua delle istruzioni inviate agli agenti (protocollo di risposta, regole). Assente = it. */
  language?: string;
  /** Dove cercare le skill: progetto (.claude/skills, predefinito) e personali (~/.claude/skills, da attivare). */
  skillSources?: { project?: boolean; personal?: boolean };
  /** Principi di progettazione seguiti dal workflow (es. kiss, yagni): le fasi ne ricevono le indicazioni. Assente = nessuno. */
  principles?: string[];
  /**
   * All'avvio si sceglie un'esecuzione precedente (es. la funzionalità da allineare con develop):
   * il suo resoconto viene passato a tutte le fasi. Assente = no.
   */
  referenceRun?: boolean;
}

/** Esecuzione precedente su cui lavora un'esecuzione: il resoconto è fotografato all'avvio. */
export interface RunReference {
  runId: string;
  workflowName: string;
  startedAt: string;
  status: RunStatus;
  /** Resoconto compatto (obiettivo, risultati, decisioni, file modificati, interventi) passato agli agenti. */
  text: string;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  goalHint: string;
  settings: Partial<WorkflowSettings>;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface RulesInfo {
  /** Regole personali di Claude Code (sola lettura, lette a ogni esecuzione). */
  global: { path: string; exists: boolean; text: string };
  /** Regole di Regia, modificabili dall'interfaccia. */
  regia: { path: string; text: string };
  /** CLAUDE.md del progetto, se richiesto con projectDir. */
  project?: { path: string; exists: boolean; text: string };
}

export interface AppliedRules {
  applied: boolean;
  globalPath?: string;
  global?: string;
  regia?: string;
  /** Percorso del CLAUDE.md di progetto caricato dalla CLI, se presente. */
  projectPath?: string;
}

export interface FolderInfo {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  git?: { isRepo: boolean; branch?: string; pendingChanges?: number };
  claudeMd: boolean;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  /** Gruppo (es. il progetto) in cui il workflow compare nell'elenco. Vuoto = senza gruppo. */
  group?: string;
  settings: WorkflowSettings;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  updatedAt: string;
}

export interface ValidationIssue {
  level: 'errore' | 'avviso';
  /** Testo di riserva (lingua del server). */
  message: string;
  /** Messaggio localizzabile. */
  msg?: Msg;
  nodeId?: string;
}

// ---------- Esecuzione ----------

export type RunMode = 'prova' | 'reale';
export type NodeStatus =
  | 'in_attesa'
  | 'attiva'
  | 'completata'
  | 'fallita'
  | 'bloccata'
  | 'attesa_intervento'
  | 'saltata'
  | 'riusata';
/**
 * sospesa: fermata dalla persona con Sospendi; interrotta: Regia è stato chiuso (o il PC spento) mentre era attiva.
 * Entrambe si possono riprendere con Riprendi.
 */
export type RunStatus = 'in_corso' | 'attesa_intervento' | 'completata' | 'fallita' | 'annullata' | 'interrotta' | 'sospesa';

/** Esecuzioni che si possono riprendere. */
export const RESUMABLE: readonly RunStatus[] = ['sospesa', 'interrotta'];

export interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number;
  /** 'list' | 'managed' | 'unknown' | 'simulato' */
  costBasis?: string;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  /** Stima del SDK (o simulata). null = non disponibile. */
  costUsd: number | null;
  byModel: Record<string, ModelUsageEntry>;
}

/**
 * Da dove proviene il dato dei consumi di un tentativo:
 * - risultato: messaggio `result` del SDK (modelUsage, include subagenti)
 * - delta_ripresa: sessione ripresa, sottratti i totali già contati
 * - parziale: nessun result (crash/annullamento), solo input/cache del ciclo principale
 * - riusato: risultato riusato, nessuna chiamata
 */
export type UsageSource = 'risultato' | 'delta_ripresa' | 'parziale' | 'riusato' | 'nessuno';

export interface DeclaredOutcome {
  esito: 'ok' | 'ko' | 'bloccato';
  sintesi: string;
  decisioni: string[];
}

export interface Attempt {
  id: string;
  nodeId: string;
  index: number;
  reason: 'iniziale' | 'riprova' | 'ripresa_con_feedback' | 'dopo_correzione' | 'riuso' | 'ripresa_dopo_interruzione';
  startedAt: string;
  endedAt?: string;
  /** interrotta: fermato da una sospensione o dalla chiusura di Regia; la fase riparte con Riprendi. */
  status: 'attiva' | 'ok' | 'errore' | 'annullata' | 'interrotta';
  sessionId?: string;
  resumedSessionId?: string;
  /** Correzione richiesta dalla persona che il tentativo applica (ripresa con feedback, o sua ripresa dopo un'interruzione). */
  feedback?: string;
  models: string[];
  usage: UsageTotals;
  usageSource: UsageSource;
  /** Contatori live (solo ciclo principale, deduplicati per message.id). */
  live: { inputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number; steps: number; duplicatesSkipped: number; subagentMessages: number };
  numTurns?: number;
  durationMs?: number;
  durationApiMs?: number;
  toolCalls: { name: string; key: string }[];
  subagents: number;
  resultSubtype?: string;
  resultText?: string;
  declared?: DeclaredOutcome;
  error?: string;
  reusedFrom?: { runId: string; attemptId: string };
  /** Totali cumulativi della sessione dopo questo tentativo (per contare solo la differenza se viene ripresa). */
  sessionCumulative?: { costUsd: number; byModel: Record<string, ModelUsageEntry> };
  apiKeySource?: string;
}

export interface NodeRunState {
  nodeId: string;
  status: NodeStatus;
  activity?: string;
  lastDecision?: string;
  attempts: Attempt[];
  /** Testo passato alle fasi successive. */
  output?: string;
  /** Azioni che la persona può compiere quando status = attesa_intervento. */
  pendingActions?: HumanAction[];
  pendingReason?: string;
  /** Motivo dell'intervento, localizzabile (pendingReason resta come testo di riserva). */
  pendingMsg?: Msg;
  feedbackRounds: number;
  /** Solo fase "server": processo gestito da Regia. */
  service?: ServiceState;
  /** Fase agente fermata a metà (sospensione o chiusura di Regia): da dove riprenderla. */
  interrupted?: InterruptedWork;
}

export interface InterruptedWork {
  /** Tentativo interrotto. */
  attemptId: string;
  /** Sessione dell'agente, se era già stata aperta. */
  sessionId?: string;
  /** Correzione che il tentativo stava applicando (ripresa con feedback). */
  feedback?: string;
  /** Ultima attività registrata della sessione: dice se la cache del prompt è ancora valida. */
  lastActivityAt: string;
}

/** Stato git della cartella del progetto in un dato momento. */
export interface GitState {
  branch?: string;
  head?: string;
  at: string;
}

/** Controllo prima di riprendere: ramo e commit registrati e quelli attuali. */
export interface ResumeCheck {
  before?: GitState;
  now?: GitState;
  branchChanged: boolean;
  headChanged: boolean;
}

export type HumanAction = 'approva' | 'respingi' | 'riprova' | 'riprendi' | 'salta' | 'annulla' | 'installa_node' | 'installa_dipendenze';

export type EventKind =
  | 'run'
  | 'fase'
  | 'testo'
  | 'decisione'
  | 'strumento'
  | 'esito_strumento'
  | 'subagente'
  | 'consumi'
  | 'risultato'
  | 'errore'
  | 'intervento'
  | 'limite'
  | 'servizio';

export interface RunEvent {
  seq: number;
  ts: string;
  nodeId?: string;
  attemptId?: string;
  kind: EventKind;
  /** Testo di riserva, o testo prodotto da agenti e strumenti (non tradotto). */
  text: string;
  /** Messaggio localizzabile generato da Regia. */
  msg?: Msg;
  /** Per le decisioni: dichiarata dall'agente o dedotta da un evento osservabile. */
  source?: 'dichiarata' | 'osservata';
  subagent?: boolean;
}

export interface Run {
  id: string;
  workflowId: string;
  workflowName: string;
  /** Copia del workflow al momento dell'avvio, per confronti. */
  snapshot: Workflow;
  mode: RunMode;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  budgetUsd?: number;
  nodes: Record<string, NodeRunState>;
  events: RunEvent[];
  totals: UsageTotals;
  notes: string[];
  rules?: AppliedRules;
  /** Esecuzione da cui sono state riprese le fasi già completate. */
  continuedFrom?: string;
  /** Esecuzione di riferimento scelta all'avvio (workflow con referenceRun). */
  reference?: RunReference;
  /** Ultima sospensione o interruzione. */
  suspendedAt?: string;
  /** Ramo e commit del progetto, aggiornati alla fine di ogni fase e alla sospensione. */
  git?: GitState;
  rateLimit?: { status: string; type?: string; utilization?: number; resetsAt?: number };
}

export interface RunSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  mode: RunMode;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  costUsd: number | null;
}

export interface Insight {
  id: string;
  severity: 'alta' | 'media' | 'info';
  nodeId?: string;
  title: Msg;
  evidence: Msg;
  suggestion: Msg;
  tradeoff: Msg;
}

/** Corpo di una risposta di errore dell'API. */
export interface ApiErrorBody {
  error: string;
  msg?: Msg;
  issues?: ValidationIssue[];
}

/** Versione di Regia in uso e, se raggiungibile, ultima versione pubblicata sul repository. */
export interface VersionInfo {
  current: string;
  latest?: string;
  updateAvailable: boolean;
  repoUrl?: string;
}

export interface EnvInfo {
  sdkVersion: string;
  claudeCodeVersion?: string;
  auth: {
    loggedIn: boolean;
    authMethod?: string;
    apiProvider?: string;
    subscriptionType?: string;
    apiKeyEnv: boolean;
    error?: string;
  };
  realRunsEnabled: boolean;
  dataDir: string;
  globalRulesPath: string;
}

export const KNOWN_TOOLS = [
  'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'TodoWrite',
] as const;

export const WRITE_TOOLS = ['Edit', 'Write', 'Bash', 'NotebookEdit'];

export function emptyTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUsd: 0, byModel: {} };
}

export interface ContinuationPlan {
  fromRunId: string;
  reused: { nodeId: string; label: string }[];
  toRun: { nodeId: string; label: string; reason: string; reasonMsg?: Msg }[];
}

/** Skill di Claude Code trovata da Regia. */
export interface SkillInfo {
  /** "<fonte>:<nome>", stabile tra le esecuzioni. */
  id: string;
  name: string;
  description: string;
  source: 'progetto' | 'personale';
  /** Cartella che contiene SKILL.md. */
  path: string;
}
