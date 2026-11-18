// Log di diagnosi dei comandi avviati dalle fasi server/mostra/collaudo: ogni riga con l'istante relativo all'avvio,
// le pause di silenzio, gli eventi di Regia (proroga, scadenza, uscita) e, se il comando resta appeso, l'albero dei
// processi ancora attivi. Il file completo resta in data/logs/<esecuzione>/ (mai inviato); alle segnalazioni va
// solo un riepilogo con tempi, pause più lunghe, nomi dei processi e le ultime righe.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.ts';

/** Pause più lunghe di questa soglia vengono annotate nel file. */
const GAP_NOTE_MS = 30_000;
const TAIL = 40;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  /** Tempo di CPU consumato, in secondi (se disponibile). */
  cpuSec?: number;
  /** Da quanto è in vita, in secondi (se disponibile). */
  ageSec?: number;
  command?: string;
}

export interface TraceSummary {
  elapsedSec: number;
  silentSec: number;
  lines: number;
  lastLine?: string;
  gaps: { sec: number; after: string; atSec: number }[];
}

export const logsDir = (runId: string) => path.join(DATA_DIR, 'logs', runId);

/** "+mm:ss" dall'avvio. */
export function rel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `+${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export class ServiceTrace {
  readonly file: string;
  readonly startedAt: number;
  private lastAt: number;
  private lastLine?: string;
  private count = 0;
  private bytes = 0;
  private gaps: TraceSummary['gaps'] = [];
  private tail: { at: number; text: string }[] = [];
  private fd: number | null = null;
  /** Processi rimasti attivi quando il comando è stato fermato per tempo scaduto. */
  procs?: ProcessInfo[];

  constructor(file: string, header: Record<string, string | number | undefined>, now = Date.now()) {
    this.file = file;
    this.startedAt = now;
    this.lastAt = now;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.fd = fs.openSync(file, 'a');
    } catch { this.fd = null; }
    this.write(`=== ${new Date(now).toISOString()}`);
    for (const [k, v] of Object.entries(header)) if (v !== undefined && v !== '') this.write(`${k}: ${v}`);
    this.write('');
  }

  private write(s: string) {
    if (this.fd === null || this.bytes > MAX_FILE_BYTES) return;
    try {
      const b = Buffer.from(`${s}\n`, 'utf8');
      this.bytes += b.length;
      if (this.bytes > MAX_FILE_BYTES) fs.writeSync(this.fd, '[log troncato: oltre 20 MB]\n');
      else fs.writeSync(this.fd, b);
    } catch { /* il log di diagnosi non deve mai fermare la fase */ }
  }

  /** Riga di output del comando (prefix: es. "[be]" per il backend avviato insieme). */
  line(text: string, prefix = '', now = Date.now()) {
    const gap = now - this.lastAt;
    if (this.count > 0 && gap >= GAP_NOTE_MS) {
      this.write(`[${rel(now - this.startedAt)}] ## silenzio di ${Math.round(gap / 1000)} s`);
      this.gaps.push({ sec: Math.round(gap / 1000), after: this.lastLine ?? '', atSec: Math.round((this.lastAt - this.startedAt) / 1000) });
      this.gaps.sort((a, b) => b.sec - a.sec);
      this.gaps.length = Math.min(this.gaps.length, 5);
    }
    const full = prefix ? `${prefix} ${text}` : text;
    this.lastAt = now;
    this.lastLine = full;
    this.count++;
    this.write(`[${rel(now - this.startedAt)}] ${full}`);
    this.tail.push({ at: now, text: full.length > 300 ? `${full.slice(0, 300)}…` : full });
    if (this.tail.length > TAIL) this.tail.shift();
  }

  /** Evento di Regia (proroga, scadenza, uscita del processo…). */
  note(text: string, now = Date.now()) {
    this.write(`[${rel(now - this.startedAt)}] ## ${text}`);
  }

  summary(now = Date.now()): TraceSummary {
    const silent = now - this.lastAt;
    const gaps = [...this.gaps];
    // Il silenzio in corso conta come pausa (è spesso quella che spiega la scadenza).
    if (this.count > 0 && silent >= GAP_NOTE_MS) gaps.push({ sec: Math.round(silent / 1000), after: this.lastLine ?? '', atSec: Math.round((this.lastAt - this.startedAt) / 1000) });
    gaps.sort((a, b) => b.sec - a.sec);
    return {
      elapsedSec: Math.round((now - this.startedAt) / 1000),
      silentSec: Math.round(silent / 1000),
      lines: this.count,
      lastLine: this.lastLine,
      gaps: gaps.slice(0, 5),
    };
  }

  /**
   * Testo per la segnalazione: riepilogo dei tempi, processi attivi (solo nomi) e ultime righe con il loro istante,
   * entro maxChars (il riepilogo in testa non viene mai tagliato).
   */
  reportDetail(procs: ProcessInfo[] | undefined = this.procs, maxChars = 7000, now = Date.now()): string {
    const s = this.summary(now);
    const head = [
      `tempo: ${s.elapsedSec} s · silenzio finale: ${s.silentSec} s · righe: ${s.lines}`,
      ...s.gaps.map((g) => `pausa di ${g.sec} s a ${rel(g.atSec * 1000)} dopo: ${g.after.slice(0, 160)}`),
      procs ? `processi ancora attivi: ${procs.length ? describeTree(procs) : 'nessuno'}` : '',
      '---',
    ].filter(Boolean).join('\n');
    const lines: string[] = [];
    let size = head.length;
    for (let i = this.tail.length - 1; i >= 0; i--) {
      const l = `[${rel(this.tail[i].at - this.startedAt)}] ${this.tail[i].text}`;
      if (size + l.length + 1 > maxChars) break;
      lines.unshift(l);
      size += l.length + 1;
    }
    return `${head}\n${lines.join('\n')}`;
  }

  close(text?: string) {
    if (text) this.note(text);
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch { /* già chiuso */ } }
    this.fd = null;
  }
}

