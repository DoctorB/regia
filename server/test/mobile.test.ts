import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MobileDevice, PhaseConfig, Workflow } from '../../shared/types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regia-mobile-'));
process.env.REGIA_DATA_DIR = path.join(tmp, 'data');
process.env.REGIA_GLOBAL_RULES = path.join(tmp, 'CLAUDE.md');
process.env.REGIA_MOCK_SPEED = '2';

const { findMobileProject, mobileCommand, parseAdbDevices, parseFlutterDevices, parseXctraceDevices, planMobile } = await import('../mobile.ts');
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

const phone: MobileDevice = { id: 'R58N123', name: 'Galaxy S23', platform: 'android', emulator: false };
const iphone: MobileDevice = { id: '00008110-001A', name: 'iPhone', platform: 'ios', emulator: false };

test('riconosce Flutter, React Native, Expo, Capacitor e Android con Gradle', () => {
  const flutter = project('flutter', { 'pubspec.yaml': 'name: app\nflutter:\n  uses-material-design: true\n', 'android/x': '', 'ios/x': '' });
  assert.deepEqual([findMobileProject(flutter)?.framework, findMobileProject(flutter)?.platforms], ['flutter', ['android', 'ios']]);

  const rn = project('rn', { 'package.json': JSON.stringify({ dependencies: { 'react-native': '0.74.1' } }), 'android/x': '' });
  assert.deepEqual([findMobileProject(rn)?.framework, findMobileProject(rn)?.platforms], ['react-native', ['android']]);

  const expo = project('expo', { 'package.json': JSON.stringify({ dependencies: { expo: '~51.0.0', 'react-native': '0.74.1' } }) });
  assert.equal(findMobileProject(expo)?.framework, 'expo');

  const capacitor = project('cap', { 'package.json': JSON.stringify({ dependencies: { '@capacitor/core': '6', '@capacitor/android': '6' }, scripts: { build: 'vite build' } }) });
  assert.deepEqual([findMobileProject(capacitor)?.framework, findMobileProject(capacitor)?.platforms], ['capacitor', ['android']]);

  const android = project('native', {
    gradlew: '', 'app/build.gradle.kts': 'plugins { id("com.android.application") }\nandroid { defaultConfig { applicationId = "it.example.app" } }',
  });
  const a = findMobileProject(android)!;
  assert.deepEqual([a.framework, a.module, a.appId], ['android', 'app', 'it.example.app']);

  // Kotlin Multiplatform: modulo da settings.gradle, plugin tramite alias del version catalog, applicationId da variabile.
  const kmm = project('kmm', {
    gradlew: '', 'settings.gradle.kts': 'rootProject.name = "x"\ninclude(":composeApp")\ninclude(":shared")\n',
    'build.gradle.kts': 'plugins {\n  alias(libs.plugins.androidApplication) apply false\n}\n',
    'composeApp/build.gradle.kts': 'plugins {\n  alias(libs.plugins.kotlinMultiplatform)\n  alias(libs.plugins.androidApplication)\n}\nval applicationId = "com.example.kmm"\nandroid {\n  defaultConfig {\n    applicationId = applicationId\n  }\n}\n',
    'shared/build.gradle.kts': 'plugins { alias(libs.plugins.androidLibrary) }',
  });
  const k = findMobileProject(kmm)!;
  assert.deepEqual([k.framework, k.module, k.appId], ['android', 'composeApp', 'com.example.kmm']);

  // Build composita: la radice dichiara i plugin con "apply false", l'app è un progetto Gradle in una sottocartella.
  const composite = project('composite', {
    gradlew: '', 'settings.gradle.kts': 'includeBuild("app")\n', 'build.gradle.kts': 'plugins { alias(libs.plugins.android.application) apply false }',
    'app/gradlew': '', 'app/settings.gradle.kts': 'include(":androidApp")', 'app/androidApp/build.gradle.kts': 'plugins { alias(libs.plugins.android.application) }\nandroid { namespace = "com.example.composite" }',
  });
  const c = findMobileProject(composite)!;
  assert.deepEqual([path.basename(c.abs), c.module, c.appId], ['app', 'androidApp', 'com.example.composite']);

  // Monorepo: il progetto mobile è in una sottocartella diretta.
  const mono = project('mono', { 'package.json': JSON.stringify({ dependencies: { express: '4' } }), 'mobile/pubspec.yaml': 'flutter:\n', 'mobile/android/x': '' });
  const m = findMobileProject(mono)!;
  assert.equal(m.framework, 'flutter');
  assert.equal(path.basename(m.abs), 'mobile');

  assert.equal(findMobileProject(project('web', { 'package.json': JSON.stringify({ dependencies: { react: '18' } }) })), null);
});

