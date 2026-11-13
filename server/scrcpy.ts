// Mirror dello schermo Android durante il collaudo, con scrcpy (https://github.com/Genymobile/scrcpy).
// - Ricerca: la copia scaricata da Regia (data/tools), poi il PATH (e le cartelle di Homebrew su macOS).
// - Installazione, solo su richiesta: su Windows lo zip ufficiale, verificato con lo SHA-256 fissato qui ed estratto in
//   data/tools (niente permessi di amministratore né modifiche al PATH); su macOS "brew install scrcpy"; su Linux indicazioni.
// - Avvio: finestra in sola visione con il nome della fase, chiusa a fine collaudo. Usa l'adb dell'SDK (variabile ADB),
//   così non parte un secondo server adb in conflitto.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ScrcpyStatus } from '../shared/types.ts';
import { DATA_DIR } from './store.ts';

export const SCRCPY_VERSION = '5.0.1';
const WIN_ZIP = {
  name: `scrcpy-win64-v${SCRCPY_VERSION}`,
  url: `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-win64-v${SCRCPY_VERSION}.zip`,
  // Da SHA256SUMS.txt della release ufficiale.
  sha256: 'b12a2c4ee8be317422451fc7dcf8ee20a71b5ea7ef9ad73ddd825a25316227a5',
};
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const TOOLS = path.join(DATA_DIR, 'tools');
const exe = WIN ? 'scrcpy.exe' : 'scrcpy';

const regiaCopy = () => path.join(TOOLS, WIN_ZIP.name, exe);

function onPath(name: string, extra: string[] = []): string | undefined {
  const dirs = [...(process.env.PATH ?? '').split(path.delimiter), ...extra].filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, name);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* non c'è */ }
  }
  return undefined;
}

function brewPath(): string | undefined {
  return MAC ? onPath('brew', ['/opt/homebrew/bin', '/usr/local/bin']) : undefined;
}

/** Dove si trova scrcpy e, se manca, come si può installare. */
export function scrcpyStatus(): ScrcpyStatus {
  if (WIN && fs.existsSync(regiaCopy())) return { installed: true, path: regiaCopy(), source: 'regia', version: SCRCPY_VERSION };
  const found = onPath(exe, MAC ? ['/opt/homebrew/bin', '/usr/local/bin'] : []);
  if (found) return { installed: true, path: found, source: 'path' };
  return { installed: false, install: WIN && process.arch === 'x64' ? 'download' : MAC && brewPath() ? 'brew' : 'manual', version: SCRCPY_VERSION };
}

let installing: Promise<ScrcpyStatus> | undefined;

/** Installa scrcpy (una sola installazione alla volta). Lancia un errore con un messaggio leggibile se non riesce. */
export function installScrcpy(): Promise<ScrcpyStatus> {
  installing ??= doInstall().finally(() => { installing = undefined; });
  return installing;
}

async function doInstall(): Promise<ScrcpyStatus> {
  const st = scrcpyStatus();
  if (st.installed) return st;
  if (st.install === 'brew') {
    await run(brewPath()!, ['install', 'scrcpy'], 15 * 60_000);
    return scrcpyStatus();
  }
  if (st.install !== 'download') throw new Error('manual');
  fs.mkdirSync(TOOLS, { recursive: true });
  const zip = path.join(TOOLS, `${WIN_ZIP.name}.zip`);
  const res = await fetch(WIN_ZIP.url, { redirect: 'follow', signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const hash = createHash('sha256').update(data).digest('hex');
  if (hash !== WIN_ZIP.sha256) throw new Error(`checksum ${hash}`);
  fs.writeFileSync(zip, data);
  try {
    // tar di Windows (bsdtar, da Windows 10) estrae anche gli zip; percorso esplicito per non usare quello di Git.
    const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    await run(tar, ['-xf', zip, '-C', TOOLS], 120_000);
  } finally {
    fs.rmSync(zip, { force: true });
  }
  const after = scrcpyStatus();
  if (!after.installed) throw new Error('scrcpy.exe');
  return after;
}

function run(cmd: string, args: string[], timeout: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, _out, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().slice(-400)));
      else resolve();
    });
  });
}

export interface MirrorHandle {
  stop(): void;
}

/**
 * Apre la finestra del mirror: sola visione (non interferisce con i tocchi dell'agente), senza audio, schermo del
 * telefono tenuto acceso. onExit riceve l'output se la finestra si chiude da sola (es. errore di avvio).
 */
export function startMirror(scrcpy: string, serial: string, title: string, adb: string, onExit: (code: number | null, output: string) => void): MirrorHandle {
  let out = '';
  let stopped = false;
  const child: ChildProcess = spawn(scrcpy, ['-s', serial, '--no-control', '--no-audio', '--window-title', title, '--max-size', '1600'], {
    env: { ...process.env, ADB: adb },
    // La console di scrcpy resta nascosta; la finestra del mirror si apre comunque.
    windowsHide: true,
  });
  const keep = (d: Buffer) => { out = (out + d.toString('utf8')).slice(-2000); };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  child.on('error', (e) => { if (!stopped) onExit(null, e.message); });
  child.on('exit', (code) => { if (!stopped) onExit(code, out); });
  return {
    stop() {
      stopped = true;
      try { child.kill(); } catch { /* già chiuso */ }
    },
  };
}
