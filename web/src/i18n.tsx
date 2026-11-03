// Localizzazione dell'interfaccia. Le traduzioni arrivano dal server (locales/<lingua>/*.json) all'avvio
// e quando si cambia lingua: aggiungere una lingua non richiede di ricompilare l'interfaccia.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createTranslator, render, type FlatDict, type LanguageInfo, type Msg, type Params, type Translate } from '../../shared/i18n.ts';

const STORAGE_KEY = 'regia.lang';

let currentT: Translate = (k) => k;
let currentLocale = 'it-IT';

/** Traduzione fuori dai componenti (formattatori, messaggi): usa la lingua corrente. */
export const t: Translate = (key, params) => currentT(key, params);
export const tm = (m: Msg | undefined, fallback = '') => render(currentT, m, fallback);
export const currentLocaleTag = () => currentLocale;

interface I18nValue {
  t: Translate;
  /** Traduce un messaggio del server (chiave e parametri), con testo di riserva. */
  tm: (m: Msg | undefined, fallback?: string) => string;
  lang: string;
  locale: string;
  languages: LanguageInfo[];
  setLang: (code: string) => void;
}

const Ctx = createContext<I18nValue | null>(null);

function preferred(langs: LanguageInfo[]): string {
  let saved: string | null = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* non disponibile */ }
  if (saved && langs.some((l) => l.code === saved)) return saved;
  for (const n of navigator.languages ?? [navigator.language]) {
    const code = n.toLowerCase().split('-')[0];
    if (langs.some((l) => l.code === code)) return code;
  }
  return langs.some((l) => l.code === 'en') ? 'en' : langs[0]?.code ?? 'it';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [languages, setLanguages] = useState<LanguageInfo[]>([]);
  const [lang, setLangState] = useState<string>('');
  const [dict, setDict] = useState<FlatDict | null>(null);

  useEffect(() => {
    fetch('/api/i18n').then((r) => r.json()).then((langs: LanguageInfo[]) => {
      setLanguages(langs);
      setLangState(preferred(langs));
    }).catch(() => setLangState('it'));
  }, []);

  useEffect(() => {
    if (!lang) return;
    fetch(`/api/i18n/${lang}`).then((r) => r.json()).then((d: FlatDict) => setDict(d)).catch(() => setDict({}));
    document.documentElement.lang = lang;
  }, [lang]);

  const locale = languages.find((l) => l.code === lang)?.locale ?? lang;
  const translate = useMemo(() => createTranslator([dict ?? {}], locale || 'it-IT'), [dict, locale]);
  currentT = translate;
  currentLocale = locale || 'it-IT';

  const setLang = useCallback((code: string) => {
    try { localStorage.setItem(STORAGE_KEY, code); } catch { /* non disponibile */ }
    setLangState(code);
  }, []);

  const value = useMemo<I18nValue>(() => ({
    t: translate,
    tm: (m: Msg | undefined, fallback = '') => render(translate, m, fallback),
    lang, locale, languages, setLang,
  }), [translate, lang, locale, languages, setLang]);

  if (!dict) return null;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n fuori da I18nProvider');
  return v;
}

export type { Msg, Params };
