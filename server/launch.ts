// Fase "mostra": riconosce il progetto e prepara il comando per vederne il risultato sul telefono, nel browser
// o come app desktop, senza configurazione. Apre anche il browser sulla pagina pronta.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { msg } from '../shared/i18n.ts';
import type { BrowserChoice, LaunchPlan, ReadyCheck, ShowConfig } from '../shared/types.ts';
import { gradleModules, planMobile, readJson, readText } from './mobile.ts';

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';

interface Pkg { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> }
/** role (solo web): l'interfaccia da aprire, il server che la serve (API) o una pagina statica. */
interface Found { abs: string; project: string; command?: string; check: ReadyCheck; readyPattern?: string; url?: string; role?: 'frontend' | 'backend' | 'static' }

const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'out', 'Pods', 'bin', 'obj', 'target', 'vendor', 'packages']);

/** Progetti riconosciuti nelle sottocartelle dirette (monorepo: fe/ e be/, web/, desktop/…). */
function inChildren(base: string, detect: (abs: string) => Found | null): Found[] {
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
      .map((e) => e.name).sort();
  } catch { return []; }
  return dirs.map((d) => detect(path.join(base, d))).filter(Boolean) as Found[];
}

/**
 * Il sito da aprire: il progetto nella cartella o, in un monorepo, l'interfaccia (frontend) con il server che la
 * serve (backend) da avviare insieme; altrimenti il primo server, infine una pagina statica.
 */
function findWeb(base: string): { main: Found; companion?: Found } | null {
  const here = detectWeb(base);
  if (here) return { main: here };
  const all = inChildren(base, detectWeb);
  const frontend = all.find((f) => f.role === 'frontend');
  const backend = all.find((f) => f.role === 'backend');
  if (frontend) return { main: frontend, companion: backend };
  const main = backend ?? all[0];
  return main ? { main } : null;
}

function findDesktop(base: string): Found | null {
  return detectDesktop(base) ?? inChildren(base, detectDesktop)[0] ?? null;
}

/** Comando "run" del gestore di pacchetti usato dal progetto (dal lockfile). */
function pmRun(abs: string, script: string): string {
  const has = (f: string) => fs.existsSync(path.join(abs, f));
  const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
  return `${pm} run ${script}`;
}

function projectFiles(abs: string): string[] {
  try { return fs.readdirSync(abs).filter((f) => /\.csproj$/i.test(f)); } catch { return []; }
}

const WEB_NAMES: [string, string][] = [
  ['next', 'Next.js'], ['nuxt', 'Nuxt'], ['@angular/core', 'Angular'], ['astro', 'Astro'], ['@sveltejs/kit', 'SvelteKit'],
  ['@remix-run/dev', 'Remix'], ['gatsby', 'Gatsby'], ['vite', 'Vite'], ['react-scripts', 'Create React App'],
  ['@vue/cli-service', 'Vue CLI'], ['express', 'Express'], ['fastify', 'Fastify'],
];

