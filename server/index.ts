import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { HumanAction, Run, RunMode, Workflow } from '../shared/types.ts';
import { getEngine, planContinuation, startRun } from './engine.ts';
import { envInfo } from './env.ts';
import { computeInsights } from './insights.ts';
import { folderInfo } from './folder.ts';
import { withLayout } from '../shared/layout.ts';
import { killAllServices } from './service.ts';
import { ensureRegiaRules, getRules, saveRegiaRules } from './rules.ts';
import {
  ROOT, deleteWorkflow, getRun, getWorkflow, initStore, listRuns, listTemplates, listWorkflows, saveWorkflow,
} from './store.ts';
import { validateWorkflow } from './validate.ts';

const PORT = Number(process.env.PORT ?? 4317);
const HOST = '127.0.0.1';

initStore();
ensureRegiaRules();
const app = express();
app.use(express.json({ limit: '2mb' }));

// Solo richieste dalla stessa origine locale: protegge da pagine web esterne che provino a chiamare l'API.
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):(4317|5173|\d+)$/.test(origin)) {
    res.status(403).json({ error: 'Origine non consentita' });
    return;
  }
  next();
});

const h = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

app.get('/api/env', h(async (req, res) => res.json(await envInfo(req.query.refresh === '1'))));

app.get('/api/workflows', (_req, res) => res.json(listWorkflows()));
app.get('/api/workflows/:id', (req, res) => {
  const wf = getWorkflow(req.params.id);
  if (!wf) return void res.status(404).json({ error: 'Workflow non trovato' });
  res.json(wf);
});
app.get('/api/templates', (_req, res) => res.json(listTemplates()));

/** Crea un workflow, vuoto o da un preset. */
app.post('/api/workflows', (req, res) => {
  const body = req.body as { name?: string; projectDir?: string; goal?: string; templateId?: string };
  const tpl = body.templateId ? listTemplates().find((t) => t.id === body.templateId) : undefined;
  if (body.templateId && !tpl) return void res.status(400).json({ error: 'Preset non trovato' });
  const wf: Workflow = {
    id: `wf_${randomUUID().slice(0, 8)}`,
    name: body.name?.trim() || tpl?.name || 'Nuovo workflow',
    description: tpl?.description ?? '',
    settings: {
      maxParallel: 1, loadProjectSettings: true, applyGeneralRules: true, runBudgetUsd: 2,
      ...tpl?.settings,
      projectDir: body.projectDir?.trim() ?? '',
      goal: body.goal?.trim() ?? '',
    },
    nodes: withLayout(structuredClone(tpl?.nodes ?? []), tpl?.edges ?? []),
    edges: structuredClone(tpl?.edges ?? []),
    updatedAt: '',
  };
  res.json(saveWorkflow(wf));
});

app.get('/api/rules', (req, res) => res.json(getRules(req.query.projectDir as string | undefined)));
app.put('/api/rules', (req, res) => {
  const text = (req.body as { text?: unknown }).text;
  if (typeof text !== 'string') return void res.status(400).json({ error: 'Testo mancante' });
  saveRegiaRules(text);
  res.json(getRules());
});

app.get('/api/folder-info', h(async (req, res) => res.json(await folderInfo(String(req.query.path ?? '')))));
app.put('/api/workflows/:id', (req, res) => {
  const wf = req.body as Workflow;
  if (wf.id !== req.params.id) return void res.status(400).json({ error: 'Id non coerente' });
  res.json(saveWorkflow(wf));
});
app.delete('/api/workflows/:id', (req, res) => {
  deleteWorkflow(req.params.id);
  res.json({ ok: true });
});
app.post('/api/validate', (req, res) => res.json(validateWorkflow(req.body.workflow as Workflow, req.body.mode)));

app.get('/api/runs', (req, res) => res.json(listRuns(req.query.workflowId as string | undefined)));
app.get('/api/runs/:id', (req, res) => {
  const run = getEngine(req.params.id)?.run ?? getRun(req.params.id);
  if (!run) return void res.status(404).json({ error: 'Esecuzione non trovata' });
  res.json(run);
});
/** Esecuzione di partenza valida per "continua": stesso workflow, stessa modalità, non più attiva. */
function continuationSource(runId: string, workflowId: string, mode?: RunMode): { run: Run } | { error: string } {
  if (getEngine(runId)) return { error: "L'esecuzione di partenza è ancora attiva: annullala o attendi che finisca." };
  const run = getRun(runId);
  if (!run) return { error: 'Esecuzione di partenza non trovata' };
  if (run.workflowId !== workflowId) return { error: "L'esecuzione di partenza appartiene a un altro workflow." };
  if (mode && run.mode !== mode) return { error: "Si può continuare solo nella stessa modalità (prova o reale) dell'esecuzione di partenza." };
  return { run };
}

