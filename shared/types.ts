// Tipi condivisi tra server e interfaccia.
import type { Msg } from './i18n.ts';
import type { PermissionLevel } from './permissions.ts';
export type { Msg } from './i18n.ts';

export type PhaseKind = 'analisi' | 'implementazione' | 'test' | 'revisione' | 'collaudo' | 'approvazione' | 'server' | 'personalizzata';

/** Indirizzi delle user story aggiuntive compilati (le righe vuote non contano). */
export const extraStoryUrls = (s: { extraStories?: string[] }): string[] => (s.extraStories ?? []).map((x) => x.trim()).filter(Boolean);

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
  /**
   * Solo fase "server": mostra il risultato senza configurazione. Se presente, Regia riconosce il progetto
   * (e il dispositivo o il browser) e compone da sé comando e criterio di pronto: command e readyCheck non servono.
   */
  show?: ShowConfig;
  /**
   * Solo fase di revisione "Punti della PR": legge i commenti di una pull request e li propone come punti.
   * URL vuoto = l'URL indicato nell'obiettivo del workflow.
   */
  pr?: { url: string };
  /**
   * Solo fase di analisi "Criteri di accettazione": dalla user story collegata ricava gli acceptance criteria, li
   * confronta con quelli già presenti e segnala le specifiche mancanti; Regia ne fa una pagina HTML da copiare.
   */
  criteriAccettazione?: boolean;
}

/** Dove mostrare il risultato: sul telefono (APK o build iOS), nel browser, come app desktop. */
export type ShowTarget = 'dispositivo' | 'browser' | 'desktop';
export const SHOW_TARGETS: readonly ShowTarget[] = ['dispositivo', 'browser', 'desktop'];

export type MobilePlatform = 'android' | 'ios';
export type MobileBuild = 'debug' | 'release';
export type BrowserChoice = 'chrome' | 'edge' | 'firefox' | 'safari';

/** Scelte facoltative della fase "mostra": ciò che manca è deciso automaticamente. */
export interface ShowConfig {
  target: ShowTarget;
  /** Dispositivo: piattaforma da usare quando il progetto ne ha più di una. */
  platform?: MobilePlatform;
  /** Dispositivo: id (seriale adb, UDID, id di flutter devices); vuoto = il primo collegato, preferendo uno fisico. */
  device?: string;
  /** Dispositivo: tipo di build; vuoto = quella che funziona da sola sul telefono. */
  build?: MobileBuild;
  /** Browser in cui aprire la pagina; vuoto = quello predefinito del sistema. */
  browser?: BrowserChoice;
  /** Browser: non avviare niente, aprire soltanto l'indirizzo (url) di un sito già attivo, ad esempio su IIS. */
  existing?: boolean;
  /** Browser: non avviare il backend trovato accanto al frontend (es. be/ con fe/). */
  noCompanion?: boolean;
  /** Solo collaudo: niente schermo del telefono dal vivo. */
  noMirror?: boolean;
  /** Solo collaudo: lo schermo anche in una finestra separata di scrcpy (se installato). */
  mirrorWindow?: boolean;
}

export interface MobileDevice {
  id: string;
  name: string;
  platform: MobilePlatform;
  emulator: boolean;
}

