import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Run, RunSummary, Workflow, WorkflowTemplate } from '../shared/types.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.REGIA_DATA_DIR || path.join(ROOT, 'data'));
const WF_DIR = path.join(DATA_DIR, 'workflows');
const RUN_DIR = path.join(DATA_DIR, 'runs');
const CACHE_FILE = path.join(DATA_DIR, 'reuse-cache.json');
const TEMPLATE_DIR = path.join(ROOT, 'templates');

const SAFE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
function assertId(id: string) {
  if (!SAFE_ID.test(id)) throw new Error('Identificativo non valido');
}

function writeJsonAtomic(file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function initStore() {
  for (const d of [DATA_DIR, WF_DIR, RUN_DIR]) fs.mkdirSync(d, { recursive: true });
  // Le esecuzioni rimaste "in corso" da un avvio precedente non sono più vive.
  for (const s of listRuns()) {
    if (s.status === 'in_corso' || s.status === 'attesa_intervento') {
      const run = getRun(s.id);
      if (run) {
        run.status = 'interrotta';
        run.endedAt = run.endedAt ?? new Date().toISOString();
        run.notes.push('Esecuzione interrotta: il server è stato riavviato mentre era attiva.');
        for (const n of Object.values(run.nodes)) {
          if (n.status === 'attiva' || n.status === 'attesa_intervento') n.status = 'fallita';
          n.pendingActions = undefined;
        }
        saveRun(run);
      }
    }
  }
}

/**
 * Preset nella lingua richiesta (templates/<lingua>/*.json). Per ogni preset mancante in quella lingua si usa
 * la versione inglese, poi quella italiana: una lingua nuova può tradurre anche solo una parte dei preset.
 */
export function listTemplates(lang = 'it'): WorkflowTemplate[] {
  const read = (l: string): WorkflowTemplate[] => {
    const dir = path.join(TEMPLATE_DIR, l);
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(l) || !fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
      .map((f) => ({ ...(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as WorkflowTemplate), _file: f }) as WorkflowTemplate & { _file: string });
  };
  const byFile = new Map<string, WorkflowTemplate>();
  for (const l of ['it', 'en', lang]) for (const t of read(l) as (WorkflowTemplate & { _file: string })[]) byFile.set(t._file, t);
  return [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, t]) => { const { _file, ...rest } = t as WorkflowTemplate & { _file: string }; void _file; return rest as WorkflowTemplate; });
}

export function listWorkflows(): Workflow[] {
  return fs
    .readdirSync(WF_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(WF_DIR, f), 'utf8')) as Workflow)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getWorkflow(id: string): Workflow | null {
  assertId(id);
  const f = path.join(WF_DIR, `${id}.json`);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as Workflow) : null;
}

export function saveWorkflow(wf: Workflow) {
  assertId(wf.id);
  wf.updatedAt = new Date().toISOString();
  writeJsonAtomic(path.join(WF_DIR, `${wf.id}.json`), wf);
  return wf;
}

export function deleteWorkflow(id: string) {
  assertId(id);
  fs.rmSync(path.join(WF_DIR, `${id}.json`), { force: true });
}

export function saveRun(run: Run) {
  assertId(run.id);
  writeJsonAtomic(path.join(RUN_DIR, `${run.id}.json`), run);
}

export function getRun(id: string): Run | null {
  assertId(id);
  const f = path.join(RUN_DIR, `${id}.json`);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as Run) : null;
}

export function listRuns(workflowId?: string): RunSummary[] {
  return fs
    .readdirSync(RUN_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const r = JSON.parse(fs.readFileSync(path.join(RUN_DIR, f), 'utf8')) as Run;
      return {
        id: r.id, workflowId: r.workflowId, workflowName: r.workflowName, mode: r.mode, status: r.status,
        startedAt: r.startedAt, endedAt: r.endedAt, costUsd: r.totals.costUsd,
      };
    })
    .filter((r) => !workflowId || r.workflowId === workflowId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export interface ReuseEntry { runId: string; attemptId: string; output: string; declared?: unknown; resultText?: string; savedAt: string }

export function readReuseCache(): Record<string, ReuseEntry> {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function writeReuseEntry(key: string, entry: ReuseEntry) {
  const c = readReuseCache();
  c[key] = entry;
  writeJsonAtomic(CACHE_FILE, c);
}
