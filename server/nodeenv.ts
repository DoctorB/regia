// Ambiente Node per la fase "server": versione richiesta dal progetto, versioni installate,
// installazione di una versione mancante (solo su richiesta) e installazione delle dipendenze.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import semver from 'semver';

export interface NodeRequirement {
  /** Range semver combinato. */
  range?: string;
  /** Da dove arriva, per i messaggi. */
  sources: string[];
  lts?: boolean;
}

export interface InstalledNode { version: string; dir: string; manager: string }

export interface InstallPlan { manager: string; version: string; command: string; args: string[]; display: string }

export type NodeResolution =
  | { ok: true; version: string; dir?: string; manager: string; requirement: NodeRequirement; note?: string }
  | { ok: false; requirement: NodeRequirement; installed: InstalledNode[]; install?: InstallPlan; message: string };

const isWin = process.platform === 'win32';

function readFirstLine(p: string) {
  try { return fs.readFileSync(p, 'utf8').split(/\r?\n/)[0].trim(); } catch { return ''; }
}

/** Converte il contenuto di .nvmrc / .node-version in un range semver. */
function versionFileRange(v: string): { range?: string; lts?: boolean } {
  const s = v.replace(/^v/i, '').trim();
  if (!s) return {};
  if (/^lts/i.test(s)) return { lts: true };
  if (/^(node|latest|current|stable)$/i.test(s)) return {};
  if (/^\d+$/.test(s)) return { range: `${s}.x` };
  if (/^\d+\.\d+$/.test(s)) return { range: `${s}.x` };
  return semver.validRange(s) ? { range: s } : {};
}

export function readRequirement(projectDir: string, override?: string): NodeRequirement {
  const req: NodeRequirement = { sources: [] };
  const ranges: string[] = [];
  if (override?.trim()) {
    const r = versionFileRange(override.trim());
    if (r.range) { ranges.push(r.range); req.sources.push(`${override.trim()} (impostazione della fase)`); }
    if (r.lts) { req.lts = true; req.sources.push('LTS (impostazione della fase)'); }
  } else {
    for (const f of ['.nvmrc', '.node-version']) {
      const v = readFirstLine(path.join(projectDir, f));
      if (!v) continue;
      const r = versionFileRange(v);
      if (r.range) { ranges.push(r.range); req.sources.push(`${v} (${f})`); }
      if (r.lts) { req.lts = true; req.sources.push(`LTS (${f})`); }
      break;
    }
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    const eng = pkg?.engines?.node;
    if (typeof eng === 'string' && semver.validRange(eng)) { ranges.push(eng); req.sources.push(`${eng} (package.json engines)`); }
  } catch { /* nessun package.json */ }
  req.range = ranges.length ? ranges.join(' && ') : undefined;
  return req;
}

/** Una versione soddisfa tutti i range (separati da " && "). */
export function satisfies(version: string, range?: string) {
  if (!range) return true;
  return range.split(' && ').every((r) => semver.satisfies(version, r, { includePrerelease: false }));
}

function systemNode(): InstalledNode | null {
  try {
    const v = execFileSync('node', ['-v'], { encoding: 'utf8', windowsHide: true, timeout: 5000, shell: isWin }).trim().replace(/^v/, '');
    return semver.valid(v) ? { version: v, dir: '', manager: 'sistema' } : null;
  } catch { return null; }
}

function listDirs(base: string | undefined, pick: (name: string) => { version: string; dir: string } | null, manager: string): InstalledNode[] {
  if (!base || !fs.existsSync(base)) return [];
  const out: InstalledNode[] = [];
  for (const name of fs.readdirSync(base)) {
    const r = pick(name);
    if (r && semver.valid(r.version) && fs.existsSync(path.join(r.dir, isWin ? 'node.exe' : 'node'))) out.push({ ...r, manager });
  }
  return out;
}

export function nvmWindowsHome(): string | undefined {
  if (!isWin) return undefined;
  const h = process.env.NVM_HOME || path.join(process.env.APPDATA ?? '', 'nvm');
  return fs.existsSync(path.join(h, 'nvm.exe')) ? h : undefined;
}