/** Esito del rilevamento: progetto, comando che verrà eseguito (o il motivo per cui manca) e come capire che è pronto. */
export interface LaunchPlan {
  target: ShowTarget;
  /** Cartella del progetto, relativa alla cartella della fase ('' = la stessa). */
  dir: string;
  /** Tecnologia riconosciuta, come nome da mostrare (es. "Flutter", "Vite", "ASP.NET Core"). */
  project?: string;
  command?: string;
  check: ReadyCheck;
  /** Con check 'output': testo (o /espressione/) che indica che l'app è pronta. */
  readyPattern?: string;
  /** Indirizzo noto in anticipo (sito già attivo, file statico, porta predefinita); altrimenti letto dall'output. */
  url?: string;
  /** Variabili d'ambiente aggiunte al comando (es. ANDROID_SERIAL). */
  env?: Record<string, string>;
  /** Perché non è possibile procedere: progetto non riconosciuto, nessun dispositivo… */
  problem?: Msg;
  /** Avvisi che non bloccano. */
  notes: Msg[];
  /** Solo browser: il backend trovato accanto al frontend, avviato insieme se enabled. */
  companion?: { dir: string; project: string; command: string; enabled: boolean };
  /** Solo dispositivo. */
  platforms?: MobilePlatform[];
  devices?: MobileDevice[];
  device?: MobileDevice;
  platform?: MobilePlatform;
  /** Android: applicationId dell'app, se rilevato. */
  appId?: string;
  build?: MobileBuild;
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
  /** File del log di diagnosi in data/logs/<esecuzione>/: tutto l'output con i tempi, le pause e i processi attivi. */
  trace?: string;
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
  maxParallel: number;
  /** Carica CLAUDE.md e .claude/settings.json del progetto. */
  loadProjectSettings: boolean;
  /** Aggiunge le regole generali (~/.claude/CLAUDE.md e regole di Regia) alle istruzioni di ogni agente. Assente = sì. */
  applyGeneralRules?: boolean;
  /** Lingua delle istruzioni inviate agli agenti (protocollo di risposta, regole). Assente = it. */
  language?: string;
  /** Dove cercare le skill: progetto (.claude/skills e .agents/skills, predefinito) e personali (~/.claude/skills, da attivare). */
  skillSources?: { project?: boolean; personal?: boolean };
  /** Cartelle (percorsi assoluti) in cui le fasi possono leggere e scrivere oltre a quella del progetto. */
  extraDirs?: string[];
  /** URL della user story collegata (work item di Azure DevOps o issue di GitHub): letta a ogni esecuzione. */
  story?: string;
  /** Altre user story collegate (es. più US coperte dalla stessa PR): lette e passate agli agenti come la principale. */
  extraStories?: string[];
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

/** Priorità di un punto di revisione: alta per bug e correzioni importanti, bassa per suggerimenti minori. */
export type PointPriority = 'alta' | 'bassa';

export interface DeclaredOutcome {
  esito: 'ok' | 'ko' | 'bloccato';
  sintesi: string;
  decisioni: string[];
  /** Solo revisioni: modifiche concrete proposte, una per voce, da scegliere nell'approvazione. */
  punti?: string[];
  /** Priorità di ciascun punto, nello stesso ordine di `punti` (prima tutti quelli ad alta priorità). */
  priorita?: PointPriority[];
  /** Solo "Punti della PR": commenti già sistemati nel codice o risolti sulla PR, esclusi dai punti. */
  sistemati?: string[];
  /** Punti in contrasto con la user story, nello stesso ordine di `punti`: la correzione non li applica. */
  contrastoUs?: boolean[];
  /** Solo "Punti della PR": risposte preparate per i commenti già sistemati o in contrasto con la US, da confermare una per una. */
  risposte?: PrReply[];
  /** Punti oltre il limite: non vanno nella checklist, sono riportati in un evento. */
  puntiOmessi?: string[];
  /** Fase ferma per un permesso che non ha: cosa le servirebbe. */
  permesso?: PermissionLevel;
  /** Fase ferma perché deve lavorare fuori dalle cartelle consentite: la cartella che le servirebbe. */
  cartella?: string;
  /** Solo collaudi: scenari che non si possono verificare in automatico (hardware, biometria…), da provare a mano. */
  manuali?: string[];
  /** Solo fase "Criteri di accettazione": criteri proposti, confronto con quelli della user story, specifiche mancanti. */
  criteri?: AcceptanceCriteria;
}

/** Criterio proposto rispetto a quelli già nella user story: nuovo, già coperto, diverso, oppure da confermare (mancano specifiche). */
export type CriterionStatus = 'nuovo' | 'coperto' | 'diverso' | 'da_confermare';

/** Acceptance criterion proposto dalla fase "Criteri di accettazione". */
export interface AcceptanceCriterion {
  /** AC1, AC2… */
  id: string;
  /** Frase verificabile: "Quando…, allora…". */
  testo: string;
  stato: CriterionStatus;
  /** Punto della descrizione (o del codice) da cui nasce. */
  origine?: string;
  /** Criterio della user story a cui corrisponde, se c'è. */
  acUs?: string;
  nota?: string;
}

/** Valutazione di un criterio già scritto nella user story. */
export type StoryCriterionVerdict = 'ok' | 'vago' | 'non_verificabile' | 'in_contrasto' | 'non_coperto';

export interface StoryCriterionReview { testo: string; valutazione: StoryCriterionVerdict; nota?: string }

/** Specifica che manca nella user story per fissare un criterio: la domanda da fare a chi l'ha scritta. */
export interface SpecGap { argomento: string; domanda: string; criteri?: string[] }

/** Risultato della fase "Criteri di accettazione". */
export interface AcceptanceCriteria {
  proposti: AcceptanceCriterion[];
  /** Criteri già presenti nella user story, valutati uno per uno. */
  esistenti: StoryCriterionReview[];
  note: SpecGap[];
}

/** Punti proposti da una fase a monte, mostrati come checklist nell'approvazione. */
export interface ReviewPoints {
  nodeId: string;
  label: string;
  items: string[];
  /** Priorità di ciascun punto, nello stesso ordine di `items`; assente nelle esecuzioni precedenti (vale alta). */
  priorities?: PointPriority[];
  /**
   * Punti da portare avanti (fase "Punti della PR"): quelli scelti passano con Approva alle fasi successive,
   * invece di tornare con Respingi a una fase precedente.
   */
  forward?: boolean;
  /** Solo "Punti della PR": commenti già sistemati, mostrati a parte (non si scelgono). */
  resolved?: string[];
  /** Punti in contrasto con la user story (stesso ordine di `items`): evidenziati, e non verranno applicati. */
  conflicts?: boolean[];
  /** Punti oltre il limite, non mostrati. */
  omitted?: number;
}

/** Punto scelto da chi approva: indice in ReviewPoints.items della fase indicata. */
export interface PointRef {
  nodeId: string;
  index: number;
}

export interface Attempt {
  id: string;
  nodeId: string;
  index: number;
  reason: 'iniziale' | 'riprova' | 'ripresa_con_feedback' | 'dopo_correzione' | 'riuso' | 'ripresa_dopo_interruzione' | 'domanda' | 'proseguimento';
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
  /** Solo collaudi: il passo di build e installazione, gestito da Regia senza agente (non conta come tentativo). */
  step?: 'build';
}

/** Domanda di chiarimento fatta da chi approva a una fase già completata: risponde senza modificare nulla. */
export interface PhaseQuestion {
  id: string;
  /** Fase a cui è rivolta. */
  targetId: string;
  question: string;
  answer?: string;
  status: 'in_corso' | 'risposta' | 'errore';
  error?: string;
  askedAt: string;
  /** Giro di approvazione (feedbackRounds) in cui è stata fatta: la card mostra solo quelle del giro corrente. */
  round: number;
  /** Sessione della conversazione (copia di quella della fase): le domande successive la continuano. */
  sessionId?: string;
  /** Consumi della risposta, contati nei totali dell'esecuzione. */
  attempt: Attempt;
}

/** Collaudo in corso o concluso: cartella delle prove, screenshot e quanto emerso dal log dell'app. */
export interface UatState {
  /** Giro di collaudo (1, 2… dopo ogni correzione): le prove di ogni giro restano separate. */
  round: number;
  device?: string;
  appId?: string;
  screenshots: string[];
  /** Lo schermo del telefono è trasmesso dal vivo alla pagina (/api/runs/<id>/mirror/<fase>). */
  live?: boolean;
  /** Log dell'app registrato da Regia durante il collaudo (solo Android). */
  log?: { lines: number; errors: number; crashes: string[] };
}

/** scrcpy per il mirror dello schermo: dove si trova o come installarlo. */
export interface ScrcpyStatus {
  installed: boolean;
  path?: string;
  /** regia: copia scaricata da Regia in data/tools; path: già installato nel sistema. */
  source?: 'regia' | 'path';
  version?: string;
  /** Se manca: download dello zip ufficiale (Windows), Homebrew (macOS) o installazione a mano. */
  install?: 'download' | 'brew' | 'manual';
}

/** Segnalazione di errore inviata (con il consenso) al servizio di raccolta; la copia locale ha anche lo stato dell'invio. */
export interface ErrorReport {
  v: 1;
  /** Identificativo casuale dell'installazione: raggruppa le segnalazioni senza dire chi è. */
  install: string;
  regia: string;
  os?: string;
  node?: string;
  lang?: string;
  /** fase: errore di una fase in un'esecuzione reale; server: errore interno; ui: errore dell'interfaccia. */
  source: 'fase' | 'server' | 'ui';
  key?: string;
  kind?: string;
  message: string;
  detail?: string;
  at: string;
  sent?: boolean;
  sentAt?: string;
  /** Il servizio ha rifiutato il formato: non si ritenta. */
  rejected?: boolean;
}

export interface ReportsInfo {
  /** Scelta della persona; assente finché non ha risposto (e allora non si invia nulla). */
  consent?: 'si' | 'no';
  /** REGIA_REPORTS=0: segnalazioni disattivate per tutti. */
  disabled: boolean;
  endpoint: string;
  /** Ultime segnalazioni, con il contenuto esatto inviato. */
  reports: ErrorReport[];
}

/** Immagine di una user story, scaricata nella cartella della lettura. */
export interface StoryImage {
  /** Numero del segnaposto nel testo ("[immagine n: nome]"). */
  n: number;
  name: string;
  file: string;
  source: 'descrizione' | 'criteri' | 'commento' | 'allegato';
}

/** User story letta dall'URL: testo semplice e immagini, come la vedono gli agenti. */
export interface UserStory {
  url: string;
  provider: 'azure' | 'github';
  id: string;
  type?: string;
  title: string;
  state?: string;
  description: string;
  acceptance?: string;
  comments?: { author?: string; at?: string; text: string }[];
  images: StoryImage[];
  /** Immagini trovate nel testo e negli allegati (alcune possono non essere scaricate: limiti o accesso). */
  imagesFound: number;
  fetchedAt: string;
  /** Cartella della lettura, relativa a data/stories. */
  dir: string;
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
  /** Solo approvazioni in attesa: punti proposti dalle fasi che un respingi farebbe rieseguire. */
  reviewPoints?: ReviewPoints[];
  /** Fase ferma: il permesso chiesto dall'agente, concedibile con l'azione "consenti". */
  missingPermission?: PermissionLevel;
  /** Fase ferma: la cartella esterna chiesta dall'agente, concedibile con l'azione "consenti_cartella". */
  missingDir?: string;
  /** Solo "Punti della PR" senza URL: PR trovata dal branch corrente, in attesa di conferma ("conferma_pr"). */
  detectedPr?: DetectedPr;
  /** Solo "Punti della PR" senza URL: URL della PR confermata, usato anche nei giri successivi. */
  prUrl?: string;
  /** Solo "Punti della PR": risposte pubblicate (o fallite), per indice in declared.risposte dell'ultimo tentativo. */
  prReplies?: Record<number, PrReplyState>;
  /** Solo approvazioni in attesa: fasi a cui si può fare una domanda (con agente, completate, con una sessione). */
  askable?: { nodeId: string; label: string }[];
  /** Solo approvazioni: domande di chiarimento fatte alle fasi precedenti, con le risposte. */
  questions?: PhaseQuestion[];
  /** Solo collaudi: screenshot e log dell'app dell'ultimo giro. */
  uat?: UatState;
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

export type HumanAction = 'approva' | 'respingi' | 'consenti' | 'consenti_cartella' | 'conferma_pr' | 'procedi' | 'riprova' | 'riprendi' | 'salta' | 'annulla' | 'installa_node' | 'installa_dipendenze';

/** Risposta a un commento della PR, preparata dall'agente e pubblicata da Regia solo dopo la conferma della persona. */
export interface PrReply {
  /** Perché si risponde: il commento è già sistemato nel codice, oppure chiede qualcosa in contrasto con la user story. */
  motivo: 'sistemato' | 'contrasto';
  /** Di quale commento si tratta (gravità, file e riga), per riconoscerlo. */
  riferimento: string;
  /** Testo proposto per la risposta. */
  testo: string;
  /** Id GraphQL della discussione a cui rispondere; assente = commento generale sulla PR. */
  thread?: string;
}

/** Discussione della PR a cui andrebbe una risposta, verificata su GitHub. */
export interface PrThreadInfo {
  ok: boolean;
  /** Perché non si può rispondere (discussione inesistente o di un'altra PR). */
  reason?: Msg;
  path?: string;
  line?: number;
  resolved?: boolean;
  /** Autore e inizio del primo commento della discussione: il commento a cui si risponde. */
  author?: string;
  excerpt?: string;
  url?: string;
}

/** Account di gh che pubblicherebbe e discussioni di destinazione, per id GraphQL. */
export interface PrReplyContext {
  account?: string;
  accountError?: Msg;
  threads: Record<string, PrThreadInfo>;
}

/** Esito della pubblicazione di una risposta sulla PR. */
export interface PrReplyState {
  status: 'pubblicata' | 'errore';
  at: string;
  /** Testo effettivamente pubblicato (quello confermato, eventualmente modificato). */
  body?: string;
  /** Account di GitHub con cui è stata pubblicata. */
  account?: string;
  url?: string;
  error?: string;
}

/** Pull request trovata dal branch corrente del progetto. */
export interface DetectedPr {
  url: string;
  title: string;
  branch: string;
  number?: number;
}

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
  /** User story collegata, letta all'avvio; storyError se non è stato possibile leggerla. */
  story?: UserStory;
  storyError?: Msg;
  /** User story aggiuntive lette all'avvio, e quelle che non è stato possibile leggere. */
  extraStories?: UserStory[];
  extraStoryErrors?: { url: string; error: Msg }[];
  mode: RunMode;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
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