/** Progetto web nella cartella: Node (script dev/start), ASP.NET Core, Django, Laravel, Rails o pagina statica. */
export function detectWeb(abs: string): Found | null {
  const pkg = readJson<Pkg>(path.join(abs, 'package.json'));
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    // App mobili e desktop scritte con strumenti JavaScript non sono siti.
    const notWeb = deps['react-native'] || deps.expo || deps.electron;
    const script = ['dev', 'start', 'serve', 'develop', 'preview'].find((s) => pkg.scripts?.[s]);
    if (!notWeb && script) {
      const name = WEB_NAMES.find(([d]) => deps[d])?.[1] ?? 'Node.js';
      return { abs, project: name, command: pmRun(abs, script), check: 'url', role: name === 'Express' || name === 'Fastify' ? 'backend' : 'frontend' };
    }
  }
  // Flutter con la piattaforma web: server locale, la pagina si apre nel browser scelto.
  const pub = readText(path.join(abs, 'pubspec.yaml'));
  if (pub && /^\s*flutter\s*:/m.test(pub) && fs.existsSync(path.join(abs, 'web'))) {
    return { abs, project: 'Flutter (web)', command: 'flutter run -d web-server', check: 'url', role: 'frontend' };
  }
  for (const f of projectFiles(abs)) {
    const xml = readText(path.join(abs, f)) ?? '';
    const blazorWasm = /Sdk="Microsoft\.NET\.Sdk\.BlazorWebAssembly"/i.test(xml);
    if (blazorWasm || /Sdk="Microsoft\.NET\.Sdk\.Web"/i.test(xml)) {
      return { abs, project: blazorWasm ? 'Blazor' : 'ASP.NET Core', command: `dotnet run --project "${f}"`, check: 'url', role: blazorWasm ? 'frontend' : 'backend' };
    }
  }
  if (fs.existsSync(path.join(abs, 'manage.py'))) return { abs, project: 'Django', command: 'python manage.py runserver', check: 'url', role: 'backend' };
  if (fs.existsSync(path.join(abs, 'artisan'))) return { abs, project: 'Laravel', command: 'php artisan serve', check: 'url', role: 'backend' };
  if (fs.existsSync(path.join(abs, 'bin', 'rails'))) return { abs, project: 'Rails', command: WIN ? 'ruby bin/rails server' : 'bin/rails server', check: 'url', role: 'backend' };
  const index = path.join(abs, 'index.html');
  if (fs.existsSync(index)) return { abs, project: 'HTML', check: 'url', url: pathToFileURL(index).href, role: 'static' };
  return null;
}

/** App desktop nella cartella: Electron, Tauri, .NET (WPF, Windows Forms, WinUI, Avalonia, MAUI), Flutter, Compose Desktop. */
export function detectDesktop(abs: string): Found | null {
  const pkg = readJson<Pkg>(path.join(abs, 'package.json'));
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['@tauri-apps/cli']) {
      // Il comando resta attivo mentre compila: pronto quando l'eseguibile parte.
      return { abs, project: 'Tauri', command: pkg.scripts?.tauri ? `${pmRun(abs, 'tauri')} dev` : 'npx tauri dev', check: 'output', readyPattern: '/Running .*target/' };
    }
    if (deps.electron) {
      const script = ['start', 'dev', 'electron'].find((s) => pkg.scripts?.[s]);
      return { abs, project: 'Electron', command: script ? pmRun(abs, script) : 'npx electron .', check: 'process' };
    }
  }
  for (const f of projectFiles(abs)) {
    const xml = readText(path.join(abs, f)) ?? '';
    if (/<UseMaui>\s*true/i.test(xml)) {
      const tfm = xml.match(/<TargetFrameworks?>([^<]+)</i)?.[1].split(';').map((x) => x.trim()).find((x) => (WIN ? /-windows/ : /-maccatalyst/).test(x));
      if (tfm) return { abs, project: '.NET MAUI', command: `dotnet run --project "${f}" -f ${tfm}`, check: 'process' };
      continue;
    }
    const kind = /<UseWPF>\s*true/i.test(xml) ? 'WPF' : /<UseWindowsForms>\s*true/i.test(xml) ? 'Windows Forms'
      : /<UseWinUI>\s*true/i.test(xml) ? 'WinUI' : /Avalonia/i.test(xml) ? 'Avalonia' : /<OutputType>\s*WinExe/i.test(xml) ? '.NET' : null;
    if (kind) return { abs, project: kind, command: `dotnet run --project "${f}"`, check: 'process' };
  }
  const pub = readText(path.join(abs, 'pubspec.yaml'));
  const os = WIN ? 'windows' : MAC ? 'macos' : 'linux';
  if (pub && /^\s*flutter\s*:/m.test(pub) && fs.existsSync(path.join(abs, os))) {
    return { abs, project: 'Flutter', command: `flutter run -d ${os}`, check: 'output', readyPattern: 'Flutter run key commands' };
  }
  if (fs.existsSync(path.join(abs, 'gradlew')) || fs.existsSync(path.join(abs, 'gradlew.bat'))) {
    const settings = readText(path.join(abs, 'settings.gradle.kts')) ?? readText(path.join(abs, 'settings.gradle')) ?? '';
    for (const m of gradleModules(settings)) {
      const gradle = readText(path.join(abs, m, 'build.gradle.kts')) ?? readText(path.join(abs, m, 'build.gradle')) ?? '';
      if (/compose\.desktop/.test(gradle)) {
        const task = `:${m.replace(/\//g, ':')}:run`;
        // Gradle compila a lungo prima di aprire la finestra: pronto quando parte il task run.
        return { abs, project: 'Compose Desktop', command: `${WIN ? 'gradlew.bat' : './gradlew'} ${task}`, check: 'output', readyPattern: `> Task ${task}` };
      }
    }
  }
  return null;
}

