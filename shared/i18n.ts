// Localizzazione: testi in file JSON per lingua (locales/<lingua>/*.json), chiavi a punti, parametri {nome},
// plurali come oggetti {"one": "...", "other": "..."} scelti con Intl.PluralRules sul parametro "count".
// Usato sia dal server (messaggi, istruzioni per gli agenti) sia dall'interfaccia.

export type Params = Record<string, string | number | undefined>;

/** Messaggio localizzabile: chiave e parametri, tradotto da chi lo mostra. */
export interface Msg {
  key: string;
  params?: Params;
}

export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
export type FlatDict = Record<string, string | PluralForms>;
export type Translate = (key: string, params?: Params) => string;

export const msg = (key: string, params?: Params): Msg => ({ key, params });

/** Appiattisce un dizionario annidato in chiavi a punti. Gli oggetti plurali restano oggetti. */
export function flatten(obj: unknown, prefix = '', out: FlatDict = {}): FlatDict {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (k.startsWith('_')) continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else if (isPlural(v)) out[key] = v as PluralForms;
    else flatten(v, key, out);
  }
  return out;
}

function isPlural(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const keys = Object.keys(v as object);
  return keys.includes('other') && keys.every((k) => ['zero', 'one', 'two', 'few', 'many', 'other'].includes(k) && typeof (v as Record<string, unknown>)[k] === 'string');
}

/**
 * Crea la funzione di traduzione. I dizionari sono in ordine di priorità (lingua scelta, poi le lingue di riserva).
 * Una chiave assente in tutti i dizionari viene restituita così com'è, per renderla visibile.
 */
export function createTranslator(dicts: FlatDict[], locale: string): Translate {
  const plural = new Intl.PluralRules(locale);
  const num = new Intl.NumberFormat(locale);
  return (key, params) => {
    let v: string | PluralForms | undefined;
    for (const d of dicts) { v = d[key]; if (v !== undefined) break; }
    if (v === undefined) return key;
    let s: string;
    if (typeof v === 'string') s = v;
    else {
      const n = Number(params?.count ?? 0);
      s = v[plural.select(n)] ?? v.other;
    }
    if (!params) return s;
    return s.replace(/\{(\w+)\}/g, (m, name: string) => {
      const p = params[name];
      if (p === undefined) return m;
      return typeof p === 'number' && name === 'count' ? num.format(p) : String(p);
    });
  };
}

/** Testo di un messaggio: traduzione se c'è la chiave, altrimenti il testo di riserva. */
export function render(t: Translate, m: Msg | undefined, fallback = ''): string {
  return m ? t(m.key, m.params) : fallback;
}

export interface LanguageInfo {
  code: string;
  name: string;
  /** Locale per numeri e date, es. it-IT. */
  locale: string;
}
