// Schermo del telefono dentro Regia: il server di scrcpy gira sul dispositivo e trasmette lo schermo come H.264;
// Regia lo riceve tramite adb e lo inoltra alle pagine aperte, che lo decodificano con WebCodecs.
// - Server: scrcpy-server della versione fissata in scrcpy.ts, verificato con il suo SHA-256 (copia di Regia o download).
// - Avvio: push del server, "adb forward" verso il suo socket, app_process in sola visione, senza audio, flusso grezzo.
// - Chi si collega a metà riceve SPS, PPS e i fotogrammi dall'ultimo fotogramma chiave (uno ogni 2 secondi).
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DATA_DIR } from './store.ts';
import { SCRCPY_VERSION } from './scrcpy.ts';
import { NalSplitter, nalType } from '../shared/annexb.ts';

export { nalType };

const SERVER = {
  name: `scrcpy-server-v${SCRCPY_VERSION}`,
  url: `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`,
  // Da SHA256SUMS.txt della release ufficiale.
  sha256: '764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536',
};
const TOOLS = path.join(DATA_DIR, 'tools');
const DEVICE_PATH = '/data/local/tmp/regia-scrcpy-server.jar';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Il server di scrcpy verificato: la copia già scaricata, quella dentro lo zip di scrcpy di Regia, oppure un download. */
export async function scrcpyServerFile(): Promise<string> {
  const target = path.join(TOOLS, SERVER.name);
  const ok = (p: string) => { try { return sha(fs.readFileSync(p)) === SERVER.sha256; } catch { return false; } };
  if (ok(target)) return target;
  const bundled = path.join(TOOLS, `scrcpy-win64-v${SCRCPY_VERSION}`, 'scrcpy-server');
  fs.mkdirSync(TOOLS, { recursive: true });
  if (ok(bundled)) { fs.copyFileSync(bundled, target); return target; }
  const res = await fetch(SERVER.url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (sha(data) !== SERVER.sha256) throw new Error('checksum');
  fs.writeFileSync(target, data);
  return target;
}

function adbRun(adb: string, args: string[], timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(adb, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().slice(-300)));
      else resolve(String(stdout));
    });
  });
}

export interface MirrorStream {
  /** Collega una pagina: riceve subito l'ultimo fotogramma chiave, poi il flusso. Restituisce la funzione per staccarla. */
  attach(send: (chunk: Uint8Array) => void): () => void;
  stop(): void;
}

/** Avvia il flusso dello schermo. onEnd: il flusso si è interrotto da solo (telefono scollegato, errore del server). */
export async function startMirrorStream(adb: string, serial: string, onEnd: (reason: string) => void): Promise<MirrorStream> {
  const server = await scrcpyServerFile();
  const scid = randomInt(1, 0x7fffffff).toString(16).padStart(8, '0');
  await adbRun(adb, ['-s', serial, 'push', server, DEVICE_PATH]);
  const port = Number((await adbRun(adb, ['-s', serial, 'forward', 'tcp:0', `localabstract:scrcpy_${scid}`])).trim());
  if (!port) throw new Error('adb forward');

  let stopped = false;
  let log = '';
  const proc: ChildProcess = spawn(adb, ['-s', serial, 'shell',
    `CLASSPATH=${DEVICE_PATH}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', SCRCPY_VERSION,
    `scid=${scid}`, 'log_level=info', 'tunnel_forward=true', 'audio=false', 'control=false', 'raw_stream=true',
    'video_codec=h264', 'max_size=1280', 'max_fps=30', 'video_codec_options=i-frame-interval=2', 'cleanup=true',
  ], { windowsHide: true });
  let ready: () => void = () => undefined;
  const started = new Promise<void>((r) => { ready = r; });
  const onLog = (d: Buffer) => {
    log = (log + d.toString('utf8')).slice(-2000);
    if (/Device:|INFO/.test(log)) ready();
  };
  proc.stdout?.on('data', onLog);
  proc.stderr?.on('data', onLog);
  proc.on('exit', () => { ready(); if (!stopped) end(log.trim().split('\n').slice(-2).join(' ') || 'server'); });

  // Ultimo fotogramma chiave con i suoi parametri, per chi si collega dopo.
  let sps: Uint8Array | undefined;
  let pps: Uint8Array | undefined;
  let gop: Uint8Array[] = [];
  const clients = new Set<(chunk: Uint8Array) => void>();
  const splitter = new NalSplitter((nal) => {
    const type = nalType(nal);
    if (type === 7) sps = nal;
    else if (type === 8) pps = nal;
    else if (type === 5) gop = [nal];
    else if (type === 1 && gop.length) gop.push(nal);
    // Limite di sicurezza se i fotogrammi chiave non arrivano.
    if (gop.length > 300) gop = [];
    for (const c of clients) c(nal);
  });

  await Promise.race([started, new Promise((r) => setTimeout(r, 4000))]);
  let sock: net.Socket | undefined;
  // Il server apre il suo socket poco dopo il log iniziale: si ritenta finché arrivano dati.
  for (let i = 0; i < 40 && !stopped; i++) {
    const s = net.connect(port, '127.0.0.1');
    const first = await new Promise<Buffer | null>((resolve) => {
      s.once('data', (d: Buffer) => resolve(d));
      s.once('close', () => resolve(null));
      s.once('error', () => resolve(null));
      setTimeout(() => resolve(null), 3000);
    });
    if (first) { sock = s; splitter.push(first); break; }
    s.destroy();
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!sock) {
    cleanup();
    throw new Error(log.trim().split('\n').slice(-2).join(' ') || 'no video');
  }
  sock.on('data', (d: Buffer) => splitter.push(d));
  sock.on('close', () => { if (!stopped) end('closed'); });
  sock.on('error', () => undefined);

  function cleanup() {
    try { sock?.destroy(); } catch { /* già chiuso */ }
    try { proc.kill(); } catch { /* già chiuso */ }
    execFile(adb, ['-s', serial, 'forward', '--remove', `tcp:${port}`], { windowsHide: true }, () => undefined);
  }
  function end(reason: string) {
    if (stopped) return;
    stopped = true;
    cleanup();
    for (const c of clients) c(new Uint8Array(0));
    clients.clear();
    onEnd(reason);
  }

  return {
    attach(send) {
      if (sps) send(sps);
      if (pps) send(pps);
      for (const f of gop) send(f);
      clients.add(send);
      return () => clients.delete(send);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      cleanup();
      for (const c of clients) c(new Uint8Array(0));
      clients.clear();
    },
  };
}
