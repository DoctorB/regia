// Installazione su dispositivo: riconosce il progetto mobile (Flutter, React Native, Expo, Capacitor, Android con
// Gradle), trova i dispositivi collegati e compone il comando che compila, installa e apre l'app.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { msg, type Msg } from '../shared/i18n.ts';
import type { LaunchPlan, MobileBuild, MobileDevice, MobilePlatform, ShowConfig } from '../shared/types.ts';

export type MobileFramework = 'flutter' | 'react-native' | 'expo' | 'capacitor' | 'android';
export const MOBILE_FRAMEWORK_NAMES: Record<MobileFramework, string> = {
  flutter: 'Flutter', 'react-native': 'React Native', expo: 'Expo', capacitor: 'Capacitor', android: 'Android (Gradle)',
};

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';

interface Project {
  abs: string;
  framework: MobileFramework;
  platforms: MobilePlatform[];
  pkg?: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
  /** Solo Android nativo: modulo dell'app e applicationId (per aprirla dopo l'installazione). */
  module?: string;
  appId?: string;
}

export function readText(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

export function readJson<T>(file: string): T | null {
  const s = readText(file);
  if (s === null) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

const platformsOf = (android: unknown, ios: unknown): MobilePlatform[] =>
  [android ? 'android' : null, ios ? 'ios' : null].filter(Boolean) as MobilePlatform[];

/** Moduli dichiarati in settings.gradle(.kts) con include (non includeBuild), come percorsi relativi. */
export function gradleModules(settings: string): string[] {
  const out: string[] = [];
  for (const m of settings.matchAll(/\binclude\b\s*\(?([^)\n]+)/g)) {
    for (const q of m[1].matchAll(/["']:?([\w:.-]+)["']/g)) out.push(q[1].replace(/:/g, '/'));
  }
  return out;
}

// Plugin dell'applicazione Android: id diretto o alias del version catalog (android.application, androidApplication).
const APP_PLUGIN = /com\.android\.application|plugins\.android[.-]?application\b|plugins\.androidApplication\b/i;

/** applicationId scritto direttamente, tramite una variabile (val id = "…") o, in mancanza, il namespace. */
export function gradleAppId(gradle: string): string | undefined {
  const direct = gradle.match(/applicationId\s*=?\s*["']([\w.]+)["']/)?.[1];
  if (direct) return direct;
  const v = gradle.match(/applicationId\s*=\s*([A-Za-z_]\w*)\s*$/m)?.[1];
  const viaVar = v ? gradle.match(new RegExp(`(?:val|var|def)\\s+${v}\\s*=\\s*["']([\\w.]+)["']`))?.[1] : undefined;
  return viaVar ?? gradle.match(/namespace\s*=?\s*["']([\w.]+)["']/)?.[1];
}

/** Modulo Android con il plugin dell'applicazione: quelli di settings.gradle, altrimenti "app" e le altre sottocartelle. */
function androidApp(abs: string): { module: string; appId?: string } | null {
  const settings = readText(path.join(abs, 'settings.gradle.kts')) ?? readText(path.join(abs, 'settings.gradle'));
  let mods = settings ? gradleModules(settings) : [];
  if (!mods.length) {
    try { mods = fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name); } catch { return null; }
  }
  mods.sort((a, b) => Number(b === 'app') - Number(a === 'app'));
  for (const m of mods) {
    const gradle = readText(path.join(abs, m, 'build.gradle.kts')) ?? readText(path.join(abs, m, 'build.gradle'));
    // "apply false" dichiara il plugin senza applicarlo (tipico del build file principale).
    const applied = gradle?.split(/\r?\n/).filter((l) => !/apply\s+false/.test(l)).join('\n');
    if (applied && APP_PLUGIN.test(applied)) return { module: m.replace(/\//g, ':'), appId: gradleAppId(gradle!) };
  }
  return null;
}

function detectAt(abs: string): Project | null {
  const has = (p: string) => fs.existsSync(path.join(abs, p));
  const pub = readText(path.join(abs, 'pubspec.yaml'));
  if (pub && /^\s*flutter\s*:/m.test(pub)) return { abs, framework: 'flutter', platforms: platformsOf(has('android'), has('ios')) };
  const pkg = readJson<NonNullable<Project['pkg']>>(path.join(abs, 'package.json'));
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.expo && deps['react-native']) return { abs, framework: 'expo', platforms: ['android', 'ios'], pkg };
    if (deps['react-native']) return { abs, framework: 'react-native', platforms: platformsOf(has('android'), has('ios')), pkg };
    if (deps['@capacitor/core']) {
      return { abs, framework: 'capacitor', platforms: platformsOf(has('android') || deps['@capacitor/android'], has('ios') || deps['@capacitor/ios']), pkg };
    }
  }
  if (has('gradlew') || has('gradlew.bat')) {
    const app = androidApp(abs);
    if (app) return { abs, framework: 'android', platforms: ['android'], ...app };
  }
  return null;
}

const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'out', 'Pods', 'bin', 'obj', 'target']);

/** Il progetto mobile nella cartella indicata o, se non c'è, in una sua sottocartella diretta. */
export function findMobileProject(base: string): Project | null {
  const here = detectAt(base);
  if (here) return here;
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .map((e) => e.name).sort();
  } catch { return null; }
  for (const d of dirs) {
    const p = detectAt(path.join(base, d));
    if (p) return p;
  }
  return null;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    // Su Windows gli strumenti come flutter sono script .bat: servono la shell.
    const shell = WIN && !/\.exe$/i.test(cmd);
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, shell, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, out: String(stdout ?? '') });
    });
  });
}

