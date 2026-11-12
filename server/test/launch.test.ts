import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PhaseConfig, ShowConfig, Workflow } from '../../shared/types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regia-launch-'));
process.env.REGIA_DATA_DIR = path.join(tmp, 'data');
process.env.REGIA_GLOBAL_RULES = path.join(tmp, 'CLAUDE.md');
process.env.REGIA_MOCK_SPEED = '2';

const { detectDesktop, detectWeb, planLaunch } = await import('../launch.ts');
const store = await import('../store.ts');
const { startRun } = await import('../engine.ts');
const { validateWorkflow } = await import('../validate.ts');
store.initStore();

function project(name: string, files: Record<string, string>): string {
  const dir = path.join(tmp, name);
  for (const [f, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), content);
  }
  return dir;
}
const pkg = (deps: Record<string, string>, scripts: Record<string, string> = {}) => JSON.stringify({ dependencies: deps, scripts });

test('progetti web: Node con il gestore del lockfile, ASP.NET Core, Django, pagina statica', () => {
  const vite = project('vite', { 'package.json': pkg({ vite: '5' }, { dev: 'vite', build: 'vite build' }), 'pnpm-lock.yaml': '' });
  assert.deepEqual(detectWeb(vite), { abs: vite, project: 'Vite', command: 'pnpm run dev', check: 'url', role: 'frontend' });

  const next = project('next', { 'package.json': pkg({ next: '14', react: '18' }, { start: 'next start', dev: 'next dev' }) });
  assert.equal(detectWeb(next)?.command, 'npm run dev');
  assert.equal(detectWeb(next)?.project, 'Next.js');

  const asp = project('asp', { 'Shop.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>' });
  assert.deepEqual([detectWeb(asp)?.project, detectWeb(asp)?.command], ['ASP.NET Core', 'dotnet run --project "Shop.csproj"']);

  assert.equal(detectWeb(project('django', { 'manage.py': '' }))?.command, 'python manage.py runserver');

  const html = project('html', { 'index.html': '<h1>ciao</h1>' });
  const h = detectWeb(html)!;
  assert.equal(h.command, undefined);
  assert.match(h.url!, /^file:\/\/.*index\.html$/);

  // Un'app mobile o desktop scritta in JavaScript non è un sito.
  assert.equal(detectWeb(project('rn-web', { 'package.json': pkg({ 'react-native': '0.74' }, { start: 'react-native start' }) })), null);
  assert.equal(detectWeb(project('electron-web', { 'package.json': pkg({ electron: '30' }, { start: 'electron .' }) })), null);
});

test('app desktop: Electron, Tauri, WPF, MAUI, Flutter, Compose Desktop', () => {
  const electron = detectDesktop(path.join(tmp, 'electron-web'))!;
  assert.deepEqual([electron.project, electron.command, electron.check], ['Electron', 'npm run start', 'process']);

  const tauri = detectDesktop(project('tauri', { 'package.json': pkg({ '@tauri-apps/cli': '2', vite: '5' }, { tauri: 'tauri', dev: 'vite' }) }))!;
  assert.deepEqual([tauri.project, tauri.command, tauri.check], ['Tauri', 'npm run tauri dev', 'output']);

  const wpf = detectDesktop(project('wpf', { 'Gestionale.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>WinExe</OutputType><UseWPF>true</UseWPF></PropertyGroup></Project>' }))!;
  assert.deepEqual([wpf.project, wpf.command], ['WPF', 'dotnet run --project "Gestionale.csproj"']);

  const maui = detectDesktop(project('maui', { 'App.csproj': '<Project><PropertyGroup><TargetFrameworks>net8.0-android;net8.0-ios;net8.0-maccatalyst;net8.0-windows10.0.19041.0</TargetFrameworks><UseMaui>true</UseMaui></PropertyGroup></Project>' }))!;
  assert.equal(maui.project, '.NET MAUI');
  assert.match(maui.command!, /^dotnet run --project "App\.csproj" -f net8\.0-(windows10\.0\.19041\.0|maccatalyst)$/);

  const osDir = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const flutter = detectDesktop(project('flutter-desk', { 'pubspec.yaml': 'flutter:\n', [`${osDir}/x`]: '' }))!;
  assert.deepEqual([flutter.command, flutter.check, flutter.readyPattern], [`flutter run -d ${osDir}`, 'output', 'Flutter run key commands']);
  assert.equal(detectDesktop(project('flutter-mobile-only', { 'pubspec.yaml': 'flutter:\n', 'android/x': '' })), null);

  const compose = detectDesktop(project('compose', {
    gradlew: '', 'settings.gradle.kts': 'include(":composeApp")', 'composeApp/build.gradle.kts': 'compose.desktop {\n  application { mainClass = "MainKt" }\n}',
  }))!;
  assert.equal(compose.project, 'Compose Desktop');
  assert.match(compose.command!, /(gradlew\.bat|\.\/gradlew) :composeApp:run$/);
  assert.equal(compose.readyPattern, '> Task :composeApp:run');

  // Un sito non è un'app desktop.
  assert.equal(detectDesktop(path.join(tmp, 'vite')), null);
});

