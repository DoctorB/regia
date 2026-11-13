// Segnalazioni di errore, solo con il consenso di chi usa Regia.
// - Consenso: chiesto una volta nell'interfaccia; finché non c'è non si invia nulla. REGIA_REPORTS=0 disattiva tutto.
// - Contenuto: versione di Regia, sistema, Node, lingua, fonte (fase, server, interfaccia), chiave e testo dell'errore,
//   qualche riga di contesto. Mai codice, prompt, testi degli agenti, screenshot o log dell'app.
// - Anonimizzazione: percorsi del progetto e della cartella utente, nome utente e segreti (redact) sostituiti.
// - Invio: copia locale in data/reports/, poi POST al servizio (trace.lucabottani.dev); senza rete si riprova più tardi.
//   Lo stesso errore non si rimanda prima di 24 ore.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ErrorReport, ReportsInfo } from '../shared/types.ts';
import { redact } from './redact.ts';
import { DATA_DIR, ROOT, listWorkflows } from './store.ts';

const DIR = path.join(DATA_DIR, 'reports');
const SETTINGS = path.join(DIR, 'settings.json');
const DAY = 24 * 3600 * 1000;
const KEEP_LOCAL = 100;
const url = () => process.env.REGIA_REPORTS_URL || 'https://trace.lucabottani.dev/api/regia/report';
const disabled = () => process.env.REGIA_REPORTS === '0';
const version = (() => {
  try { return (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version; } catch { return '?'; }
})();

interface Settings { consent?: 'si' | 'no'; install?: string; sent?: Record<string, number> }

function readSettings(): Settings {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) as Settings; } catch { return {}; }
}
function writeSettings(s: Settings) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
}

/** Cartelle dei progetti (e cartelle aggiuntive) dei workflow, dalle più lunghe: nei testi diventano "<progetto>". */
function projectDirs(): string[] {
  let dirs: string[] = [];
  try { dirs = listWorkflows().flatMap((w) => [w.settings.projectDir, ...(w.settings.extraDirs ?? [])]); } catch { /* nessun workflow */ }
  return [...new Set(dirs.filter((d) => d && path.isAbsolute(d)).map((d) => d.replace(/[\\/]+$/, '')))].sort((a, b) => b.length - a.length);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Varianti di un percorso: con "\" e con "/", senza distinzione di maiuscole. */
const pathPattern = (p: string) => new RegExp([p, p.replace(/\\/g, '/')].map(escape).join('|'), 'gi');

/** Toglie dal testo ciò che identifica la persona o il progetto: percorsi, nome utente, segreti. */
export function anonymize(text: string): string {
  let t = redact(text);
  for (const d of projectDirs()) t = t.replace(pathPattern(d), '<progetto>');
  t = t.replace(pathPattern(DATA_DIR), '<dati>');
  t = t.replace(pathPattern(ROOT), '<regia>');
  t = t.replace(pathPattern(os.homedir()), '~');
  const user = os.userInfo().username;
  if (user.length >= 3) t = t.replace(new RegExp(`\\b${escape(user)}\\b`, 'gi'), '<utente>');
  // Indirizzi delle user story: dicono organizzazione e progetto.
  t = t.replace(/https?:\/\/(?:[\w-]+\.visualstudio\.com|dev\.azure\.com)\/\S+/gi, '<work-item>').replace(/https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/gi, '<issue>');
  // Indirizzi email rimasti (es. account mostrati in un messaggio).
  return t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');
}

export function reportsInfo(): ReportsInfo {
  const s = readSettings();
  return { consent: s.consent, disabled: disabled(), endpoint: url(), reports: listLocal() };
}

export function setConsent(consent: 'si' | 'no') {
  const s = readSettings();
  s.consent = consent;
  s.install ??= randomUUID();
  writeSettings(s);
  if (consent === 'si') void flush();
}

function listLocal(): ErrorReport[] {
  try {
    return fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'settings.json').sort().reverse().slice(0, 50)
      .map((f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as ErrorReport);
  } catch { return []; }
}

export interface ReportInput {
  source: ErrorReport['source'];
  key?: string;
  kind?: string;
  lang?: string;
  message: string;
  detail?: string;
}

/** Firma dell'errore per non rimandarlo più volte: chiave e testo senza numeri (porte, PID, durate cambiano ogni volta). */
const signature = (r: ReportInput) => createHash('sha256').update(`${r.source}|${r.key ?? ''}|${r.message.replace(/\d+/g, '#').slice(0, 300)}`).digest('hex').slice(0, 16);

/** Registra e invia una segnalazione, se c'è il consenso. Non lancia mai errori: Regia non deve fermarsi per questo. */
export function report(input: ReportInput): void {
  try {
    if (disabled()) return;
    const s = readSettings();
    if (s.consent !== 'si') return;
    const sig = signature(input);
    const now = Date.now();
    s.sent = Object.fromEntries(Object.entries(s.sent ?? {}).filter(([, at]) => now - at < DAY));
    if (s.sent[sig]) return;
    s.sent[sig] = now;
    s.install ??= randomUUID();
    writeSettings(s);
    const r: ErrorReport = {
      v: 1,
      install: s.install,
      regia: version,
      os: `${process.platform} ${os.release()}`,
      node: process.version,
      lang: input.lang,
      source: input.source,
      key: input.key,
      kind: input.kind,
      message: anonymize(input.message).slice(0, 2000),
      detail: input.detail ? anonymize(input.detail).slice(-8000) : undefined,
      at: new Date(now).toISOString(),
      sent: false,
    };
    const file = path.join(DIR, `${r.at.replace(/[:.]/g, '-')}-${sig}.json`);
    fs.writeFileSync(file, JSON.stringify(r, null, 2));
    prune();
    void send(file);
  } catch { /* mai bloccante */ }
}

async function send(file: string): Promise<boolean> {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8')) as ErrorReport;
    if (r.sent) return true;
    const { sent, sentAt, ...body } = r;
    void sent; void sentAt;
    const res = await fetch(url(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    // 400: il servizio rifiuta il formato; non ha senso riprovare.
    if (res.ok || res.status === 400) {
      r.sent = res.ok;
      r.sentAt = new Date().toISOString();
      if (!res.ok) r.rejected = true;
      fs.writeFileSync(file, JSON.stringify(r, null, 2));
      return res.ok;
    }
  } catch { /* senza rete: si riprova */ }
  return false;
}

/** Invia le segnalazioni rimaste in coda (all'avvio, ogni tanto e quando si dà il consenso). */
export async function flush(): Promise<void> {
  if (disabled() || readSettings().consent !== 'si') return;
  let files: string[] = [];
  try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'settings.json').sort(); } catch { return; }
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as ErrorReport;
      if (!r.sent && !r.rejected) await send(path.join(DIR, f));
    } catch { /* file illeggibile: si ignora */ }
  }
}

function prune() {
  try {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== 'settings.json').sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_LOCAL))) fs.rmSync(path.join(DIR, f), { force: true });
  } catch { /* niente da fare */ }
}