/** adb dell'Android SDK (ANDROID_HOME, ANDROID_SDK_ROOT o la cartella predefinita di Android Studio), altrimenti dal PATH. */
export function adbPath(): string {
  const exe = WIN ? 'adb.exe' : 'adb';
  const roots = [
    process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    WIN ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Android', 'Sdk')
      : MAC ? path.join(os.homedir(), 'Library', 'Android', 'sdk') : path.join(os.homedir(), 'Android', 'Sdk'),
  ].filter(Boolean) as string[];
  for (const r of roots) {
    const p = path.join(r, 'platform-tools', exe);
    if (fs.existsSync(p)) return p;
  }
  return 'adb';
}

interface DeviceScan { devices: MobileDevice[]; unauthorized: number; failed?: string }

const cache = new Map<string, { at: number; scan: DeviceScan }>();
async function cached(key: string, scan: () => Promise<DeviceScan>): Promise<DeviceScan> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < 4000) return c.scan;
  const s = await scan();
  cache.set(key, { at: Date.now(), scan: s });
  return s;
}

/** Interpreta l'output di "adb devices -l". */
export function parseAdbDevices(out: string): DeviceScan {
  const scan: DeviceScan = { devices: [], unauthorized: 0 };
  for (const line of out.split(/\r?\n/).slice(1)) {
    const m = line.trim().match(/^(\S+)\s+(device|unauthorized|offline|no permissions)\b(.*)$/);
    if (!m) continue;
    if (m[2] !== 'device') { if (m[2] !== 'offline') scan.unauthorized++; continue; }
    const model = m[3].match(/model:(\S+)/)?.[1]?.replace(/_/g, ' ');
    scan.devices.push({ id: m[1], name: model ?? m[1], platform: 'android', emulator: m[1].startsWith('emulator-') });
  }
  return scan;
}

/** Interpreta l'output di "xcrun xctrace list devices": solo la sezione dei dispositivi fisici collegati. */
export function parseXctraceDevices(out: string): DeviceScan {
  const scan: DeviceScan = { devices: [], unauthorized: 0 };
  let section = '';
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    const head = line.match(/^==\s*(.+?)\s*==$/);
    if (head) { section = head[1]; continue; }
    if (section !== 'Devices') continue;
    // "iPhone di Luca (17.5) (00008110-001A2B3C4D5E)": il Mac stesso non ha la versione del sistema.
    const m = line.match(/^(.+?) \(([\d.]+)\) \(([\w-]+)\)$/);
    if (m) scan.devices.push({ id: m[3], name: m[1], platform: 'ios', emulator: false });
  }
  return scan;
}