test('piano: sottocartella del monorepo, sito già attivo, problemi chiari', async () => {
  const mono = project('mono', { 'README.md': '', 'frontend/package.json': pkg({ '@angular/core': '17' }, { start: 'ng serve' }), 'desktop/Tool.csproj': '<Project><PropertyGroup><UseWindowsForms>true</UseWindowsForms></PropertyGroup></Project>' });
  const web = await planLaunch(mono, { target: 'browser' });
  assert.deepEqual([web.dir, web.project, web.command, web.check], ['frontend', 'Angular', 'npm run start', 'url']);
  const desk = await planLaunch(mono, { target: 'desktop' });
  assert.deepEqual([desk.dir, desk.project, desk.check], ['desktop', 'Windows Forms', 'process']);

  // Indirizzo indicato nella fase: ha la precedenza su quello stampato dal server.
  assert.equal((await planLaunch(mono, { target: 'browser' }, 'http://localhost:4200/admin')).url, 'http://localhost:4200/admin');

  const iis = await planLaunch(mono, { target: 'browser', existing: true }, 'http://localhost/sito');
  assert.deepEqual([iis.command, iis.url, iis.problem], [undefined, 'http://localhost/sito', undefined]);
  assert.equal((await planLaunch(mono, { target: 'browser', existing: true })).problem?.key, 'launch.problem.noUrl');

  const empty = project('vuota', { 'notes.txt': '' });
  assert.equal((await planLaunch(empty, { target: 'browser' })).problem?.key, 'launch.problem.noWeb');
  assert.equal((await planLaunch(empty, { target: 'desktop' })).problem?.key, 'launch.problem.noDesktop');
});

function wfShow(dir: string, show: ShowConfig, extra: Partial<PhaseConfig> = {}): Workflow {
  return {
    id: `wf_${show.target}`, name: 'Mostra', description: '', updatedAt: '',
    settings: { projectDir: dir, goal: 'Prova', maxParallel: 1, loadProjectSettings: false, applyGeneralRules: true },
    nodes: [
      { id: 'app', position: { x: 0, y: 0 }, data: { label: 'Mostra', kind: 'server', role: '', instructions: '', model: '', allowedTools: [], contextMode: 'nessuno', reuseResult: false, subdir: '', show, ...extra } },
      { id: 'ok', position: { x: 0, y: 1 }, data: { label: 'Ok', kind: 'approvazione', role: '', instructions: 'Ok', model: '', allowedTools: [], contextMode: 'sintesi', reuseResult: false } },
    ],
    edges: [{ id: 'e', source: 'app', target: 'ok' }],
  };
}

