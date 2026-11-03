import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { PhaseConfig, Workflow } from '../../shared/types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regia-app-'));
process.env.REGIA_DATA_DIR = path.join(tmp, 'data');
process.env.REGIA_GLOBAL_RULES = path.join(tmp, 'CLAUDE.md');
process.env.REGIA_MOCK_SPEED = '2';
// Progetto non Node: nessun package.json, script eseguiti con la Node di sistema tramite percorso esplicito.
const dir = path.join(tmp, 'app');
fs.mkdirSync(dir);
const NODE = JSON.stringify(process.execPath);

const store = await import('../store.ts');
const { startRun, readyMatcher } = await import('../engine.ts');
const { validateWorkflow } = await import('../validate.ts');
store.initStore();

const waitFor = async (cond: () => boolean, ms = 15000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const wfWith = (app: Partial<PhaseConfig>): Workflow => ({
  id: 'wf_app', name: 'App', description: '', updatedAt: '',
  settings: { projectDir: dir, goal: '', maxParallel: 1, loadProjectSettings: false, applyGeneralRules: false },
  nodes: [
    { id: 'app', position: { x: 0, y: 0 }, data: { label: 'App', kind: 'server', role: '', instructions: '', model: '', allowedTools: [], contextMode: 'nessuno', reuseResult: false, readyTimeoutSec: 15, ...app } },
    { id: 'ok', position: { x: 0, y: 1 }, data: { label: 'Verifica', kind: 'approvazione', role: '', instructions: 'Verifica.', model: '', allowedTools: [], contextMode: 'sintesi', reuseResult: false } },
  ],
  edges: [{ id: 'e', source: 'app', target: 'ok' }],
});
const script = (name: string, code: string) => { fs.writeFileSync(path.join(dir, name), code); return `${NODE} ${name}`; };

test('testo atteso: testo semplice senza maiuscole o espressione regolare', () => {
  assert.ok(readyMatcher('flutter run key commands')('Flutter run key commands.'));
  assert.ok(readyMatcher('/Installed on \\d+ devices?/')('Installed on 1 device.'));
  assert.ok(!readyMatcher('/^ready$/')('not ready'));
  assert.ok(!readyMatcher('')('anything'));
  assert.ok(readyMatcher('/[unclosed/')('a /[unclosed/ b'), 'espressione non valida: usata come testo');
});

test('validazione: comando o indirizzo, testo atteso obbligatorio', () => {
  const errs = (p: Partial<PhaseConfig>) => validateWorkflow(wfWith(p)).filter((i) => i.level === 'errore').map((i) => i.msg?.key);
  assert.deepEqual(errs({ command: '', url: '' }), ['validate.serverNoCommand']);
  assert.deepEqual(errs({ command: '', url: 'http://localhost/' }), [], 'sito già servito (IIS): basta l\'indirizzo');
  assert.deepEqual(errs({ command: '', url: 'http://localhost/', readyCheck: 'process' }), ['validate.externalNeedsUrl']);
  assert.deepEqual(errs({ command: 'flutter run', readyCheck: 'output' }), ['validate.readyPatternMissing']);
  assert.deepEqual(errs({ command: 'msbuild', readyCheck: 'exit', readyTimeoutSec: 1800 }), []);
});

test('servizio esterno (es. IIS): solo verifica dell\'indirizzo, anche con risposta 401', async () => {
  const srv = http.createServer((_q, r) => { r.statusCode = 401; r.end(); });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/sito/`;
  const eng = startRun(wfWith({ command: '', url }), 'reale');
  await waitFor(() => eng.run.nodes.ok.status === 'attesa_intervento');
  const svc = eng.run.nodes.app.service!;
  assert.equal(svc.status, 'attivo');
  assert.equal(svc.external, true);
  assert.equal(svc.pid, undefined);
  assert.equal(svc.node, undefined);
  assert.match(eng.run.nodes.app.output!, /Servizio verificato: .* risponde/);
  await eng.human('ok', 'approva');
  await waitFor(() => eng.run.status === 'completata');
  srv.close();
});

test('testo atteso nell\'output (es. app mobile su emulatore), senza preparazione di Node', async () => {
  const cmd = script('mobile.cjs', "console.log('Launching on emulator-5554...');setTimeout(()=>console.log('Flutter run key commands.'),300);setInterval(()=>{},1000);");
  const eng = startRun(wfWith({ command: cmd, readyCheck: 'output', readyPattern: 'flutter run key commands' }), 'reale');
  await waitFor(() => eng.run.nodes.ok.status === 'attesa_intervento');
  const svc = eng.run.nodes.app.service!;
  assert.equal(svc.status, 'attivo');
  assert.equal(svc.node, undefined, 'progetto non Node: nessuna versione di Node scelta');
  assert.match(eng.run.nodes.app.output!, /App avviata e aperta per la verifica/);
  await eng.human('ok', 'approva');
  await waitFor(() => eng.run.status === 'completata');
  assert.equal(svc.status, 'fermato', 'chiusa a fine esecuzione');

  // Testo mai comparso: errore chiaro.
  const cmd2 = script('silent.cjs', "console.log('compilazione...');setInterval(()=>{},1000);");
  const e2 = startRun(wfWith({ command: cmd2, readyCheck: 'output', readyPattern: 'READY', readyTimeoutSec: 5 }), 'reale');
  await waitFor(() => Boolean(e2.run.nodes.app.pendingActions));
  assert.match(e2.run.nodes.app.pendingReason!, /il testo "READY" non è comparso nell'output entro 5 secondi/);
  e2.cancel();
});

test('programma che resta aperto (app desktop) e lanciatore che termina con 0', async () => {
  const cmd = script('desktop.cjs', "console.log('finestra aperta');setInterval(()=>{},1000);");
  const eng = startRun(wfWith({ command: cmd, readyCheck: 'process' }), 'reale');
  await waitFor(() => eng.run.nodes.ok.status === 'attesa_intervento');
  assert.equal(eng.run.nodes.app.service!.status, 'attivo');
  eng.cancel();
  await waitFor(() => eng.run.nodes.app.service!.status === 'fermato');

  const cmd2 = script('launcher.cjs', "console.log('avviata in una finestra separata');");
  const e2 = startRun(wfWith({ command: cmd2, readyCheck: 'process' }), 'reale');
  await waitFor(() => e2.run.nodes.ok.status === 'attesa_intervento');
  assert.equal(e2.run.nodes.app.service!.status, 'completato');
  e2.cancel();

  const cmd3 = script('crash.cjs', "console.error('DLL mancante');process.exit(2);");
  const e3 = startRun(wfWith({ command: cmd3, readyCheck: 'process' }), 'reale');
  await waitFor(() => Boolean(e3.run.nodes.app.pendingActions));
  assert.match(e3.run.nodes.app.pendingReason!, /terminato durante l'avvio \(codice 2\)[\s\S]*DLL mancante/);
  e3.cancel();
});

test('comando che deve terminare con successo (build, installazione, deploy)', async () => {
  const ok = script('build.cjs', "console.log('Build succeeded.');");
  const eng = startRun(wfWith({ command: ok, readyCheck: 'exit' }), 'reale');
  await waitFor(() => eng.run.nodes.ok.status === 'attesa_intervento');
  assert.equal(eng.run.nodes.app.service!.status, 'completato');
  assert.match(eng.run.nodes.app.output!, /^Comando completato: /);
  eng.cancel();

  const ko = script('build-ko.cjs', "console.error('error CS1002: ; expected');process.exit(1);");
  const e2 = startRun(wfWith({ command: ko, readyCheck: 'exit' }), 'reale');
  await waitFor(() => Boolean(e2.run.nodes.app.pendingActions));
  assert.match(e2.run.nodes.app.pendingReason!, /il comando è terminato con codice 1[\s\S]*CS1002/);
  e2.cancel();
});

test('modalità di prova: ogni criterio simulato senza eseguire comandi', async () => {
  for (const [p, status] of [
    [{ command: 'flutter run', readyCheck: 'output', readyPattern: 'ready' }, 'simulato'],
    [{ command: 'dotnet run', readyCheck: 'process' }, 'simulato'],
    [{ command: 'msbuild', readyCheck: 'exit' }, 'completato'],
    [{ command: '', url: 'http://localhost/' }, 'simulato'],
  ] as const) {
    const eng = startRun(wfWith(p as Partial<PhaseConfig>), 'prova');
    await waitFor(() => eng.run.nodes.ok.status === 'attesa_intervento');
    assert.equal(eng.run.nodes.app.service!.status, status, JSON.stringify(p));
    assert.equal(eng.run.nodes.app.service!.pid, undefined);
    eng.cancel();
  }
});

test('fasi pronte della palette (web, IIS, desktop, iOS, mobile): valide così come sono', async () => {
  const { phaseSnippets } = await import('../../shared/presets.ts');
  const { serverT } = await import('../i18n.ts');
  for (const lang of ['it', 'en']) {
    const apps = phaseSnippets(serverT(lang)).filter((s) => s.data.kind === 'server');
    assert.deepEqual(apps.map((s) => s.id), ['app-web', 'app-iis', 'app-desktop', 'app-ios', 'app-mobile']);
    for (const s of apps) {
      const errs = validateWorkflow(wfWith(s.data)).filter((i) => i.level === 'errore');
      assert.deepEqual(errs, [], `${lang} ${s.id}`);
    }
  }
  const ios = phaseSnippets(serverT('it')).find((s) => s.id === 'app-ios')!.data;
  assert.equal(ios.readyCheck, 'exit');
  assert.match(ios.command!, /^xcodebuild .*xcrun simctl install booted .*xcrun simctl launch booted /);
});