test('Android con product flavor: si installa la variante predefinita, con il suo applicationId', async () => {
  const { gradleFlavors } = await import('../mobile.ts');
  // Kotlin: isDefault sceglie global anche se dichiarato prima o dopo; il suffisso entra nell'applicationId.
  const kts = 'android {\n  defaultConfig { applicationId = "it.example.app" }\n  flavorDimensions += "region"\n  productFlavors {\n    create("china") {\n      dimension = "region"\n      applicationIdSuffix = ".cn"\n    }\n    create("global") {\n      dimension = "region"\n      isDefault = true\n      if (x) { signingConfig = y }\n    }\n  }\n}';
  assert.deepEqual(gradleFlavors(kts), { chosen: ['global'], others: ['china'], appIdSuffix: undefined, appId: undefined });
  // Groovy, due dimensioni nell'ordine di flavorDimensions, senza isDefault: il primo di ciascuna.
  const groovy = 'android {\n  flavorDimensions "tier", "env"\n  productFlavors {\n    prod { dimension "env" }\n    free { dimension "tier"\n applicationIdSuffix ".free" }\n    staging { dimension "env" }\n    paid { dimension "tier" }\n  }\n}';
  assert.deepEqual(gradleFlavors(groovy), { chosen: ['free', 'prod'], others: ['staging', 'paid'], appIdSuffix: '.free', appId: undefined });
  assert.equal(gradleFlavors('android { defaultConfig { } }'), undefined);

  const dir = project('flavors', { gradlew: '', 'app/build.gradle.kts': `plugins { id("com.android.application") }\n${kts}` });
  const p = findMobileProject(dir)!;
  const cmd = mobileCommand(p, 'android', phone, 'debug');
  assert.match(cmd.command, /:app:installGlobalDebug && .* -p it\.example\.app /);
  assert.ok(cmd.notes.some((n) => n.key === 'mobile.note.flavor' && n.params?.variant === 'GlobalDebug' && n.params?.others === 'china'));
});

