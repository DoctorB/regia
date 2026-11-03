import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { msg, type Msg } from '../shared/i18n.ts';
import type { ApiErrorBody, HumanAction, Run, RunMode, ValidationIssue, Workflow } from '../shared/types.ts';
import { RegiaError, getEngine, planContinuation, startRun } from './engine.ts';
import { envInfo } from './env.ts';
import { computeInsights } from './insights.ts';
import { folderInfo } from './folder.ts';
import { withLayout } from '../shared/layout.ts';
import { killAllServices } from './service.ts';
import { languages, mergedDict, serverT, systemLanguage } from './i18n.ts';
import { ensureRegiaRules, getRules, saveRegiaRules } from './rules.ts';
import {
  ROOT, deleteRunsOf, deleteWorkflow, getRun, getWorkflow, initStore, listRuns, listTemplates, listWorkflows, saveWorkflow,
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
    sendError(res, 403, msg('api.originForbidden'));
    return;
  }
  next();
});

/**
 * Risposta di errore dell'API: testo nella lingua del server (riserva) più il messaggio localizzabile,
 * che l'interfaccia mostra nella lingua scelta.
 */
function sendError(res: Response, status: number, m: Msg, issues?: ValidationIssue[]) {
  const body: ApiErrorBody = { error: serverT(systemLanguage())(m.key, m.params), msg: m };
  if (issues) body.issues = issues;
  res.status(status).json(body);
}

/** Errore lanciato da un'esecuzione: messaggio localizzabile se presente, altrimenti solo il testo. */
function sendThrown(res: Response, status: number, e: Error) {
  const body: ApiErrorBody = { error: e.message, msg: e instanceof RegiaError ? e.msg : msg('api.unexpected', { message: e.message }) };
  res.status(status).json(body);
}

const h = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

app.get('/api/env', h(async (req, res) => res.json(await envInfo(req.query.refresh === '1'))));

app.get('/api/workflows', (_req, res) => res.json(listWorkflows()));
app.get('/api/workflows/:id', (req, res) => {
  const wf = getWorkflow(req.params.id);
  if (!wf) return void sendError(res, 404, msg('api.workflowNotFound'));
  res.json(wf);
});
app.get('/api/templates', (req, res) => res.json(listTemplates(String(req.query.lang ?? 'it'))));

// Traduzioni: elenco delle lingue disponibili e dizionario di una lingua (con le lingue di riserva applicate).
app.get('/api/i18n', (_req, res) => res.json(languages()));
app.get('/api/i18n/:lang', (req, res) => res.json(mergedDict(req.params.lang)));

