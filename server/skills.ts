// Skill di Claude Code nei workflow.
// - Ricerca: skill del progetto (<progetto>/.claude/skills/<nome>/SKILL.md) e personali (~/.claude/skills, anche in
//   sottocartelle). Nome e descrizione dal frontmatter di SKILL.md.
// - Uso: per ogni fase Regia prepara un piccolo plugin locale con le sole skill scelte e lo passa al SDK (opzione
//   `plugins`), insieme al filtro `skills` e allo strumento `Skill`. Così le skill personali sono disponibili senza
//   caricare impostazioni, hook o plugin personali.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PhaseConfig, SkillInfo, WorkflowSettings } from '../shared/types.ts';
import { DATA_DIR } from './store.ts';

export const PLUGIN_NAME = 'regia-skills';
const BUNDLES = path.join(DATA_DIR, 'skill-bundles');
const MAX_DEPTH = 4;

export const personalSkillsDir = () => path.resolve(process.env.REGIA_SKILLS_DIR || path.join(os.homedir(), '.claude', 'skills'));

/** Frontmatter YAML semplice (chiave: valore su una riga, valori tra virgolette facoltative). */
function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function collect(root: string, source: SkillInfo['source'], depth = 0, acc: SkillInfo[] = []): SkillInfo[] {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return acc; }
  if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
    const dir = path.basename(root);
    let fm: Record<string, string> = {};
    try { fm = frontmatter(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8')); } catch { /* illeggibile */ }
    const name = fm.name || dir;
    acc.push({ id: `${source}:${name}`, name, description: fm.description ?? '', source, path: root });
    return acc;
  }
  if (depth >= MAX_DEPTH) return acc;
  for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') collect(path.join(root, e.name), source, depth + 1, acc);
  return acc;
}

/** Skill trovate nelle fonti indicate, ordinate per fonte e nome. */
export function discoverSkills(projectDir: string | undefined, sources: { project?: boolean; personal?: boolean } = { project: true, personal: true }): SkillInfo[] {
  const out: SkillInfo[] = [];
  if (sources.project !== false && projectDir && path.isAbsolute(projectDir)) collect(path.join(projectDir, '.claude', 'skills'), 'progetto', 0, out);
  if (sources.personal) collect(personalSkillsDir(), 'personale', 0, out);
  const seen = new Set<string>();
  return out.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
    .sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source === 'progetto' ? -1 : 1));
}

export function skillSources(s: WorkflowSettings) {
  return { project: s.skillSources?.project !== false, personal: s.skillSources?.personal === true };
}

/** Skill scelte per una fase tra quelle disponibili; `missing` sono gli id scelti ma non più trovati. */
export function phaseSkills(phase: PhaseConfig, available: SkillInfo[]): { selected: SkillInfo[]; missing: string[] } {
  const want = phase.skills;
  if (!want || (Array.isArray(want) && want.length === 0)) return { selected: [], missing: [] };
  if (want === 'all') return { selected: available, missing: [] };
  const byId = new Map(available.map((s) => [s.id, s]));
  return { selected: want.map((id) => byId.get(id)).filter(Boolean) as SkillInfo[], missing: want.filter((id) => !byId.has(id)) };
}

const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill';

export interface SkillBundle {
  path: string;
  /** Nomi qualificati da passare all'opzione `skills` del SDK, nell'ordine delle skill. */
  names: string[];
  /** id della skill → nome visto dall'agente (senza prefisso del plugin). */
  byId: Record<string, string>;
}

/**
 * Prepara il plugin con le skill scelte (copiate, così i file originali non vengono mai modificati).
 * Nomi in conflitto (es. stessa skill nel progetto e nelle personali) ricevono un suffisso.
 */
export function buildSkillBundle(key: string, skills: SkillInfo[]): SkillBundle {
  const dir = path.join(BUNDLES, key.replace(/[^\w.-]+/g, '_'));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN_NAME, version: '1.0.0', description: 'Skills selected by Regia for one phase' }, null, 2));
  const used = new Set<string>();
  const names: string[] = [];
  const byId: Record<string, string> = {};
  for (const s of skills) {
    let n = safeName(s.name);
    if (used.has(n)) n = `${n}-${s.source}`;
    let k = 2;
    while (used.has(n)) n = `${safeName(s.name)}-${k++}`;
    used.add(n);
    const target = path.join(dir, 'skills', n);
    fs.cpSync(s.path, target, { recursive: true });
    // Il nome nel frontmatter deve coincidere con la cartella, perché l'agente la richiami con quel nome.
    const md = path.join(target, 'SKILL.md');
    const text = fs.readFileSync(md, 'utf8');
    const fixed = /^---\s*\r?\n[\s\S]*?^name:/m.test(text)
      ? text.replace(/^(---\s*\r?\n[\s\S]*?^)name:.*$/m, `$1name: ${n}`)
      : text.startsWith('---') ? text.replace(/^---\s*\r?\n/, `---\nname: ${n}\n`) : `---\nname: ${n}\ndescription: ${s.description}\n---\n\n${text}`;
    fs.writeFileSync(md, fixed);
    names.push(`${PLUGIN_NAME}:${n}`);
    byId[s.id] = n;
  }
  return { path: dir, names, byId };
}

export function removeSkillBundles(prefix?: string) {
  if (!fs.existsSync(BUNDLES)) return;
  for (const d of fs.readdirSync(BUNDLES)) if (!prefix || d.startsWith(prefix.replace(/[^\w.-]+/g, '_'))) fs.rmSync(path.join(BUNDLES, d), { recursive: true, force: true });
}
