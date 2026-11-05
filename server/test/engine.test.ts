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
const { serverT } = await import('../i18n.ts');
const { principlesText } = await import('../../shared/principles.ts');
const { runReport } = await import('../../shared/report.ts');
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

test('principi di progettazione: indicazioni per tipo di fase, checklist nelle approvazioni', async () => {
  const t = serverT('it');
  assert.equal(principlesText(undefined, 'implementazione', t), '');
  assert.equal(principlesText(['kiss'], 'server', t), '');
  const impl = principlesText(['yagni', 'sconosciuto', 'kiss'], 'implementazione', t);
  // Ordine fisso (KISS prima di YAGNI), id sconosciuti ignorati, indicazioni specifiche dell'implementazione.
  assert.match(impl, /^# Principi di progettazione[\s\S]*## KISS[\s\S]*astrazione[\s\S]*## YAGNI/);
  assert.doesNotMatch(impl, /sconosciuto/);
  assert.notEqual(principlesText(['kiss'], 'revisione', t), principlesText(['kiss'], 'analisi', t));
  assert.match(principlesText(['solid'], 'implementazione', serverT('en')), /single responsibility|one responsibility/i);

  const wf = bugWf();
  wf.settings.principles = ['kiss', 'dry'];
  const eng = startRun(wf, 'prova', 5);
  const run = eng.run;
  assert.ok(run.events.some((e) => e.text === 'Principi di progettazione applicati alle fasi: KISS, DRY.'));
  await waitFor(() => run.nodes.approvazione.status === 'attesa_intervento');
  assert.match(run.nodes.approvazione.pendingReason!, /Principi del workflow, da verificare:\n- KISS:[\s\S]*\n- DRY:/);
  eng.cancel();
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
  for (const i of insights) assert.ok(i.tradeoff.key.length > 0);

  // Resoconto: fasi in ordine, decisioni, file modificati e interventi con il commento.
  const report = runReport(run, serverT('it'), 'it-IT');
  assert.ok(report.startsWith(`# Resoconto: ${run.workflowName}\n`));
  assert.ok(report.includes('| Stato | Completata |'));
  assert.ok(report.includes('## Obiettivo\n\nObiettivo di prova'));
  for (const n of run.snapshot.nodes) assert.ok(report.includes(`. ${n.data.label}\n`), n.data.label);
  assert.ok(report.includes('**Decisioni dichiarate**\n\n- '));
  assert.ok(report.includes('- `src/modulo.js`'));
  assert.ok(report.includes(': Respingi con commento — "Aggiungi un commento che spieghi la correzione"'));
  assert.ok(report.includes(': Approva\n'));
  assert.ok(!/\{\w+\}|\breport\.\w|\bevents\.\w/.test(report), 'nessuna chiave o parametro non tradotto');
  const en = runReport(run, serverT('en'), 'en-US');
  assert.match(en, /^# Report: /);
  assert.match(en, /: Reject with comment — "/);
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
  const { phasePreset, phaseSnippets } = await import('../../shared/presets.ts');
  const { serverT } = await import('../i18n.ts');
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
  const snip = (id: string) => structuredClone(phaseSnippets(serverT('it')).find((s) => s.id === id)!.data);
  wf2.nodes.push(
    { id: 'anteprima', position: { x: 0, y: 0 }, data: phasePreset('server', serverT('it')) },
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
  assert.match(run.nodes.srv.output!, /App attiva: http/);
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

test('workflow in inglese: eventi, protocollo e testi simulati nella lingua del workflow', async () => {
  const { agentProtocol, parseDecisionLine } = await import('../engine.ts');
  // Protocollo: istruzioni nella lingua scelta, parti lette da Regia invariate.
  const en = agentProtocol('en');
  const it = agentProtocol('it');
  assert.match(en, /^# Response protocol/);
  assert.match(en, /"DECISION:"/);
  assert.match(it, /"DECISIONE:"/);
  for (const p of [en, it]) {
    assert.match(p, /```regia\n\{"esito": "ok" \| "ko" \| "bloccato", "sintesi": .*"decisioni": \[/);
  }
  // Le righe di decisione sono riconosciute in entrambe le lingue, anche in grassetto.
  assert.equal(parseDecisionLine('DECISION: read the tests first'), 'read the tests first');
  assert.equal(parseDecisionLine('**Decisione:** parto dai test'), 'parto dai test');
  assert.equal(parseDecisionLine('  **DECISIONE**: modifico un file'), 'modifico un file');
  assert.equal(parseDecisionLine('The decision: nope'), null);

  const wf: Workflow = {
    id: 'wf_en', name: 'English', description: '', updatedAt: '',
    settings: { projectDir, goal: 'Test goal', maxParallel: 1, loadProjectSettings: false, applyGeneralRules: true, language: 'en' },
    nodes: [{ id: 'analysis', position: { x: 0, y: 0 }, data: phase({ label: 'Analysis', kind: 'analisi', instructions: 'Analyse.', allowedTools: ['Read'] }) }],
    edges: [],
  };
  const eng = startRun(wf, 'prova', 5);
  const run = eng.run;
  await waitFor(() => run.status === 'completata');
  assert.equal(run.events[0].text, 'Run started in dry-run mode (no paid calls).');
  assert.deepEqual(run.events[0].msg, { key: 'events.runStarted.test', params: undefined });
  assert.ok(run.events.some((e) => e.text.startsWith('General rules applied to every phase')));
  assert.ok(run.events.some((e) => e.msg?.key === 'events.phaseStarted.initialLimit' && e.text.startsWith('Analysis: started. Model: sonnet')));
  assert.ok(run.events.some((e) => e.text === 'Run completed.'));
  // Il testo simulato dell'agente segue la lingua: "DECISION:" riconosciuto e tolto dal testo della decisione.
  const declared = run.events.filter((e) => e.kind === 'decisione' && e.source === 'dichiarata').map((e) => e.text);
  assert.ok(declared.includes('The cause is limited to a single module; there is no need to touch the rest of the project.'), declared.join(' | '));
  assert.match(run.nodes.analysis.output!, /completed in simulation/);
  // Nessun testo di Regia in italiano negli eventi generati da Regia.
  for (const e of run.events.filter((x) => x.msg)) assert.doesNotMatch(e.text, /Esecuzione|avviata|Regole generali/, e.text);
  assert.match(rulesPrompt(run.rules, 'en'), /^\n\n# General rules\nAlways follow these rules/);
});

test('motivi della continuazione e risposte di errore localizzabili', async () => {
  const { planContinuation, RegiaError } = await import('../engine.ts');
  const wf = bugWf();
  const eng = startRun(wf, 'prova', 5);
  await assert.rejects(eng.human('analisi', 'approva'), (e: unknown) => e instanceof RegiaError && e.msg.key === 'api.actionUnavailable' && /non disponibile/.test(e.message));
  eng.cancel();
  const wf2 = structuredClone(wf);
  wf2.nodes[0].data.instructions += ' (modificata)';
  const plan = planContinuation(wf2, eng.run);
  const first = plan.toRun[0];
  assert.equal(first.reasonMsg?.key, 'continuation.configChanged');
  assert.equal(first.reason, 'configurazione modificata');
  wf2.settings.language = 'en';
  assert.equal(planContinuation(wf2, eng.run).toRun[0].reason, 'configuration changed');
});

test('sospendi e riprendi: stessa sessione con la cache valida, riassunto con la cache scaduta, approvazioni in attesa', async () => {
  const { resumeRun, getEngine } = await import('../engine.ts');
  const { interruptedSummary } = await import('../resume.ts');
  const speed = process.env.REGIA_MOCK_SPEED;
  process.env.REGIA_MOCK_SPEED = '60';
  try {
    // 1. Sospensione durante l'analisi, ripresa entro la durata della cache: stessa sessione.
    const eng = startRun(bugWf(), 'prova', 5);
    const id = eng.run.id;
    const analisi = () => eng.run.nodes.analisi;
    await waitFor(() => Boolean(analisi().attempts[0]?.sessionId) && eng.run.events.some((e) => e.kind === 'strumento' && e.nodeId === 'analisi'));
    await eng.suspend();
    assert.equal(getEngine(id), undefined);
    const saved = store.getRun(id)!;
    assert.equal(saved.status, 'sospesa');
    assert.ok(saved.suspendedAt);
    assert.equal(saved.nodes.analisi.status, 'in_attesa');
    assert.equal(saved.nodes.analisi.attempts[0].status, 'interrotta');
    assert.equal(saved.nodes.analisi.interrupted?.sessionId, saved.nodes.analisi.attempts[0].sessionId);
    assert.equal(saved.nodes.correzione.attempts.length, 0, 'le fasi successive non partono');

    // Il riassunto per una sessione nuova contiene i passi registrati.
    const summary = interruptedSummary(saved, 'analisi', saved.nodes.analisi.interrupted!, serverT('it'));
    assert.match(summary, /^## Lavoro già svolto in un tentativo interrotto/);
    assert.match(summary, /\n- (Read|Grep|Glob) /);

    process.env.REGIA_CACHE_TTL_SEC = '3600';
    const eng2 = resumeRun(id);
    const r2 = eng2.run;
    assert.equal(r2.status, 'in_corso');
    await waitFor(() => r2.nodes.approvazione.status === 'attesa_intervento');
    const a = r2.nodes.analisi.attempts;
    assert.equal(a.length, 2);
    assert.equal(a[1].reason, 'ripresa_dopo_interruzione');
    assert.equal(a[1].resumedSessionId, a[0].sessionId);
    assert.equal(r2.nodes.analisi.interrupted, undefined);
    assert.ok(r2.events.some((e) => e.msg?.key === 'events.interrupted.session'));

    // 2. Sospensione con un'approvazione in attesa: resta in attesa e torna disponibile alla ripresa.
    await eng2.suspend();
    const s2 = store.getRun(id)!;
    assert.equal(s2.nodes.approvazione.status, 'attesa_intervento');
    assert.deepEqual(s2.nodes.approvazione.pendingActions, ['approva', 'respingi', 'annulla']);
    assert.equal(getEngine(id), undefined, 'una sospesa non accetta azioni finché non viene ripresa');
    const eng3 = resumeRun(id);
    await eng3.human('approvazione', 'approva');
    await waitFor(() => eng3.run.status === 'completata');

    // 3. Cache scaduta: sessione nuova con il riassunto del lavoro interrotto.
    process.env.REGIA_CACHE_TTL_SEC = '0';
    const eng4 = startRun(bugWf(), 'prova', 5);
    await waitFor(() => Boolean(eng4.run.nodes.analisi.attempts[0]?.sessionId));
    await eng4.suspend();
    const eng5 = resumeRun(eng4.run.id);
    await waitFor(() => eng5.run.nodes.analisi.attempts.length === 2 && eng5.run.nodes.analisi.status !== 'attiva');
    const b = eng5.run.nodes.analisi.attempts[1];
    assert.equal(b.reason, 'ripresa_dopo_interruzione');
    assert.equal(b.resumedSessionId, undefined);
    assert.notEqual(b.sessionId, eng5.run.nodes.analisi.attempts[0].sessionId);
    assert.ok(eng5.run.events.some((e) => e.msg?.key === 'events.interrupted.summary'));
    eng5.cancel();
  } finally {
    process.env.REGIA_MOCK_SPEED = speed;
    delete process.env.REGIA_CACHE_TTL_SEC;
  }
});

test('Regia chiuso durante un\'esecuzione: all\'avvio diventa interrotta e si riprende', async () => {
  const { resumeRun } = await import('../engine.ts');
  const { recoverInterruptedRuns } = await import('../resume.ts');
  const speed = process.env.REGIA_MOCK_SPEED;
  process.env.REGIA_MOCK_SPEED = '60';
  try {
    const eng = startRun(bugWf(), 'prova', 5);
    await waitFor(() => Boolean(eng.run.nodes.analisi.attempts[0]?.sessionId));
    // Stato salvato al momento della chiusura improvvisa: fase attiva, tentativo attivo.
    const crashed = structuredClone(eng.run);
    eng.cancel();
    await new Promise((r) => setTimeout(r, 400));
    store.saveRun(crashed);
    recoverInterruptedRuns();
    const r = store.getRun(crashed.id)!;
    assert.equal(r.status, 'interrotta');
    assert.equal(r.nodes.analisi.status, 'in_attesa');
    assert.equal(r.nodes.analisi.attempts[0].status, 'interrotta');
    assert.ok(r.nodes.analisi.interrupted);
    assert.ok(r.notes.some((n) => n.includes('Riprendi')));

    process.env.REGIA_CACHE_TTL_SEC = '3600';
    const eng2 = resumeRun(r.id);
    assert.ok(!eng2.run.notes.some((n) => n.includes('Riprendi')), 'la nota sull\'interruzione viene tolta');
    await waitFor(() => eng2.run.nodes.approvazione.status === 'attesa_intervento');
    assert.equal(eng2.run.nodes.analisi.attempts[1].resumedSessionId, crashed.nodes.analisi.attempts[0].sessionId);
    eng2.cancel();
  } finally {
    process.env.REGIA_MOCK_SPEED = speed;
    delete process.env.REGIA_CACHE_TTL_SEC;
  }
});

test('allineamento e verifica: esecuzione di riferimento passata alle fasi, correzione dal test funzionale', async () => {
  // Esecuzione della funzionalità da allineare.
  const feat = startRun(bugWf(), 'prova', 5);
  await waitFor(() => feat.run.nodes.approvazione.status === 'attesa_intervento');
  await feat.human('approvazione', 'approva');
  await waitFor(() => feat.run.status === 'completata');

  const tpl = templates.find((t) => t.id === 'allineamento-verifica')!;
  assert.equal(tpl.settings.referenceRun, true);
  assert.ok(store.listTemplates('en').some((t) => t.id === 'allineamento-verifica' && t.name === 'Sync and verify'));
  const wf = fromTemplate(tpl);
  assert.deepEqual(validateWorkflow(wf, 'prova'), [], 'il preset non ha errori né avvisi');
  const eng = startRun(wf, 'prova', 5, undefined, feat.run);
  const r = eng.run;
  const ref = r.reference!;
  assert.equal(ref.runId, feat.run.id);
  // Resoconto compatto: obiettivo, risultati e file, senza intestazione né costi.
  assert.match(ref.text, /^## Obiettivo\n\nObiettivo di prova/);
  assert.ok(ref.text.includes('. Correzione\n'));
  assert.ok(ref.text.includes('- `src/modulo.js`'));
  assert.ok(!ref.text.includes('$') && !ref.text.includes('| |'));
  assert.ok(r.events.some((e) => e.msg?.key === 'events.reference'));

  // Il test funzionale respinto torna alla fase di allineamento; test, revisione e checklist vengono rifatti.
  await waitFor(() => r.nodes.test_funzionale.status === 'attesa_intervento');
  assert.match(r.nodes.test_funzionale.pendingReason ?? '', /checklist/);
  await eng.human('test_funzionale', 'respingi', 'Il totale ordine non si aggiorna');
  await waitFor(() => r.nodes.test_funzionale.status === 'attesa_intervento' && r.nodes.checklist.attempts.length === 2);
  assert.equal(r.nodes.allineamento.attempts.at(-1)!.reason, 'ripresa_con_feedback');
  assert.equal(r.nodes.allineamento.attempts.at(-1)!.feedback, 'Il totale ordine non si aggiorna');
  await eng.human('test_funzionale', 'approva');
  await waitFor(() => r.status === 'completata');
  assert.equal(r.nodes.pubblicazione.status, 'completata');
  const report = runReport(r, serverT('it'), 'it-IT');
  assert.ok(report.includes(`| Esecuzione di riferimento | ${feat.run.workflowName} · \`${feat.run.id}\` |`));

  // Una continuazione mantiene il riferimento; senza l'impostazione nel workflow il riferimento è ignorato.
  const cont = startRun(wf, 'prova', 5, r);
  assert.equal(cont.run.reference?.runId, feat.run.id);
  cont.cancel();
  const off = startRun({ ...wf, settings: { ...wf.settings, referenceRun: false } }, 'prova', 5, undefined, feat.run);
  assert.equal(off.run.reference, undefined);
  off.cancel();
});