async function runUntilApproval(wf: Workflow, mode: 'prova' | 'reale' = 'prova') {
  const eng = startRun(wf, mode);
  const t0 = Date.now();
  while (eng.run.nodes.ok.status !== 'attesa_intervento' && eng.run.nodes.app.status !== 'fallita') {
    if (Date.now() - t0 > 10000) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
  return eng;
}

test('fasi browser e desktop: valide senza comando, simulate in modalità di prova', async () => {
  const mono = path.join(tmp, 'mono');
  for (const target of ['browser', 'desktop'] as const) {
    const wf = wfShow(mono, { target });
    assert.deepEqual(validateWorkflow(wf).filter((i) => i.level === 'errore'), [], target);
    const eng = await runUntilApproval(wf);
    const svc = eng.run.nodes.app.service!;
    assert.equal(svc.status, 'simulato', target);
    assert.equal(path.basename(svc.cwd), target === 'browser' ? 'frontend' : 'desktop');
    assert.equal(svc.command, target === 'browser' ? 'npm run start' : 'dotnet run --project "Tool.csproj"');
    assert.ok(eng.run.events.some((e) => e.msg?.key === 'events.service.launchPlan'), target);
    eng.cancel();
  }
  // Sito già attivo senza indirizzo: errore di validazione.
  const noUrl = validateWorkflow(wfShow(mono, { target: 'browser', existing: true }));
  assert.ok(noUrl.some((i) => i.msg?.key === 'validate.showNeedsUrl'));
});

test('sito con frontend e backend separati: si apre il frontend, il backend parte insieme', async () => {
  const fs2 = project('fullstack', {
    'fe/package.json': pkg({ '@angular/core': '17' }, { start: 'ng serve' }),
    'be/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
  });
  const p = await planLaunch(fs2, { target: 'browser' });
  assert.deepEqual([p.dir, p.project, p.companion], ['fe', 'Angular', { dir: 'be', project: 'ASP.NET Core', command: 'dotnet run --project "Api.csproj"', enabled: true }]);
  assert.equal((await planLaunch(fs2, { target: 'browser', noCompanion: true })).companion?.enabled, false);
  // Solo il backend: si apre quello.
  const onlyBe = project('only-be', { 'api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>', 'docs/index.html': '' });
  assert.deepEqual([(await planLaunch(onlyBe, { target: 'browser' })).dir, (await planLaunch(onlyBe, { target: 'browser' })).companion], ['api', undefined]);
});

test('esecuzione reale: frontend e backend avviati insieme, pagina aperta, entrambi fermati alla fine', async () => {
  process.env.REGIA_NO_BROWSER = '1';
  const server = (name: string) => `const s = require('http').createServer((q, r) => r.end('${name}')); s.listen(0, () => console.log('${name} pronto su http://localhost:' + s.address().port + '/'));`;
  const dir = project('live', {
    'fe/package.json': JSON.stringify({ dependencies: { vite: '5' }, scripts: { dev: 'node fe.cjs' } }),
    'fe/fe.cjs': server('frontend'),
    'fe/node_modules/.keep': '',
    'be/package.json': JSON.stringify({ dependencies: { express: '4' }, scripts: { start: 'node be.cjs' } }),
    'be/be.cjs': server('backend'),
  });
  const eng = await runUntilApproval(wfShow(dir, { target: 'browser', browser: 'chrome' }), 'reale');
  let beUrl = '';
  try {
    const st = eng.run.nodes.app;
    assert.equal(st.status, 'completata', st.pendingReason ?? '');
    assert.match(st.service!.url!, /^http:\/\/localhost:\d+\/$/);
    // Il backend può stampare l'indirizzo poco dopo che il frontend è pronto.
    const t1 = Date.now();
    while (!beUrl && Date.now() - t1 < 8000) {
      beUrl = st.service!.log.find((l) => /^\[be\] backend pronto/.test(l))?.match(/http:\S+/)?.[0] ?? '';
      if (!beUrl) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(beUrl, st.service!.log.join('\n'));
    assert.ok(eng.run.events.some((e) => e.msg?.key === 'events.service.companion'));
    assert.ok(eng.run.events.some((e) => e.msg?.key === 'events.service.browserOpened' && e.msg.params?.browser === 'Chrome'));
    assert.equal(await fetch(beUrl).then((r) => r.text()), 'backend');
  } finally {
    eng.cancel();
  }
  // Alla fine dell'esecuzione anche il backend viene chiuso.
  const t0 = Date.now();
  let down = false;
  while (!down && Date.now() - t0 < 8000) {
    down = await fetch(beUrl).then(() => false, () => true);
    if (!down) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(down, 'backend ancora attivo');
});

test('esecuzione reale: progetto non riconosciuto → la fase si ferma con la spiegazione', async () => {
  const eng = await runUntilApproval(wfShow(path.join(tmp, 'vuota'), { target: 'desktop' }), 'reale');
  const st = eng.run.nodes.app;
  assert.equal(st.status, 'fallita');
  assert.equal(st.pendingMsg?.key, 'launch.problem.noDesktop');
  assert.deepEqual(st.pendingActions, ['riprova', 'salta', 'annulla']);
  eng.cancel();
});
