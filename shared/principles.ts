// Principi di progettazione attivabili per un workflow. I testi (nome, sintesi, indicazioni per tipo di fase)
// sono nelle traduzioni: chiavi principles.<id>.* in locales/<lingua>/principles.json.
import type { Translate } from './i18n.ts';
import type { PhaseKind } from './types.ts';

export const PRINCIPLES = ['kiss', 'yagni', 'dry', 'solid'] as const;
export type PrincipleId = (typeof PRINCIPLES)[number];

/** Principi attivi riconosciuti, nell'ordine di PRINCIPLES (gli id sconosciuti vengono ignorati). */
export const activePrinciples = (ids?: readonly string[]): PrincipleId[] => PRINCIPLES.filter((p) => ids?.includes(p));

/**
 * Indicazioni dei principi attivi per un tipo di fase: per gli agenti un blocco da aggiungere al prompt di sistema,
 * per le approvazioni una checklist per chi approva. Vuoto se nessun principio è attivo o per le fasi "Avvio app".
 */
export function principlesText(ids: readonly string[] | undefined, kind: PhaseKind, t: Translate): string {
  const list = activePrinciples(ids);
  if (!list.length || kind === 'server') return '';
  if (kind === 'approvazione') return [t('principles.prompt.approvalHeader'), ...list.map((p) => `- ${t(`principles.${p}.checklist`)}`)].join('\n');
  const parts = list.map((p) => `## ${t(`principles.${p}.name`)}\n${t(`principles.${p}.summary`)}\n${t(`principles.${p}.${kind}`)}`);
  return `${t('principles.prompt.header')}\n\n${parts.join('\n\n')}`;
}