/** Interpreta l'output di "flutter devices --machine". */
export function parseFlutterDevices(out: string): DeviceScan {
  const scan: DeviceScan = { devices: [], unauthorized: 0 };
  const start = out.indexOf('[');
  if (start < 0) return { ...scan, failed: 'flutter' };
  try {
    const list = JSON.parse(out.slice(start)) as { id: string; name: string; targetPlatform?: string; emulator?: boolean; isSupported?: boolean }[];
    for (const d of list) {
      const tp = d.targetPlatform ?? '';
      const platform: MobilePlatform | null = tp.startsWith('android') ? 'android' : tp.startsWith('ios') ? 'ios' : null;
      if (platform && d.isSupported !== false) scan.devices.push({ id: d.id, name: d.name, platform, emulator: Boolean(d.emulator) });
    }
  } catch { return { ...scan, failed: 'flutter' }; }
  return scan;
}

async function androidDevices(): Promise<DeviceScan> {
  return cached('adb', async () => {
    const r = await run(adbPath(), ['devices', '-l'], 10000);
    return r.ok ? parseAdbDevices(r.out) : { devices: [], unauthorized: 0, failed: 'adb' };
  });
}

async function iosDevices(): Promise<DeviceScan> {
  if (!MAC) return { devices: [], unauthorized: 0 };
  return cached('xctrace', async () => {
    const r = await run('xcrun', ['xctrace', 'list', 'devices'], 20000);
    return r.ok ? parseXctraceDevices(r.out) : { devices: [], unauthorized: 0, failed: 'xcrun' };
  });
}

async function flutterDevices(): Promise<DeviceScan> {
  return cached('flutter', async () => {
    const r = await run('flutter', ['devices', '--machine'], 90000);
    const scan = parseFlutterDevices(r.out);
    // flutter non elenca i telefoni Android da autorizzare: adb sì.
    if (scan.devices.every((d) => d.platform !== 'android')) {
      const a = await androidDevices();
      scan.unauthorized += a.unauthorized;
    }
    return scan;
  });
}

const DEFAULT_BUILD: Record<MobileFramework, MobileBuild> = {
  // Build indipendenti da strumenti di sviluppo in esecuzione (Metro, debugger): l'app resta utilizzabile da sola.
  flutter: 'release', 'react-native': 'release', expo: 'release',
  // Capacitor e Gradle installano la build di debug, firmata con la chiave di debug.
  capacitor: 'debug', android: 'debug',
};

