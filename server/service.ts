// Processi locali gestiti da Regia (fase "server"): avvio, rilevamento dell'indirizzo, controllo di
// disponibilità, arresto dell'intero albero di processi e pulizia alla chiusura di Regia.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { redact } from './redact.ts';

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// Solo caratteri validi in un URL: si ferma a spazi, virgolette, backslash e simboli di impaginazione (es. "┃").
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?(?:\/[A-Za-z0-9\-._~%!$&*+,;=:@/?#]*)?/i;
const MAX_LOG = 300;

/**
 * Normalizza una riga di output: molti strumenti (Astro, Vite, pino…) quando non sono collegati a un terminale
 * scrivono log JSON con il testo in "message" e "a capo" codificati. Restituisce righe leggibili.
 */
export function outputLines(raw: string): string[] {
  const line = raw.replace(ANSI, '').trimEnd();
  if (!line.trim()) return [];
  if (line.startsWith('{') && line.endsWith('}')) {
    try {
      const j = JSON.parse(line) as { message?: unknown; msg?: unknown; label?: unknown; level?: unknown };
      const msg = typeof j.message === 'string' ? j.message : typeof j.msg === 'string' ? j.msg : null;
      if (msg !== null) {
        const label = typeof j.label === 'string' && j.label !== 'SKIP_FORMAT' ? `[${j.label}] ` : '';
        const level = typeof j.level === 'string' && /warn|error|fatal/i.test(j.level) ? `${j.level.toUpperCase()} ` : '';
        return msg.replace(ANSI, '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim()).map((l, i) => (i === 0 ? level + label + l : `  ${l}`));
      }
    } catch { /* non è JSON: riga normale */ }
  }
  return [line];
}

/** Primo indirizzo locale in una riga, ripulito da punteggiatura finale. */
export function extractLocalUrl(line: string): string | null {
  const m = line.match(LOCAL_URL);
  if (!m) return null;
  return m[0].replace('0.0.0.0', 'localhost').replace(/[.,;:!?)*]+$/, '');
}

const all = new Set<ChildProcess>();

export interface ServiceHandle {
  pid?: number;
  stop: () => void;
  exited: boolean;
}

export interface ServiceCallbacks {
  onLine: (line: string) => void;
  onUrl: (url: string) => void;
  onExit: (code: number | null) => void;
}

export function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* già terminato */ }
  }
}

/** visible: la finestra del programma non viene nascosta (app desktop, emulatori). */
export function startService(command: string, cwd: string, cb: ServiceCallbacks, baseEnv: NodeJS.ProcessEnv = process.env, visible = false): ServiceHandle {
  const child = spawn(command, {
    cwd, shell: true, windowsHide: !visible, detached: process.platform !== 'win32',
    env: { ...baseEnv, FORCE_COLOR: '0', BROWSER: 'none' },
  });
  all.add(child);
  const handle: ServiceHandle = { pid: child.pid, exited: false, stop: () => killTree(child) };
  let urlFound = false;
  let buf = '';
  const feed = (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const raw of lines) {
      for (const l of outputLines(raw)) {
        const line = redact(l);
        cb.onLine(line);
        if (!urlFound) {
          const u = extractLocalUrl(line);
          if (u) { urlFound = true; cb.onUrl(u); }
        }
      }
    }
  };
  child.stdout?.on('data', feed);
  child.stderr?.on('data', feed);
  child.on('error', (e) => cb.onLine(`Errore di avvio: ${e.message}`));
  child.on('exit', (code) => {
    all.delete(child);
    handle.exited = true;
    for (const l of outputLines(buf)) cb.onLine(redact(l));
    cb.onExit(code);
  });
  return handle;
}

/**
 * Una richiesta all'indirizzo riceve una risposta HTTP qualsiasi (anche 401 o 500: il servizio è raggiungibile).
 * Il certificato non viene verificato, così funzionano anche i certificati di sviluppo locali (IIS Express, dotnet dev-certs):
 * è solo un controllo di raggiungibilità, senza dati inviati.
 */
function reachable(url: string, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let u: URL;
    try { u = new URL(url); } catch { return resolve(false); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET', signal, rejectUnauthorized: false }, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** Attende che l'URL risponda (qualsiasi stato HTTP). */
export async function waitForUrl(url: string, timeoutMs: number, isAlive: () => boolean, signal: AbortSignal): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (signal.aborted || !isAlive()) return false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const ok = await reachable(url, ctrl.signal);
      clearTimeout(t);
      if (ok) return true;
    } catch { /* non ancora pronto */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export function pushLog(log: string[], line: string) {
  log.push(line.length > 500 ? `${line.slice(0, 500)}…` : line);
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
}

/** Chiude tutti i server avviati da Regia (alla chiusura del processo). */
export function killAllServices() {
  for (const c of all) killTree(c);
  all.clear();
}