/** Cosa verrà eseguito per mostrare il risultato, e come capire che è pronto. url: l'indirizzo indicato nella fase. */
export async function planLaunch(base: string, show: ShowConfig, url = '', { simulate = false } = {}): Promise<LaunchPlan> {
  if (show.target === 'dispositivo') return planMobile(base, show, { simulate });
  const plan: LaunchPlan = { target: show.target, dir: '', check: 'url', notes: [] };
  if (show.target === 'browser' && show.existing) {
    if (!url.trim()) plan.problem = msg('launch.problem.noUrl');
    else plan.url = url.trim();
    return plan;
  }
  const web = show.target === 'browser' ? findWeb(base) : null;
  const found = show.target === 'browser' ? web?.main : findDesktop(base);
  if (!found) {
    plan.problem = msg(show.target === 'browser' ? 'launch.problem.noWeb' : 'launch.problem.noDesktop');
    return plan;
  }
  plan.dir = path.relative(base, found.abs);
  plan.project = found.project;
  plan.command = found.command;
  plan.check = found.check;
  plan.readyPattern = found.readyPattern;
  // Un indirizzo indicato nella fase ha la precedenza su quello stampato dal server di sviluppo.
  plan.url = url.trim() || found.url;
  const c = web?.companion;
  if (c?.command) plan.companion = { dir: path.relative(base, c.abs), project: c.project, command: c.command, enabled: !show.noCompanion };
  return plan;
}

const BROWSER_NAMES: Record<BrowserChoice, string> = { chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox', safari: 'Safari' };

function windowsBrowser(choice: BrowserChoice): string | undefined {
  const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[];
  const rel = { chrome: 'Google\\Chrome\\Application\\chrome.exe', edge: 'Microsoft\\Edge\\Application\\msedge.exe', firefox: 'Mozilla Firefox\\firefox.exe', safari: '' }[choice];
  if (!rel) return undefined;
  return roots.map((r) => path.join(r, rel)).find((p) => fs.existsSync(p));
}

/** Apre l'indirizzo nel browser scelto o, se non è installato, in quello predefinito. Restituisce il nome usato. */
export function openBrowser(url: string, choice?: BrowserChoice): { browser?: string; fallback: boolean } {
  // REGIA_NO_BROWSER=1: nessuna finestra aperta (test automatici, server senza desktop).
  if (process.env.REGIA_NO_BROWSER === '1') return { browser: choice ? BROWSER_NAMES[choice] : undefined, fallback: false };
  const launch = (cmd: string, args: string[]) => {
    try {
      const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
      c.on('error', () => undefined);
      c.unref();
    } catch { /* il link resta disponibile nella fase */ }
  };
  if (WIN) {
    const exe = choice ? windowsBrowser(choice) : undefined;
    if (exe) { launch(exe, [url]); return { browser: BROWSER_NAMES[choice!], fallback: false }; }
    launch('explorer.exe', [url]);
    return { fallback: Boolean(choice) };
  }
  if (MAC) {
    const app = choice ? { chrome: 'Google Chrome', edge: 'Microsoft Edge', firefox: 'Firefox', safari: 'Safari' }[choice] : undefined;
    const ok = app && fs.existsSync(`/Applications/${app}.app`);
    launch('open', ok ? ['-a', app!, url] : [url]);
    return ok ? { browser: BROWSER_NAMES[choice!], fallback: false } : { fallback: Boolean(choice) };
  }
  const bin = choice === 'chrome' ? 'google-chrome' : choice === 'firefox' ? 'firefox' : choice === 'edge' ? 'microsoft-edge' : 'xdg-open';
  launch(bin, [url]);
  return { browser: choice ? BROWSER_NAMES[choice] : undefined, fallback: false };
}
