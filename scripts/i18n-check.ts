// Controllo delle traduzioni: chiavi usate nel codice ma assenti, chiavi mancanti o in più per ogni lingua.
// Uso: npm run i18n:check   (codice di uscita 1 se manca una chiave usata nel codice o una traduzione inglese/italiana)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flatten, type FlatDict } from '../shared/i18n.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = path.join(ROOT, 'locales');
const REQUIRED = ['it', 'en'];

function load(lang: string): FlatDict {
  const dir = path.join(LOCALES, lang);
  const out: FlatDict = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('_')).sort()) {
    const flat = flatten(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    for (const k of Object.keys(flat)) if (k in out) console.warn(`! ${lang}: chiave duplicata ${k} (${f})`);
    Object.assign(out, flat);
  }
  return out;
}

function sources(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'dist', 'test'].includes(e.name)) sources(p, acc); }
    else if (/\.(ts|tsx)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

const langs = fs.readdirSync(LOCALES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const dicts = Object.fromEntries(langs.map((l) => [l, load(l)]));
const reference = dicts.it ?? {};

// Chiavi usate nel codice: t('a.b'), tm(msg('a.b')), msg('a.b'), e prefissi dinamici t(`a.${x}`).
const used = new Set<string>();
const prefixes = new Set<string>();
for (const file of ['web/src', 'server', 'shared'].flatMap((d) => sources(path.join(ROOT, d)))) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\b(?:t|msg|m)\(\s*['"]([a-zA-Z0-9_.-]+)['"]/g)) used.add(m[1]);
  for (const m of src.matchAll(/\b(?:t|msg|m)\(\s*`([a-zA-Z0-9_.-]+)\.\$\{/g)) prefixes.add(m[1] + '.');
}

let errors = 0;
const undefinedKeys = [...used].filter((k) => !(k in reference)).sort();
if (undefinedKeys.length) {
  errors += undefinedKeys.length;
  console.log(`✕ Chiavi usate nel codice ma assenti in it (${undefinedKeys.length}):`);
  for (const k of undefinedKeys) console.log(`   ${k}`);
}
const unused = Object.keys(reference).filter((k) => !used.has(k) && ![...prefixes].some((p) => k.startsWith(p)));
if (unused.length) console.log(`· Chiavi in it non trovate nel codice (possibili avanzi, ${unused.length}): ${unused.slice(0, 30).join(', ')}${unused.length > 30 ? '…' : ''}`);

for (const lang of langs.filter((l) => l !== 'it')) {
  const d = dicts[lang];
  const missing = Object.keys(reference).filter((k) => !(k in d));
  const extra = Object.keys(d).filter((k) => !(k in reference));
  const shape = Object.keys(reference).filter((k) => k in d && (typeof reference[k] === 'string') !== (typeof d[k] === 'string'));
  const req = REQUIRED.includes(lang);
  if (missing.length) {
    if (req) errors += missing.length;
    console.log(`${req ? '✕' : '!'} ${lang}: ${missing.length} chiavi da tradurre${req ? '' : ' (useranno l\'inglese)'}`);
    for (const k of missing.slice(0, req ? 999 : 20)) console.log(`   ${k}`);
  }
  if (extra.length) console.log(`! ${lang}: ${extra.length} chiavi non presenti in it: ${extra.slice(0, 20).join(', ')}`);
  if (shape.length) { errors += shape.length; console.log(`✕ ${lang}: forma diversa (testo/plurale) per ${shape.join(', ')}`); }
  if (!missing.length && !extra.length && !shape.length) console.log(`✓ ${lang}: completo (${Object.keys(d).length} chiavi)`);
}
console.log(`✓ it: ${Object.keys(reference).length} chiavi · usate nel codice: ${used.size} (+ ${prefixes.size} prefissi dinamici)`);
process.exit(errors ? 1 : 0);