export function installedNodes(): InstalledNode[] {
  const home = os.homedir();
  const vdir = (n: string) => (/^v\d+\.\d+\.\d+$/.test(n) ? n.slice(1) : null);
  const list: InstalledNode[] = [
    ...listDirs(nvmWindowsHome(), (n) => (vdir(n) ? { version: vdir(n)!, dir: path.join(nvmWindowsHome()!, n) } : null), 'nvm'),
    ...listDirs(path.join(process.env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node'), (n) => (vdir(n) ? { version: vdir(n)!, dir: path.join(process.env.NVM_DIR || path.join(home, '.nvm'), 'versions', 'node', n, 'bin') } : null), 'nvm'),
    ...listDirs(process.env.FNM_DIR ? path.join(process.env.FNM_DIR, 'node-versions') : path.join(isWin ? process.env.APPDATA ?? '' : path.join(home, '.local', 'share'), 'fnm', 'node-versions'),
      (n) => (vdir(n) ? { version: vdir(n)!, dir: isWin ? path.join(process.env.FNM_DIR || path.join(process.env.APPDATA ?? '', 'fnm'), 'node-versions', n, 'installation') : path.join(process.env.FNM_DIR || path.join(home, '.local', 'share', 'fnm'), 'node-versions', n, 'installation', 'bin') } : null), 'fnm'),
    ...listDirs(path.join(process.env.VOLTA_HOME || (isWin ? path.join(process.env.LOCALAPPDATA ?? '', 'Volta') : path.join(home, '.volta')), 'tools', 'image', 'node'),
      (n) => (semver.valid(n) ? { version: n, dir: isWin ? path.join(process.env.VOLTA_HOME || path.join(process.env.LOCALAPPDATA ?? '', 'Volta'), 'tools', 'image', 'node', n) : path.join(process.env.VOLTA_HOME || path.join(home, '.volta'), 'tools', 'image', 'node', n, 'bin') } : null), 'volta'),
  ];
  const sys = systemNode();
  if (sys) list.push(sys);
  return list.sort((a, b) => semver.rcompare(a.version, b.version));
}

let remoteCache: { at: number; list: { version: string; lts: string | false }[] } | null = null;
async function remoteVersions() {
  if (remoteCache && Date.now() - remoteCache.at < 3600_000) return remoteCache.list;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch('https://nodejs.org/dist/index.json', { signal: ctrl.signal });
    const list = ((await r.json()) as { version: string; lts: string | false }[]).map((x) => ({ version: x.version.replace(/^v/, ''), lts: x.lts }));
    remoteCache = { at: Date.now(), list };
    return list;
  } finally { clearTimeout(t); }
}

/** Sceglie la versione più recente che soddisfa il requisito (preferendo le LTS) e il comando per installarla. */
async function installPlan(req: NodeRequirement): Promise<InstallPlan | undefined> {
  let list: { version: string; lts: string | false }[];
  try { list = await remoteVersions(); } catch { return undefined; }
  const ok = list.filter((v) => !semver.prerelease(v.version) && satisfies(v.version, req.range) && (!req.lts || v.lts));
  const pick = ok.find((v) => v.lts) ?? ok[0];
  if (!pick) return undefined;
  const nvm = nvmWindowsHome();
  if (nvm) return { manager: 'nvm', version: pick.version, command: path.join(nvm, 'nvm.exe'), args: ['install', pick.version], display: `nvm install ${pick.version}` };
  const has = (cmd: string) => { try { execFileSync(cmd, ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 5000, shell: isWin }); return true; } catch { return false; } };
  if (has('fnm')) return { manager: 'fnm', version: pick.version, command: 'fnm', args: ['install', pick.version], display: `fnm install ${pick.version}` };
  if (has('volta')) return { manager: 'volta', version: pick.version, command: 'volta', args: ['fetch', `node@${pick.version}`], display: `volta fetch node@${pick.version}` };
  return undefined;
}

export async function resolveNode(projectDir: string, override?: string): Promise<NodeResolution> {
  const requirement = readRequirement(projectDir, override);
  const installed = installedNodes();
  const sys = installed.find((n) => n.manager === 'sistema');
  if (!requirement.range && !requirement.lts) {
    return { ok: true, version: sys?.version ?? process.versions.node, manager: 'sistema', requirement };
  }
  if (sys && satisfies(sys.version, requirement.range) && !requirement.lts) return { ok: true, version: sys.version, manager: 'sistema', requirement };
  const match = installed.find((n) => n.manager !== 'sistema' && satisfies(n.version, requirement.range));
  if (match) {
    return { ok: true, version: match.version, dir: match.dir, manager: match.manager, requirement,
      note: `Il progetto richiede Node ${requirement.sources.join(' e ')}: uso Node ${match.version} (${match.manager}) solo per questo comando${sys ? `, invece di ${sys.version} di sistema` : ''}.` };
  }
  const install = await installPlan(requirement);
  const have = [...new Set(installed.map((n) => n.version))].slice(0, 8).join(', ') || 'nessuna';
  return {
    ok: false, requirement, installed, install,
    message: `Il progetto richiede Node ${requirement.sources.join(' e ')}, ma nessuna versione installata è compatibile (installate: ${have}).`
      + (install ? ` Si può installare Node ${install.version} con "${install.display}": non cambia la versione di sistema, viene usata solo per questo comando.` : ' Installa una versione compatibile (ad esempio da nodejs.org o con un gestore di versioni come nvm) e riprova.'),
  };
}

/** Ambiente con la cartella di Node scelta in testa al PATH (rispettando il nome della variabile su Windows). */
export function envWithNode(dir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!dir) return env;
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  env[key] = `${dir}${path.delimiter}${env[key] ?? ''}`;
  return env;
}