test('comandi: compilano, installano e aprono l\'app sul dispositivo scelto', () => {
  const flutter = findMobileProject(path.join(tmp, 'flutter'))!;
  assert.equal(mobileCommand(flutter, 'android', phone, 'release').command, 'flutter run -d R58N123 --release --no-resident');

  const rn = findMobileProject(path.join(tmp, 'rn'))!;
  assert.equal(mobileCommand(rn, 'android', phone, 'release').command, 'npx react-native run-android --mode release --deviceId R58N123');
  assert.equal(mobileCommand(rn, 'ios', iphone, 'release').command, 'npx react-native run-ios --mode Release --udid 00008110-001A');
  assert.equal(mobileCommand(rn, 'android', phone, 'debug').notes[0].key, 'mobile.note.metro');
  const oldRn = { ...rn, pkg: { dependencies: { 'react-native': '^0.68.2' } } };
  assert.equal(mobileCommand(oldRn, 'android', phone, 'release').command, 'npx react-native run-android --variant release --deviceId R58N123');

  const expo = findMobileProject(path.join(tmp, 'expo'))!;
  assert.equal(mobileCommand(expo, 'android', phone, 'release').command, 'npx expo run:android --device R58N123 --variant release');

  const cap = findMobileProject(path.join(tmp, 'cap'))!;
  assert.equal(mobileCommand(cap, 'android', phone, 'debug').command, 'npm run build && npx cap sync android && npx cap run android --target R58N123');

  const native = mobileCommand(findMobileProject(path.join(tmp, 'native'))!, 'android', phone, 'debug');
  // Prima dell'installazione si fermano i daemon Gradle rimasti attivi (memoria); il loro esito non conta.
  assert.match(native.command, /^(\.\\gradlew\.bat --stop & \.\\gradlew\.bat|\.\/gradlew --stop; \.\/gradlew) :app:installDebug && \(.*adb(\.exe)?"? -s R58N123 shell monkey -p it\.example\.app .* \|\| exit 0\)$/);
  assert.deepEqual(native.env, { ANDROID_SERIAL: 'R58N123' });
});

test('elenco dei dispositivi da adb, xctrace e flutter', () => {
  const adb = parseAdbDevices('List of devices attached\nR58N123  device usb:1-1 product:x model:Galaxy_S23 device:x\nemulator-5554 device product:sdk model:sdk_gphone64 device:emu\nZY22  unauthorized usb:1-2\n\n');
  assert.deepEqual(adb.devices.map((d) => [d.id, d.name, d.emulator]), [['R58N123', 'Galaxy S23', false], ['emulator-5554', 'sdk gphone64', true]]);
  assert.equal(adb.unauthorized, 1);

  const xc = parseXctraceDevices('== Devices ==\nMacBook Pro (ABCD-1234)\niPhone di Luca (17.5) (00008110-001A)\n\n== Simulators ==\niPhone 16 Simulator (18.0) (1111-2222)\n');
  assert.deepEqual(xc.devices.map((d) => [d.id, d.name, d.platform]), [['00008110-001A', 'iPhone di Luca', 'ios']]);

  const fl = parseFlutterDevices('Waiting...\n[{"name":"Pixel 7","id":"2A1","targetPlatform":"android-arm64","emulator":false,"isSupported":true},{"name":"Windows","id":"windows","targetPlatform":"windows-x64","emulator":false}]');
  assert.deepEqual(fl.devices.map((d) => [d.id, d.platform]), [['2A1', 'android']]);
  assert.equal(parseFlutterDevices('flutter: command not found').failed, 'flutter');
});

test('rilevamento simulato e problemi chiari', async () => {
  const sim = await planMobile(path.join(tmp, 'mono'), {}, { simulate: true });
  assert.equal(sim.dir, 'mobile');
  assert.equal(sim.project, 'Flutter');
  assert.match(sim.command!, /^flutter run -d simulato --release --no-resident$/);

  assert.equal((await planMobile(path.join(tmp, 'web'))).problem?.key, 'mobile.problem.noProject');
  assert.equal((await planMobile(path.join(tmp, 'rn'), { platform: 'ios' })).problem?.key, 'mobile.problem.platformMissing');
});

test('fase Installa su dispositivo: valida senza comando, simulata in modalità di prova', async () => {
  const { phaseSnippets } = await import('../../shared/presets.ts');
  const { serverT } = await import('../i18n.ts');
  const snippet = phaseSnippets(serverT('it')).find((s) => s.id === 'app-mobile')!.data;
  assert.deepEqual(snippet.show, { target: 'dispositivo' });
  assert.equal(snippet.command, undefined);

  const wf: Workflow = {
    id: 'wf_mobile', name: 'Mobile', description: '', updatedAt: '',
    settings: { projectDir: path.join(tmp, 'mono'), goal: 'Prova', maxParallel: 1, loadProjectSettings: false, applyGeneralRules: true },
    nodes: [
      { id: 'app', position: { x: 0, y: 0 }, data: snippet as PhaseConfig },
      { id: 'ok', position: { x: 0, y: 1 }, data: { label: 'Ok', kind: 'approvazione', role: '', instructions: 'Ok', model: '', allowedTools: [], contextMode: 'sintesi', reuseResult: false } },
    ],
    edges: [{ id: 'e', source: 'app', target: 'ok' }],
  };
  assert.deepEqual(validateWorkflow(wf).filter((i) => i.level === 'errore'), []);
  const eng = startRun(wf, 'prova');
  const t0 = Date.now();
  while (eng.run.nodes.ok.status !== 'attesa_intervento') {
    if (Date.now() - t0 > 10000) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
  const svc = eng.run.nodes.app.service!;
  assert.equal(svc.status, 'completato');
  assert.equal(svc.command, 'flutter run -d simulato --release --no-resident');
  assert.equal(path.basename(svc.cwd), 'mobile');
  assert.ok(eng.run.events.some((e) => e.msg?.key === 'events.service.mobilePlanSim'));
  eng.cancel();
});

test('diagnosi: memoria esaurita di Gradle, niente falsi "permessi"', async () => {
  const { diagnose } = await import('../nodeenv.ts');
  // Il caso reale: build Gradle caduta per memoria, con nomi di classi che contengono "ePerm".
  const crash = ['> Task :feature:ble:compileKotlin', 'w: BlePermissionHelper.kt: deprecated', 'FAILURE: Build failed with an exception.', 'Gradle build daemon disappeared unexpectedly (it may have been killed or may have crashed)'];
  const d = diagnose(crash, 'it');
  assert.equal(d?.kind, 'memoria');
  assert.match(d!.message, /gradlew --stop/);
  assert.equal(diagnose(['java.lang.OutOfMemoryError: Java heap space'], 'en')?.kind, 'memoria');
  assert.equal(diagnose(['FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'], 'it')?.msg.key, 'nodeenv.diag.memory');
  // "EPERM" dentro una parola non è un errore di permessi; il codice vero sì.
  assert.equal(diagnose(['class BlePermissionHelper', 'requirePermission()'], 'it'), null);
  assert.equal(diagnose(["Error: EPERM: operation not permitted, open 'x'"], 'it')?.kind, 'permessi');
  assert.equal(diagnose(['Access is denied.'], 'it')?.kind, 'permessi');
});
