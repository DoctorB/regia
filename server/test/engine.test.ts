import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PhaseConfig, Workflow, WorkflowTemplate } from '../../shared/types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regia-test-'));
const projectDir = path.join(tmp, 'progetto');
fs.mkdirSync(projectDir);
const globalRules = path.join(tmp, 'CLAUDE.md');
fs.writeFileSync(globalRules, '- Scrivi i messaggi di commit in italiano.\n');
process.env.REGIA_DATA_DIR = path.join(tmp, 'data');
process.env.REGIA_GLOBAL_RULES = globalRules;
process.env.REGIA_MOCK_SPEED = '2';

const store = await import('../store.ts');
const { startRun } = await import('../engine.ts');
const { computeInsights } = await import('../insights.ts');
const { mockSessionTotals } = await import('../mockQuery.ts');
const { validateWorkflow } = await import('../validate.ts');
const { ensureRegiaRules, rulesPrompt } = await import('../rules.ts');
store.initStore();
ensureRegiaRules();

const waitFor = async (cond: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function fromTemplate(t: WorkflowTemplate): Workflow {
  return {
    id: `wf_${t.id.replace(/[^a-z0-9]/g, '')}`, name: t.name, description: t.description,
    settings: { maxParallel: 1, loadProjectSettings: false, applyGeneralRules: true, ...t.settings, projectDir, goal: 'Obiettivo di prova' },
    nodes: structuredClone(t.nodes), edges: structuredClone(t.edges), updatedAt: '',
  };
}
const templates = store.listTemplates();
const bugWf = () => fromTemplate(templates.find((t) => t.id === 'correggi-bug')!);

test('tutti i preset sono validi una volta impostata la cartella', () => {
  assert.ok(templates.length >= 5);
  for (const t of templates) {
    const errors = validateWorkflow(fromTemplate(t), 'prova').filter((i) => i.level === 'errore');
    assert.deepEqual(errors, [], t.id);
  }
});

test('ciclo rilevato dalla validazione', () => {
  const wf = bugWf();
  wf.edges.push({ id: 'x', source: 'test', target: 'analisi' });
  assert.ok(validateWorkflow(wf).some((i) => i.message.includes('ciclo')));
});

test('regole generali fotografate e aggiunte al prompt; disattivabili', () => {
  const eng = startRun(bugWf(), 'prova', 5);
  const r = eng.run.rules!;
  assert.equal(r.applied, true);
  assert.equal(r.globalPath, path.resolve(globalRules));
  assert.match(r.global!, /messaggi di commit in italiano/);
  assert.match(r.regia!, /git commit/);
  assert.match(rulesPrompt(r), /Regole generali[\s\S]*commit in italiano[\s\S]*git commit/);
  eng.cancel();
  const off = bugWf();
  off.settings.applyGeneralRules = false;
  const eng2 = startRun(off, 'prova', 5);
  assert.equal(eng2.run.rules!.applied, false);
  assert.equal(rulesPrompt(eng2.run.rules), '');
  eng2.cancel();
});

test('esecuzione di prova completa con approvazione e ripresa con feedback', async () => {
  const eng = startRun(bugWf(), 'prova', 5);
  const run = eng.run;
  await waitFor(() => run.nodes.approvazione.status === 'attesa_intervento');
  assert.equal(run.status, 'attesa_intervento');
  const costBefore = run.totals.costUsd!;
  const implCostBefore = run.nodes.correzione.attempts[0].usage.costUsd!;
  assert.ok(costBefore > 0);

  await eng.human('approvazione', 'respingi', 'Aggiungi un commento che spieghi la correzione');
  await waitFor(() => run.nodes.approvazione.status === 'attesa_intervento');
  const impl = run.nodes.correzione.attempts;
  assert.equal(impl.length, 2);
  assert.equal(impl[1].reason, 'ripresa_con_feedback');
  assert.equal(impl[1].usageSource, 'delta_ripresa');
  assert.ok(impl[1].usage.costUsd! > 0);
  // Il totale cumulativo della sessione (riportato dal result ripreso) = primo tentativo + delta: nessun doppio conteggio.
  const cumulative = mockSessionTotals(impl[1].sessionId!);
  assert.ok(Math.abs(cumulative - (implCostBefore + impl[1].usage.costUsd!)) < 1e-9);
  // Test e revisione vengono rieseguiti dopo la correzione.
  assert.equal(run.nodes.test.attempts.length, 2);
  assert.equal(run.nodes.test.attempts[1].reason, 'dopo_correzione');
  assert.ok(computeInsights(run).some((i) => i.id === 'corrections'));
  const sumAttempts = Object.values(run.nodes).flatMap((n) => n.attempts).reduce((s, a) => s + (a.usage.costUsd ?? 0), 0);
  assert.ok(Math.abs(run.totals.costUsd! - sumAttempts) < 1e-9);
  assert.ok(run.totals.costUsd! > costBefore);

  await eng.human('approvazione', 'approva');
  await waitFor(() => run.status === 'completata');
  assert.ok(run.events.some((e) => e.kind === 'decisione' && e.source === 'dichiarata'));
  assert.ok(run.events.some((e) => e.kind === 'decisione' && e.source === 'osservata'));
  assert.ok(run.nodes.analisi.attempts[0].live.duplicatesSkipped > 0);
  assert.ok(run.events.some((e) => e.text.startsWith('Regole generali applicate')));
  assert.ok(!run.events.some((e) => e.text.includes('ragionamento interno')));
  const insights = computeInsights(run);
  assert.ok(insights.length > 0);
  for (const i of insights) assert.ok(i.tradeoff.length > 0);
});

const phase = (p: Partial<PhaseConfig> & Pick<PhaseConfig, 'label' | 'kind' | 'instructions'>): PhaseConfig => ({
  role: 'Sviluppatore.', model: 'sonnet', allowedTools: ['Read', 'Edit', 'Bash'], maxTurns: 10, contextMode: 'sintesi', reuseResult: false, ...p,
});

test('errore, blocco, parallelo, subagenti, riuso e limite di spesa', async () => {
  const wf: Workflow = {
    id: 'wf_interventi', name: 'Interventi', description: '', updatedAt: '',
    settings: { projectDir, goal: 'Prova', maxParallel: 2, loadProjectSettings: false, applyGeneralRules: true, runBudgetUsd: 5 },
    nodes: [
      { id: 'analisi', position: { x: 0, y: 0 }, data: phase({ label: 'Analisi', kind: 'analisi', instructions: '[simula-errore] Analizza.', model: 'opus', allowedTools: ['Read', 'Glob', 'Grep', 'Agent'], reuseResult: true }) },
      { id: 'impl_a', position: { x: 1, y: 0 }, data: phase({ label: 'A', kind: 'implementazione', instructions: '[simula-blocco] Parte A.' }) },
      { id: 'impl_b', position: { x: 1, y: 1 }, data: phase({ label: 'B', kind: 'implementazione', instructions: 'Parte B.' }) },
      { id: 'test', position: { x: 2, y: 0 }, data: phase({ label: 'Test', kind: 'test', instructions: 'Esegui i test.', allowedTools: ['Bash', 'Read'] }) },
      { id: 'ok', position: { x: 3, y: 0 }, data: phase({ label: 'Approvazione', kind: 'approvazione', instructions: 'Approva.', model: '', allowedTools: [] }) },
    ],
    edges: [
      { id: 'e1', source: 'analisi', target: 'impl_a' }, { id: 'e2', source: 'analisi', target: 'impl_b' },
      { id: 'e3', source: 'impl_a', target: 'test' }, { id: 'e4', source: 'impl_b', target: 'test' }, { id: 'e5', source: 'test', target: 'ok' },
    ],
  };
  const eng = startRun(wf, 'prova', 5);
  const run = eng.run;
  await waitFor(() => run.nodes.analisi.status === 'fallita' && Boolean(run.nodes.analisi.pendingActions));
  assert.equal(run.nodes.analisi.attempts[0].usageSource, 'parziale');
  await eng.human('analisi', 'riprova');
  await waitFor(() => run.nodes.impl_a.status === 'bloccata');
  await eng.human('impl_a', 'riprendi', 'Procedi pure');
  await waitFor(() => run.nodes.ok.status === 'attesa_intervento');
  await eng.human('ok', 'approva');
  await waitFor(() => run.status === 'completata');
  // Seconda analisi (dopo l'errore): ha lo strumento Agent, quindi un subagente su modello diverso, incluso nei totali.
  assert.equal(run.nodes.analisi.attempts[1].subagents, 1);
  assert.ok(run.totals.byModel['sim-haiku']?.inputTokens > 0);
  assert.ok(run.nodes.analisi.attempts[1].usage.byModel['sim-haiku'].outputTokens > 0);

  // Seconda esecuzione: l'analisi (riuso attivo) viene riusata.
  const eng2 = startRun(wf, 'prova', 5);
  await waitFor(() => eng2.run.nodes.analisi.status !== 'in_attesa' && eng2.run.nodes.analisi.status !== 'attiva');
  assert.equal(eng2.run.nodes.analisi.status, 'riusata');
  assert.equal(eng2.run.nodes.analisi.attempts[0].usage.costUsd, 0);
  eng2.cancel();

  // Limite di spesa minimo: la prima fase si ferma per budget.
  const eng3 = startRun(bugWf(), 'prova', 0.0001);
  await waitFor(() => Boolean(eng3.run.nodes.analisi.pendingActions));
  assert.match(eng3.run.nodes.analisi.attempts[0].error ?? '', /limite di spesa/);
  eng3.cancel();
});

test('continua da un\'esecuzione completata: solo le fasi nuove, correzione sulla sessione originale', async () => {
  const { PHASE_SNIPPETS, PHASE_PRESETS } = await import('../../shared/types.ts');
  const { planContinuation } = await import('../engine.ts');
  const wf = fromTemplate(templates.find((t) => t.id === 'nuova-funzionalita')!);
  const eng1 = startRun(wf, 'prova', 10);
  const r1 = eng1.run;
  await waitFor(() => r1.nodes.ok_piano.status === 'attesa_intervento');
  await eng1.human('ok_piano', 'approva');
  await waitFor(() => r1.nodes.approvazione.status === 'attesa_intervento');
  await eng1.human('approvazione', 'approva');
  await waitFor(() => r1.status === 'completata');
  const implOld = r1.nodes.implementazione.attempts[0];

  // Dopo il completamento si aggiungono anteprima → approvazione → pubblicazione in coda.
  const wf2 = structuredClone(wf);
  const snip = (id: string) => structuredClone(PHASE_SNIPPETS.find((s) => s.id === id)!.data);
  wf2.nodes.push(
    { id: 'anteprima', position: { x: 0, y: 0 }, data: { ...structuredClone(PHASE_PRESETS.server) } },
    { id: 'ok_risultato', position: { x: 0, y: 0 }, data: { label: 'Approva il risultato', kind: 'approvazione', role: '', instructions: 'Verifica nel browser.', model: '', allowedTools: [], contextMode: 'sintesi', reuseResult: false } },
    { id: 'pubblica', position: { x: 0, y: 0 }, data: snip('pubblicazione') },
  );
  wf2.edges.push({ id: 'n1', source: 'approvazione', target: 'anteprima' }, { id: 'n2', source: 'anteprima', target: 'ok_risultato' }, { id: 'n3', source: 'ok_risultato', target: 'pubblica' });
  assert.deepEqual(validateWorkflow(wf2).filter((i) => i.level === 'errore'), []);
  const plan = planContinuation(wf2, r1);
  assert.deepEqual(plan.toRun.map((x) => x.nodeId), ['anteprima', 'ok_risultato', 'pubblica']);
  assert.equal(plan.reused.length, 6);

  const eng2 = startRun(wf2, 'prova', 10, r1);
  const r2 = eng2.run;
  assert.equal(r2.continuedFrom, r1.id);
  await waitFor(() => r2.nodes.ok_risultato.status === 'attesa_intervento');
  // Nessuna fase già fatta è stata rieseguita, nessun costo per le fasi riprese.
  for (const id of ['piano', 'ok_piano', 'implementazione', 'test', 'revisione', 'approvazione']) assert.equal(r2.nodes[id].status, 'riusata', id);
  assert.equal(r2.nodes.anteprima.attempts.length, 1);
  const costBeforeFix = r2.totals.costUsd!;
  assert.ok(Math.abs(costBeforeFix - r2.nodes.anteprima.attempts[0].usage.costUsd!) < 1e-9);

  // Correzione chiesta dopo l'anteprima: riprende la sessione originale dell'implementazione.
  await eng2.human('ok_risultato', 'respingi', 'Il pulsante non è allineato');
  await waitFor(() => r2.nodes.approvazione.status === 'attesa_intervento');
  const fix = r2.nodes.implementazione.attempts.at(-1)!;
  assert.equal(fix.reason, 'ripresa_con_feedback');
  assert.equal(fix.resumedSessionId, implOld.sessionId);
  assert.equal(fix.usageSource, 'delta_ripresa');
  // Il result ripreso include la spesa della prima esecuzione: si registra solo la differenza.
  assert.ok(Math.abs(mockSessionTotals(implOld.sessionId!) - (implOld.usage.costUsd! + fix.usage.costUsd!)) < 1e-9);
  assert.equal(r2.nodes.test.attempts.at(-1)!.reason, 'dopo_correzione');
  assert.equal(r2.nodes.piano.status, 'riusata');
  await eng2.human('approvazione', 'approva');
  await waitFor(() => r2.nodes.ok_risultato.status === 'attesa_intervento');
  assert.equal(r2.nodes.anteprima.attempts.length, 2);
  await eng2.human('ok_risultato', 'approva');
  await waitFor(() => r2.status === 'completata');
  assert.equal(r2.nodes.pubblica.status, 'completata');
});

test('fase server reale: avvio, indirizzo dall\'output, arresto a fine esecuzione, avvio fallito', async () => {
  const srvDir = path.join(tmp, 'srv');
  fs.mkdirSync(srvDir, { recursive: true });
  fs.writeFileSync(path.join(srvDir, 'server.cjs'), "const s=require('http').createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>console.log('  Local:   http://127.0.0.1:'+s.address().port+'/'));");
  fs.writeFileSync(path.join(srvDir, 'fail.cjs'), "console.error('porta occupata');process.exit(3);");
  const mk = (command: string): Workflow => ({
    id: 'wf_srv', name: 'Server', description: '', updatedAt: '',
    settings: { projectDir: srvDir, goal: '', maxParallel: 1, loadProjectSettings: false, applyGeneralRules: false },
    nodes: [
      { id: 'srv', position: { x: 0, y: 0 }, data: { label: 'Anteprima', kind: 'server', role: '', instructions: '', model: '', allowedTools: [], contextMode: 'nessuno', reuseResult: false, command, readyTimeoutSec: 20 } },
      { id: 'ok', position: { x: 1, y: 0 }, data: phase({ label: 'Approvazione', kind: 'approvazione', instructions: 'Verifica.', model: '', allowedTools: [] }) },
    ],
    edges: [{ id: 'e', source: 'srv', target: 'ok' }],
  });
  assert.deepEqual(validateWorkflow(mk('node server.cjs')).filter((i) => i.level === 'errore'), []);
  // Modalità reale senza agenti: nessuna chiamata a pagamento, solo il processo locale.
  const eng = startRun(mk('node server.cjs'), 'reale');
  const run = eng.run;
  await waitFor(() => run.nodes.ok.status === 'attesa_intervento', 20000);
  const svc = run.nodes.srv.service!;
  assert.equal(svc.status, 'attivo');
  assert.match(svc.url!, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.equal(await (await fetch(svc.url!)).text(), 'ok');
  assert.match(run.nodes.srv.output!, /Server locale attivo/);
  await eng.human('ok', 'approva');
  await waitFor(() => run.status === 'completata');
  assert.equal(svc.status, 'fermato');
  await waitFor(() => svc.exitCode !== undefined, 5000).catch(() => undefined);
  await assert.rejects(fetch(svc.url!), 'il processo deve essere chiuso a fine esecuzione');

  const eng2 = startRun(mk('node fail.cjs'), 'reale');
  await waitFor(() => Boolean(eng2.run.nodes.srv.pendingActions), 20000);
  assert.equal(eng2.run.nodes.srv.status, 'fallita');
  assert.match(eng2.run.nodes.srv.pendingReason ?? '', /terminato durante l'avvio[\s\S]*porta occupata/);
  eng2.cancel();
});

test('server locale "intelligente": versione di Node dal progetto, ritentativo automatico, diagnosi', async (t) => {
  const { installedNodes } = await import('../nodeenv.ts');
  const n20 = installedNodes().find((n) => n.manager !== 'sistema' && n.version.startsWith('20.'));
  const sysVer = installedNodes().find((n) => n.manager === 'sistema')?.version;
  if (!n20 || sysVer?.startsWith('20.')) return t.skip('serve una Node 20 installata con un gestore di versioni, diversa da quella di sistema');
  const base = path.join(tmp, 'smart');
  const mkProj = (name: string, files: Record<string, string>) => {
    const d = path.join(base, name);
    fs.mkdirSync(path.join(d, 'node_modules'), { recursive: true });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
    return d;
  };
  const server = "const s=require('http').createServer((q,r)=>r.end(process.version));s.listen(0,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:'+s.address().port+'/'));";
  const wfFor = (dir: string, command: string): Workflow => ({
    id: 'wf_smart', name: 'Smart', description: '', updatedAt: '',
    settings: { projectDir: dir, goal: '', maxParallel: 1, loadProjectSettings: false, applyGeneralRules: false },
    nodes: [
      { id: 'srv', position: { x: 0, y: 0 }, data: { label: 'Anteprima', kind: 'server', role: '', instructions: '', model: '', allowedTools: [], contextMode: 'nessuno', reuseResult: false, command, readyTimeoutSec: 20 } },
      { id: 'ok', position: { x: 1, y: 0 }, data: phase({ label: 'Approvazione', kind: 'approvazione', instructions: 'Verifica.', model: '', allowedTools: [] }) },
    ],
    edges: [{ id: 'e', source: 'srv', target: 'ok' }],
  });

  // 1. .nvmrc → usa la Node 20 installata invece di quella di sistema.
  const p1 = mkProj('nvmrc', { '.nvmrc': '20\n', 'package.json': '{"name":"p1"}', 'server.cjs': server });
  const e1 = startRun(wfFor(p1, 'node server.cjs'), 'reale');
  await waitFor(() => e1.run.nodes.ok.status === 'attesa_intervento', 20000);
  assert.equal(e1.run.nodes.srv.service!.node, n20.version);
  assert.equal(await (await fetch(e1.run.nodes.srv.service!.url!)).text(), `v${n20.version}`);
  e1.cancel();

  // 2. Errore "Node non supportato" senza .nvmrc/engines: diagnosi e nuovo tentativo automatico con la versione richiesta.
  const picky = `if(!process.version.startsWith('v20.')){console.error('Node.js '+process.version+' is not supported by Prova!');console.error('Please upgrade Node.js to a supported version: "20.x"');process.exit(1)}` + server;
  const p2 = mkProj('picky', { 'package.json': '{"name":"p2"}', 'server.cjs': picky });
  const e2 = startRun(wfFor(p2, 'node server.cjs'), 'reale');
  await waitFor(() => e2.run.nodes.ok.status === 'attesa_intervento', 30000);
  const a2 = e2.run.nodes.srv.attempts;
  assert.equal(a2.length, 2);
  assert.equal(a2[0].status, 'errore');
  assert.equal(e2.run.nodes.srv.service!.node, n20.version);
  assert.ok(e2.run.events.some((e) => e.text.includes('Riprovo automaticamente con Node')));
  e2.cancel();

  // 3. Modulo mancante: proposta di reinstallare le dipendenze.
  const p3 = mkProj('deps', { 'package.json': '{"name":"p3"}', 'server.cjs': "console.error(\"Error: Cannot find module 'astro'\");process.exit(1);" });
  const e3 = startRun(wfFor(p3, 'node server.cjs'), 'reale');
  await waitFor(() => Boolean(e3.run.nodes.srv.pendingActions), 20000);
  assert.ok(e3.run.nodes.srv.pendingActions!.includes('installa_dipendenze'));
  assert.match(e3.run.nodes.srv.pendingReason!, /npm install/);
  e3.cancel();

  // 4. Versione introvabile: nessun avvio, spiegazione chiara.
  const p4 = mkProj('impossibile', { 'package.json': '{"name":"p4","engines":{"node":">=999"}}', 'server.cjs': server });
  const e4 = startRun(wfFor(p4, 'node server.cjs'), 'reale');
  await waitFor(() => Boolean(e4.run.nodes.srv.pendingActions), 20000);
  assert.match(e4.run.nodes.srv.pendingReason!, /richiede Node >=999 \(package\.json engines\)/);
  assert.equal(e4.run.nodes.srv.service!.pid, undefined);
  e4.cancel();
});