const q = (s: string) => (/^[\w.:@/-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** React Native 0.71 e successivi usano --mode al posto di --variant / --configuration. */
function rnModern(pkg: Project['pkg']): boolean {
  const v = pkg?.dependencies?.['react-native'] ?? pkg?.devDependencies?.['react-native'] ?? '';
  const m = v.match(/(\d+)\.(\d+)/);
  return !m || Number(m[1]) > 0 || Number(m[2]) >= 71;
}

/** Comando che compila, installa e apre l'app sul dispositivo scelto. */
export function mobileCommand(p: Project, platform: MobilePlatform, device: MobileDevice, build: MobileBuild): { command: string; env?: Record<string, string>; notes: Msg[] } {
  const id = q(device.id);
  const notes: Msg[] = [];
  switch (p.framework) {
    case 'flutter':
      // --no-resident: compila, installa, apre l'app e termina, senza restare collegato.
      return { command: `flutter run -d ${id} --${build} --no-resident`, notes };
    case 'react-native': {
      if (build === 'debug') notes.push(msg('mobile.note.metro'));
      const modern = rnModern(p.pkg);
      return platform === 'android'
        ? { command: `npx react-native run-android ${modern ? `--mode ${build}` : `--variant ${build}`} --deviceId ${id}`, notes }
        : { command: `npx react-native run-ios ${modern ? `--mode ${cap(build)}` : `--configuration ${cap(build)}`} --udid ${id}`, notes };
    }
    case 'expo':
      if (build === 'debug') notes.push(msg('mobile.note.metro'));
      return platform === 'android'
        ? { command: `npx expo run:android --device ${id} --variant ${build}`, notes }
        : { command: `npx expo run:ios --device ${id} --configuration ${cap(build)}`, notes };
    case 'capacitor': {
      if (build === 'release') notes.push(msg('mobile.note.capacitorDebug'));
      const web = p.pkg?.scripts?.build ? 'npm run build && ' : '';
      return { command: `${web}npx cap sync ${platform} && npx cap run ${platform} --target ${id}`, notes };
    }
    case 'android': {
      if (build === 'release') notes.push(msg('mobile.note.releaseSigning'));
      const gradle = WIN ? 'gradlew.bat' : './gradlew';
      let command = `${gradle} :${p.module ?? 'app'}:install${cap(build)}`;
      // L'apertura non deve far fallire la fase: l'installazione è già riuscita.
      if (p.appId) command += ` && (${q(adbPath())} -s ${id} shell monkey -p ${p.appId} -c android.intent.category.LAUNCHER 1 || exit 0)`;
      else notes.push(msg('mobile.note.noLaunch'));
      return { command, env: { ANDROID_SERIAL: device.id }, notes };
    }
  }
}

/**
 * Rileva progetto e dispositivo e prepara il comando. simulate: nessun comando esterno eseguito (modalità di prova),
 * il dispositivo è fittizio.
 */
export async function planMobile(base: string, opts: Partial<ShowConfig> = {}, { simulate = false } = {}): Promise<LaunchPlan> {
  const plan: LaunchPlan = { target: 'dispositivo', dir: '', check: 'exit', platforms: [], devices: [], notes: [] };
  const p = findMobileProject(base);
  if (!p) { plan.problem = msg('mobile.problem.noProject'); return plan; }
  plan.dir = path.relative(base, p.abs);
  plan.project = MOBILE_FRAMEWORK_NAMES[p.framework];
  plan.platforms = p.platforms;
  plan.build = opts.build ?? DEFAULT_BUILD[p.framework];

  if (opts.platform && !p.platforms.includes(opts.platform)) {
    plan.problem = msg('mobile.problem.platformMissing', { platform: cap(opts.platform) });
    return plan;
  }
  const wanted = (opts.platform ? [opts.platform] : p.platforms).filter((x) => x === 'android' || MAC || simulate);
  if (!wanted.length) {
    plan.problem = p.platforms.includes('ios') ? msg('mobile.problem.iosNeedsMac') : msg('mobile.problem.noPlatform');
    return plan;
  }

  if (simulate) {
    const device: MobileDevice = { id: 'simulato', name: 'simulato', platform: wanted[0], emulator: true };
    plan.platform = device.platform;
    Object.assign(plan, mobileCommand(p, device.platform, device, plan.build), { notes: [] });
    return plan;
  }

  const scans = p.framework === 'flutter'
    ? [await flutterDevices()]
    : await Promise.all([wanted.includes('android') ? androidDevices() : null, wanted.includes('ios') ? iosDevices() : null]);
  const ok = scans.filter(Boolean) as DeviceScan[];
  const devices = ok.flatMap((s) => s.devices);
  plan.devices = devices;
  const unauthorized = ok.reduce((n, s) => n + s.unauthorized, 0);
  const failed = ok.map((s) => s.failed).filter(Boolean) as string[];

  const candidates = devices.filter((d) => wanted.includes(d.platform));
  let device: MobileDevice | undefined;
  if (opts.device) {
    device = candidates.find((d) => d.id === opts.device);
    if (!device) { plan.problem = msg('mobile.problem.deviceNotFound', { device: opts.device }); return plan; }
  } else {
    // Prima i dispositivi fisici, poi gli emulatori; a parità, l'ordine degli strumenti.
    device = candidates.find((d) => !d.emulator) ?? candidates[0];
  }
  if (!device) {
    if (failed.length && !devices.length) plan.problem = msg('mobile.problem.toolMissing', { tool: failed[0] });
    else if (unauthorized) plan.problem = msg('mobile.problem.unauthorized');
    else plan.problem = msg(wanted.includes('ios') && wanted.includes('android') ? 'mobile.problem.noDeviceAny' : wanted[0] === 'ios' ? 'mobile.problem.noDeviceIos' : 'mobile.problem.noDeviceAndroid');
    return plan;
  }
  plan.device = device;
  plan.platform = device.platform;
  if (!opts.device && candidates.length > 1) plan.notes.push(msg('mobile.note.manyDevices', { count: candidates.length, device: device.name }));
  const c = mobileCommand(p, device.platform, device, plan.build);
  plan.command = c.command;
  plan.env = c.env;
  plan.notes.push(...c.notes);
  return plan;
}