/** Crea un workflow, vuoto o da un preset. */
app.post('/api/workflows', (req, res) => {
  const body = req.body as { name?: string; projectDir?: string; goal?: string; templateId?: string; language?: string; group?: string };
  const language = body.language && languages().some((l) => l.code === body.language) ? body.language : systemLanguage();
  const t = serverT(language);
  const tpl = body.templateId ? listTemplates(language).find((t) => t.id === body.templateId) : undefined;
  if (body.templateId && !tpl) return void sendError(res, 400, msg('api.presetNotFound'));
  const wf: Workflow = {
    id: `wf_${randomUUID().slice(0, 8)}`,
    name: body.name?.trim() || tpl?.name || t('api.defaultWorkflowName'),
    description: tpl?.description ?? '',
    group: cleanGroup(body.group),
    settings: {
      maxParallel: 1, loadProjectSettings: true, applyGeneralRules: true, runBudgetUsd: 2, language,
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
  if (typeof text !== 'string') return void sendError(res, 400, msg('api.textMissing'));
  saveRegiaRules(text);
  res.json(getRules());
});

app.get('/api/folder-info', h(async (req, res) => res.json(await folderInfo(String(req.query.path ?? '')))));
app.put('/api/workflows/:id', (req, res) => {
  const wf = req.body as Workflow;
  if (wf.id !== req.params.id) return void sendError(res, 400, msg('api.idMismatch'));
  res.json(saveWorkflow(wf));
});
/** Elimina un workflow; con ?runs=1 anche le sue esecuzioni salvate (quelle ancora attive restano). */
app.delete('/api/workflows/:id', (req, res) => {
  const id = req.params.id;
  const removedRuns = req.query.runs === '1' ? deleteRunsOf(id, (runId) => Boolean(getEngine(runId))) : 0;
  deleteWorkflow(id);
  res.json({ ok: true, removedRuns });
});

/** Copia di un workflow, con nome "(copia)" e nessuna esecuzione. */
app.post('/api/workflows/:id/duplicate', (req, res) => {
  const src = getWorkflow(req.params.id);
  if (!src) return void sendError(res, 404, msg('api.workflowNotFound'));
  const t = serverT(String(req.query.lang ?? src.settings.language ?? 'it'));
  const copy: Workflow = { ...structuredClone(src), id: `wf_${randomUUID().slice(0, 8)}`, name: `${src.name} ${t('api.copySuffix')}`, updatedAt: '' };
  res.json(saveWorkflow(copy));
});

/** Rinomina un gruppo per tutti i suoi workflow; con "to" vuoto il gruppo viene tolto (i workflow restano). */
app.post('/api/workflow-groups/rename', (req, res) => {
  const { from, to } = req.body as { from?: string; to?: string };
  const src = cleanGroup(from);
  if (!src) return void sendError(res, 400, msg('api.groupMissing'));
  const dest = cleanGroup(to);
  let n = 0;
  for (const w of listWorkflows()) if (cleanGroup(w.group) === src) { saveWorkflow({ ...w, group: dest }); n++; }
  res.json({ ok: true, updated: n });
});

function cleanGroup(g: unknown): string | undefined {
  const s = typeof g === 'string' ? g.trim().replace(/s+/g, ' ').slice(0, 80) : '';
  return s || undefined;
}
app.post('/api/validate', (req, res) => res.json(validateWorkflow(req.body.workflow as Workflow, req.body.mode)));

app.get('/api/runs', (req, res) => res.json(listRuns(req.query.workflowId as string | undefined)));
app.get('/api/runs/:id', (req, res) => {
  const run = getEngine(req.params.id)?.run ?? getRun(req.params.id);
  if (!run) return void sendError(res, 404, msg('api.runNotFound'));
  res.json(run);
});
/** Esecuzione di partenza valida per "continua": stesso workflow, stessa modalità, non più attiva. */
function continuationSource(runId: string, workflowId: string, mode?: RunMode): { run: Run } | { error: Msg } {
  if (getEngine(runId)) return { error: msg('api.sourceStillActive') };
  const run = getRun(runId);
  if (!run) return { error: msg('api.sourceNotFound') };
  if (run.workflowId !== workflowId) return { error: msg('api.sourceOtherWorkflow') };
  if (mode && run.mode !== mode) return { error: msg('api.sourceModeMismatch') };
  return { run };
}

app.get('/api/runs/:id/continuation', (req, res) => {
  const wf = getWorkflow(String(req.query.workflowId ?? ''));
  if (!wf) return void sendError(res, 404, msg('api.workflowNotFound'));
  const r = continuationSource(req.params.id, wf.id);
  if ('error' in r) return void sendError(res, 400, r.error);
  res.json({ ...planContinuation(wf, r.run), mode: r.run.mode });
});

app.get('/api/runs/:id/insights', (req, res) => {
  const run = getEngine(req.params.id)?.run ?? getRun(req.params.id);
  if (!run) return void sendError(res, 404, msg('api.runNotFound'));
  res.json(computeInsights(run));
});

app.post('/api/runs', h(async (req, res) => {
  const { workflowId, mode, confirmReal, continueFrom } = req.body as { workflowId: string; mode: RunMode; confirmReal?: boolean; continueFrom?: string };
  const wf = getWorkflow(workflowId);
  if (!wf) return void sendError(res, 404, msg('api.workflowNotFound'));
  if (mode !== 'prova' && mode !== 'reale') return void sendError(res, 400, msg('api.invalidMode'));
  const issues = validateWorkflow(wf, mode);
  if (issues.some((i) => i.level === 'errore')) return void sendError(res, 400, msg('api.workflowHasErrors'), issues);
  if (mode === 'reale') {
    const env = await envInfo();
    if (!env.realRunsEnabled) return void sendError(res, 403, msg('api.realDisabled'));
    if (!confirmReal) return void sendError(res, 400, msg('api.confirmReal'));
    if (!env.auth.loggedIn && !env.auth.apiKeyEnv) return void sendError(res, 400, msg('api.noAuth'));
  }
  let from: Run | undefined;
  if (continueFrom) {
    const r = continuationSource(continueFrom, wf.id, mode);
    if ('error' in r) return void sendError(res, 400, r.error);
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
  if (!eng) return void sendError(res, 409, msg('api.runNotActive'));
  const { nodeId, action, feedback } = req.body as { nodeId: string; action: HumanAction; feedback?: string };
  // Le riprese possono durare minuti: rispondi subito, gli aggiornamenti arrivano via stream.
  const p = eng.human(nodeId, action, feedback);
  const early = await Promise.race([p.then(() => null, (e: Error) => e), new Promise((r) => setTimeout(() => r(null), 50))]);
  if (early instanceof Error) return void sendThrown(res, 400, early);
  p.catch(() => undefined);
  res.json({ ok: true });
}));

app.post('/api/runs/:id/service/:nodeId', h(async (req, res) => {
  const eng = getEngine(req.params.id);
  if (!eng) return void sendError(res, 409, msg('api.runNotActive'));
  const action = (req.body as { action?: string }).action;
  if (action !== 'ferma' && action !== 'riavvia') return void sendError(res, 400, msg('api.invalidAction'));
  const p = eng.serviceAction(req.params.nodeId, action);
  const early = await Promise.race([p.then(() => null, (e: Error) => e), new Promise((r) => setTimeout(() => r(null), 50))]);
  if (early instanceof Error) return void sendThrown(res, 400, early);
  p.catch(() => undefined);
  res.json({ ok: true });
}));

app.post('/api/runs/:id/cancel', (req, res) => {
  const eng = getEngine(req.params.id);
  if (!eng) return void sendError(res, 409, msg('api.runNotActive'));
  eng.cancel();
  res.json({ ok: true });
});

const dist = path.join(ROOT, 'web', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  sendThrown(res, 500, err);
});

// Alla chiusura di Regia si fermano tutti i server avviati dalle fasi "server locale".
process.on('exit', killAllServices);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => { killAllServices(); process.exit(0); });

app.listen(PORT, HOST, () => {
  console.log(`Regia in ascolto su http://${HOST}:${PORT}`);
});