app.get('/api/runs/:id/continuation', (req, res) => {
  const wf = getWorkflow(String(req.query.workflowId ?? ''));
  if (!wf) return void res.status(404).json({ error: 'Workflow non trovato' });
  const r = continuationSource(req.params.id, wf.id);
  if ('error' in r) return void res.status(400).json({ error: r.error });
  res.json({ ...planContinuation(wf, r.run), mode: r.run.mode });
});

app.get('/api/runs/:id/insights', (req, res) => {
  const run = getEngine(req.params.id)?.run ?? getRun(req.params.id);
  if (!run) return void res.status(404).json({ error: 'Esecuzione non trovata' });
  res.json(computeInsights(run));
});

app.post('/api/runs', h(async (req, res) => {
  const { workflowId, mode, confirmReal, continueFrom } = req.body as { workflowId: string; mode: RunMode; confirmReal?: boolean; continueFrom?: string };
  const wf = getWorkflow(workflowId);
  if (!wf) return void res.status(404).json({ error: 'Workflow non trovato' });
  if (mode !== 'prova' && mode !== 'reale') return void res.status(400).json({ error: 'Modalità non valida' });
  const issues = validateWorkflow(wf, mode);
  if (issues.some((i) => i.level === 'errore')) return void res.status(400).json({ error: 'Il workflow contiene errori', issues });
  if (mode === 'reale') {
    const env = await envInfo();
    if (!env.realRunsEnabled) return void res.status(403).json({ error: 'Esecuzioni reali disattivate (REGIA_DISABLE_REAL=1).' });
    if (!confirmReal) return void res.status(400).json({ error: 'Conferma richiesta per un\'esecuzione reale.' });
    if (!env.auth.loggedIn && !env.auth.apiKeyEnv) return void res.status(400).json({ error: 'Nessuna autenticazione Claude disponibile.' });
  }
  let from: Run | undefined;
  if (continueFrom) {
    const r = continuationSource(continueFrom, wf.id, mode);
    if ('error' in r) return void res.status(400).json({ error: r.error });
    from = r.run;
  }
  const eng = startRun(wf, mode, wf.settings.runBudgetUsd, from);
  res.json({ id: eng.run.id });
}));

app.get('/api/runs/:id/stream', (req, res) => {
  const eng = getEngine(req.params.id);
  const run = eng?.run ?? getRun(req.params.id);
  if (!run) return void res.status(404).end();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (msg: unknown) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
  send({ t: 'snapshot', run });
  if (!eng) return void res.end();
  const unsub = eng.subscribe(send);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { unsub(); clearInterval(ping); });
});

app.post('/api/runs/:id/action', h(async (req, res) => {
  const eng = getEngine(req.params.id);
  if (!eng) return void res.status(409).json({ error: 'L\'esecuzione non è più attiva' });
  const { nodeId, action, feedback } = req.body as { nodeId: string; action: HumanAction; feedback?: string };
  // Le riprese possono durare minuti: rispondi subito, gli aggiornamenti arrivano via stream.
  const p = eng.human(nodeId, action, feedback);
  const early = await Promise.race([p.then(() => null, (e: Error) => e), new Promise((r) => setTimeout(() => r(null), 50))]);
  if (early instanceof Error) return void res.status(400).json({ error: early.message });
  p.catch(() => undefined);
  res.json({ ok: true });
}));

app.post('/api/runs/:id/service/:nodeId', h(async (req, res) => {
  const eng = getEngine(req.params.id);
  if (!eng) return void res.status(409).json({ error: "L'esecuzione non è più attiva" });
  const action = (req.body as { action?: string }).action;
  if (action !== 'ferma' && action !== 'riavvia') return void res.status(400).json({ error: 'Azione non valida' });
  const p = eng.serviceAction(req.params.nodeId, action);
  const early = await Promise.race([p.then(() => null, (e: Error) => e), new Promise((r) => setTimeout(() => r(null), 50))]);
  if (early instanceof Error) return void res.status(400).json({ error: early.message });
  p.catch(() => undefined);
  res.json({ ok: true });
}));

app.post('/api/runs/:id/cancel', (req, res) => {
  const eng = getEngine(req.params.id);
  if (!eng) return void res.status(409).json({ error: 'L\'esecuzione non è più attiva' });
  eng.cancel();
  res.json({ ok: true });
});

const dist = path.join(ROOT, 'web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err.message });
});

// Alla chiusura di Regia si fermano tutti i server avviati dalle fasi "server locale".
process.on('exit', killAllServices);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => { killAllServices(); process.exit(0); });

app.listen(PORT, HOST, () => {
  console.log(`Regia in ascolto su http://${HOST}:${PORT}`);
});