/** Albero dei processi in una riga, solo nomi, CPU ed età: "cmd.exe › java.exe (cpu 312 s, da 1190 s)". */
export function describeTree(procs: ProcessInfo[]): string {
  const fmt = (p: ProcessInfo) => {
    const extra = [p.cpuSec !== undefined ? `cpu ${p.cpuSec} s` : '', p.ageSec !== undefined ? `da ${p.ageSec} s` : ''].filter(Boolean).join(', ');
    return extra ? `${p.name} (${extra})` : p.name;
  };
  return procs.map(fmt).join(' › ').slice(0, 1200);
}

/** Discendenti di root (root compreso) in ordine di visita, da un elenco completo dei processi. */
export function descendants(all: ProcessInfo[], root: number): ProcessInfo[] {
  const byParent = new Map<number, ProcessInfo[]>();
  for (const p of all) {
    if (p.pid === p.ppid) continue;
    byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p]);
  }
  const out: ProcessInfo[] = [];
  const seen = new Set<number>();
  const visit = (pid: number) => {
    if (seen.has(pid)) return;
    seen.add(pid);
    const self = all.find((p) => p.pid === pid);
    if (self) out.push(self);
    for (const c of byParent.get(pid) ?? []) visit(c.pid);
  };
  visit(root);
  return out;
}

/** "[[DD-]hh:]mm:ss" di ps in secondi. */
export function psDuration(s: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return undefined;
  return ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]);
}

const run = (file: string, args: string[]) => new Promise<string>((resolve) => {
  execFile(file, args, { windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024 * 1024 }, (_e, out) => resolve(String(out ?? '')));
});

/** Processi ancora attivi sotto il comando: nomi, CPU, età e riga di comando. Vuoto se non si riesce a leggerli. */
export async function processTree(root: number): Promise<ProcessInfo[]> {
  try {
    if (process.platform === 'win32') {
      const ps = 'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; cpu=[math]::Round(($_.KernelModeTime + $_.UserModeTime) / 1e7); created=if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString("o") } else { $null }; cmd=$_.CommandLine } } | ConvertTo-Json -Compress';
      const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
      const list = JSON.parse(out || '[]') as { pid: number; ppid: number; name: string; cpu: number; created: string | null; cmd: string | null }[];
      const all = (Array.isArray(list) ? list : [list]).map((p) => ({
        pid: p.pid, ppid: p.ppid, name: p.name, cpuSec: p.cpu,
        ageSec: p.created ? Math.round((Date.now() - Date.parse(p.created)) / 1000) : undefined,
        command: p.cmd ?? undefined,
      }));
      return descendants(all, root);
    }
    const out = await run('ps', ['-A', '-o', 'pid=,ppid=,etime=,time=,comm=,args=']);
    const all: ProcessInfo[] = [];
    for (const l of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(l);
      if (m) all.push({ pid: Number(m[1]), ppid: Number(m[2]), ageSec: psDuration(m[3]), cpuSec: psDuration(m[4]), name: path.basename(m[5]), command: m[6] });
    }
    return descendants(all, root);
  } catch {
    return [];
  }
}