export interface DepsPlan { manager: string; display: string; command: string }

/** Comando di installazione delle dipendenze in base al lockfile, senza modificare il lockfile. */
export function depsPlan(cwd: string): DepsPlan | null {
  if (!fs.existsSync(path.join(cwd, 'package.json'))) return null;
  const has = (f: string) => fs.existsSync(path.join(cwd, f));
  if (has('pnpm-lock.yaml')) return { manager: 'pnpm', command: 'pnpm install --frozen-lockfile', display: 'pnpm install --frozen-lockfile' };
  if (has('yarn.lock')) return { manager: 'yarn', command: 'yarn install --frozen-lockfile', display: 'yarn install --frozen-lockfile' };
  if (has('bun.lockb') || has('bun.lock')) return { manager: 'bun', command: 'bun install --frozen-lockfile', display: 'bun install --frozen-lockfile' };
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) return { manager: 'npm', command: 'npm ci', display: 'npm ci' };
  return { manager: 'npm', command: 'npm install', display: 'npm install' };
}

export function needsDeps(cwd: string) {
  return fs.existsSync(path.join(cwd, 'package.json')) && !fs.existsSync(path.join(cwd, 'node_modules'));
}

/** Esegue un comando una tantum (installazioni), riportando l'output riga per riga. */
export function runOnce(command: string, args: string[] | null, cwd: string, env: NodeJS.ProcessEnv, onLine: (l: string) => void, signal?: AbortSignal): Promise<number | null> {
  return new Promise((resolve) => {
    const child = args ? spawn(command, args, { cwd, env, windowsHide: true }) : spawn(command, { cwd, env, shell: true, windowsHide: true });
    let buf = '';
    const feed = (c: Buffer) => {
      buf += c.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) onLine(l.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trimEnd());
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    child.on('error', (e) => { onLine(`Errore: ${e.message}`); resolve(null); });
    child.on('exit', (code) => { if (buf.trim()) onLine(buf.trim()); resolve(code); });
    signal?.addEventListener('abort', () => { try { child.kill(); } catch { /* */ } }, { once: true });
  });
}

export interface Diagnosis { kind: 'node' | 'dipendenze' | 'porta' | 'permessi'; message: string; requiredRange?: string }

/** Riconosce le cause più comuni di avvio fallito dall'output. */
export function diagnose(log: string[]): Diagnosis | null {
  const text = log.join('\n');
  const nodeMsg = /node(\.js)?\s+v?([\d.]+)\s+is not supported|unsupported engine|requires? node(\.js)?\s*(version)?\s*[>=^~\d]|The engine "node" is incompatible|SyntaxError: Unexpected token|ERR_UNKNOWN_FILE_EXTENSION|ERR_REQUIRE_ESM/i;
  if (nodeMsg.test(text)) {
    // La versione richiesta, tra virgolette o meno: ">=22.23.4", "20.x", "^18.17.0 || >=20", 24...
    const candidates = [
      text.match(/supported versions?[^"'\n]*["']([^"'\n]+)["']/i),
      text.match(/Expected version:?\s*["']([^"'\n]+)["']/i),
      text.match(/(?:requires?|expected|wanted)[^"'\n]*node(?:\.js)?[^"'\n]*?["']([^"'\n]+)["']/i),
      text.match(/supported versions?:?\s*([><=^~]?\s*\d[\w.\s|<>=^~-]*)/i),
      text.match(/(?:requires?|expected)\s+node(?:\.js)?\s*(?:version)?\s*([><=^~]?\s*\d[\w.]*)/i),
    ].filter(Boolean) as RegExpMatchArray[];
    let range = candidates.map((m) => m[1].trim().replace(/[.,;:]+$/, '')).find((r) => semver.validRange(r));
    if (range && /^\d[\d.]*$/.test(range) && /or (higher|newer|later|above)|\+ is required/i.test(text)) range = `>=${range}`;
    return { kind: 'node', requiredRange: range, message: `La versione di Node in uso non è supportata dal progetto${range ? ` (richiesta: ${range})` : ''}.` };
  }
  if (/Cannot find module|ERR_MODULE_NOT_FOUND|is not recognized as an internal or external command|command not found|not found: |missing script|Cannot find package/i.test(text)) {
    return { kind: 'dipendenze', message: 'Manca un modulo o un comando: probabilmente le dipendenze non sono installate o sono incomplete.' };
  }
  if (/EADDRINUSE|address already in use|port \d+ is (already )?in use/i.test(text)) {
    return { kind: 'porta', message: 'La porta è già occupata: probabilmente un altro server (forse una precedente anteprima) è ancora attivo. Chiudilo, oppure indica nel comando una porta diversa.' };
  }
  if (/EACCES|EPERM|permission denied/i.test(text)) {
    return { kind: 'permessi', message: 'Permessi insufficienti per avviare il comando o per una porta/cartella che usa.' };
  }
  return null;
}
