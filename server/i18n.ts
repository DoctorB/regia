// Caricamento delle traduzioni da locales/<lingua>/*.json. I file vengono riletti quando cambiano,
// quindi una lingua nuova o una correzione non richiedono di riavviare né di ricompilare.
import fs from 'node:fs';
import path from 'node:path';
import { createTranslator, flatten, type FlatDict, type LanguageInfo, type Translate } from '../shared/i18n.ts';
import { ROOT } from './store.ts';

export const LOCALES_DIR = path.join(ROOT, 'locales');
/** Lingue di riserva, in ordine, per le chiavi mancanti. */
export const FALLBACKS = ['en', 'it'];

const cache = new Map<string, { stamp: string; dict: FlatDict }>();

function stampOf(dir: string): string {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => `${f}:${fs.statSync(path.join(dir, f)).mtimeMs}`).join('|');
  } catch {
    return '';
  }
}

/** Dizionario piatto di una sola lingua (tutti i file JSON della sua cartella, uniti). */
export function loadDict(lang: string): FlatDict {
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(lang)) return {};
  const dir = path.join(LOCALES_DIR, lang);
  const stamp = stampOf(dir);
  const hit = cache.get(lang);
  if (hit && hit.stamp === stamp) return hit.dict;
  const dict: FlatDict = {};
  if (stamp) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json') && !x.startsWith('_')).sort()) {
      try {
        Object.assign(dict, flatten(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))));
      } catch (e) {
        console.error(`Traduzioni non valide in ${lang}/${f}: ${(e as Error).message}`);
      }
    }
  }
  cache.set(lang, { stamp, dict });
  return dict;
}

export function languages(): LanguageInfo[] {
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(LOCALES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* nessuna */ }
  return dirs.map((code) => {
    let meta: Partial<LanguageInfo> = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, code, '_meta.json'), 'utf8')); } catch { /* facoltativo */ }
    return { code, name: meta.name ?? code, locale: meta.locale ?? code };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function localeOf(lang: string): string {
  return languages().find((l) => l.code === lang)?.locale ?? lang;
}

/** Dizionario con le lingue di riserva già applicate (per l'interfaccia). */
export function mergedDict(lang: string): FlatDict {
  // Priorità: lingua scelta, poi le lingue di riserva. Si applicano dalla meno importante alla più importante.
  const priority = [...new Set([lang, ...FALLBACKS])];
  return Object.assign({}, ...priority.reverse().map(loadDict));
}

/** Funzione di traduzione lato server (istruzioni per gli agenti, testi di riserva dei messaggi). */
export function serverT(lang = 'it'): Translate {
  const chain = [...new Set([lang, ...FALLBACKS])];
  return createTranslator(chain.map(loadDict), localeOf(lang));
}

/** Lingua predefinita del server, dal sistema (it se italiano, altrimenti en). */
export function systemLanguage(): string {
  const env = process.env.REGIA_LANG;
  if (env) return env;
  const loc = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
  const code = loc.split('-')[0];
  return languages().some((l) => l.code === code) ? code : 'en';
}
