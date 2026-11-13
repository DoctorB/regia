// Collaudo sul telefono: log dell'app registrato da Regia mentre l'agente usa l'app.
// - logcat del dispositivo (avvisi ed errori), tenuto solo per i processi dell'app e per crash e ANR che la riguardano;
// - le righe vanno in un file che l'agente può rileggere dopo ogni scenario;
// - crash e ANR vengono riconosciuti subito (evento) e a fine collaudo diventano anomalie, anche se l'agente non li ha visti.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';

export interface AppLogSummary {
  lines: number;
  errors: number;
  /** Una voce per crash o ANR distinto: tipo di eccezione e messaggio. */
  crashes: string[];
}

export interface AppLogWatcher {
  stop(): AppLogSummary;
}

const MAX_LINES = 20000;

/** Riga logcat in formato threadtime: data ora pid tid livello tag: messaggio. */
const THREADTIME = /^\S+\s+\S+\s+(\d+)\s+\d+\s+([VDIWEF])\s+([^:]*?)\s*:\s?(.*)$/;

/**
 * Analizza le righe di logcat: tiene quelle dei processi dell'app e riconosce crash (FATAL EXCEPTION) e ANR.
 * Separata dal processo adb, così si può provare con righe di esempio.
 */
export class AppLogParser {
  pids = new Set<string>();
  lines = 0;
  errors = 0;
  crashes: string[] = [];
  private fatal?: { pid: string; ours: boolean; detail?: string };

  constructor(private appId: string | undefined, private onLine: (line: string) => void, private onCrash: (what: string) => void) {}

  feed(raw: string) {
    const m = THREADTIME.exec(raw);
    if (!m) return;
    const [, pid, level, tag, text] = m;
    const app = this.appId;
    // Crash: "FATAL EXCEPTION: main", poi "Process: <app>, PID: n", poi la riga con l'eccezione.
    if (tag === 'AndroidRuntime') {
      if (text.startsWith('FATAL EXCEPTION')) { this.closeFatal(); this.fatal = { pid, ours: !app || this.pids.has(pid) }; }
      else if (this.fatal && pid === this.fatal.pid) {
        if (app && text.startsWith('Process:')) this.fatal.ours = text.includes(app);
        else if (!this.fatal.detail && /^[\w$.]+(Exception|Error)\b/.test(text)) this.fatal.detail = text.trim();
      }
    } else if (this.fatal && pid !== this.fatal.pid) {
      this.closeFatal();
    }
    const anr = tag === 'ActivityManager' && /^ANR in /.test(text) && (!app || text.includes(app));
    if (anr) this.found(text.trim());
    const ours = this.pids.has(pid) || (this.fatal?.pid === pid && this.fatal.ours) || anr || (!app && (level === 'E' || level === 'F'));
    if (!ours) return;
    if (level === 'E' || level === 'F') this.errors++;
    if (this.lines < MAX_LINES) { this.lines++; this.onLine(raw); }
  }

  /** Chiude un crash in corso (a fine log o quando arriva una riga di un altro processo). */
  closeFatal() {
    const f = this.fatal;
    this.fatal = undefined;
    if (f?.ours) this.found(f.detail ?? 'FATAL EXCEPTION');
  }

  private found(what: string) {
    if (this.crashes.includes(what)) return;
    this.crashes.push(what);
    this.onCrash(what);
  }
}

/** Avvia la registrazione: pulisce il buffer, segue logcat e aggiorna i PID dell'app ogni pochi secondi. */
export function watchAppLog(adb: string, serial: string, appId: string | undefined, file: string, onCrash: (what: string) => void): AppLogWatcher {
  const out = fs.createWriteStream(file, { flags: 'a' });
  const parser = new AppLogParser(appId, (l) => out.write(l + '\n'), onCrash);
  let proc: ChildProcess | undefined;
  let buf = '';
  const refreshPids = () => {
    if (!appId) return;
    execFile(adb, ['-s', serial, 'shell', 'pidof', appId], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (!err) for (const p of String(stdout).trim().split(/\s+/).filter(Boolean)) parser.pids.add(p);
    });
  };
  // Il buffer si pulisce prima di iniziare: nel file finisce solo ciò che succede durante il collaudo.
  execFile(adb, ['-s', serial, 'logcat', '-c'], { windowsHide: true, timeout: 10000 }, () => {
    proc = spawn(adb, ['-s', serial, 'logcat', '-v', 'threadtime', '*:W'], { windowsHide: true });
    proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) parser.feed(l);
    });
    proc.on('error', () => undefined);
  });
  refreshPids();
  const timer = setInterval(refreshPids, 3000);
  return {
    stop() {
      clearInterval(timer);
      if (buf) parser.feed(buf);
      parser.closeFatal();
      try { proc?.kill(); } catch { /* già chiuso */ }
      out.end();
      return { lines: parser.lines, errors: parser.errors, crashes: parser.crashes };
    },
  };
}
