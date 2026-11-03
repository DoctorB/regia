// Configurazioni predefinite delle fasi. La struttura (modello, strumenti, limiti) è qui; i testi (nome, ruolo,
// istruzioni) arrivano dalle traduzioni: chiavi presets.<tipo>.* e snippets.<id>.* in locales/<lingua>/presets.json.
import type { Translate } from './i18n.ts';
import type { PhaseConfig, PhaseKind } from './types.ts';

type Base = Omit<PhaseConfig, 'label' | 'role' | 'instructions'>;

const BASE: Record<PhaseKind, Base> = {
  analisi: { kind: 'analisi', model: 'sonnet', allowedTools: ['Read', 'Glob', 'Grep'], maxTurns: 15, contextMode: 'sintesi', reuseResult: false },
  implementazione: { kind: 'implementazione', model: 'sonnet', allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'], maxTurns: 30, contextMode: 'sintesi', reuseResult: false },
  test: { kind: 'test', model: 'sonnet', allowedTools: ['Read', 'Glob', 'Grep', 'Bash'], maxTurns: 10, contextMode: 'sintesi', reuseResult: false },
  revisione: { kind: 'revisione', model: 'sonnet', allowedTools: ['Read', 'Glob', 'Grep'], maxTurns: 15, contextMode: 'sintesi', reuseResult: false },
  approvazione: { kind: 'approvazione', model: '', allowedTools: [], contextMode: 'sintesi', reuseResult: false },
  server: { kind: 'server', model: '', allowedTools: [], contextMode: 'nessuno', reuseResult: false, command: 'npm run dev', url: '', subdir: '', readyTimeoutSec: 90 },
  personalizzata: { kind: 'personalizzata', model: 'sonnet', allowedTools: ['Read', 'Glob', 'Grep'], maxTurns: 15, contextMode: 'sintesi', reuseResult: false },
};

/** Configurazione iniziale di una fase nuova, con i testi nella lingua indicata da t. */
export function phasePreset(kind: PhaseKind, t: Translate): PhaseConfig {
  const role = t(`presets.${kind}.role`);
  const instructions = t(`presets.${kind}.instructions`);
  return {
    ...structuredClone(BASE[kind]),
    label: t(`presets.${kind}.label`),
    role: role === `presets.${kind}.role` ? '' : role,
    instructions: instructions === `presets.${kind}.instructions` ? '' : instructions,
  };
}

export interface PhaseSnippet { id: string; label: string; hint: string; data: PhaseConfig }

const SNIPPETS: { id: string; base: Base }[] = [
  {
    id: 'pubblicazione',
    base: { kind: 'personalizzata', model: 'sonnet', allowedTools: ['Read', 'Glob', 'Grep', 'Bash'], maxTurns: 15, maxBudgetUsd: 0.4, contextMode: 'sintesi', reuseResult: false },
  },
];

/** Fasi pronte all'uso della palette, con i testi nella lingua indicata da t. */
export function phaseSnippets(t: Translate): PhaseSnippet[] {
  return SNIPPETS.map(({ id, base }) => ({
    id,
    label: t(`snippets.${id}.label`),
    hint: t(`snippets.${id}.hint`),
    data: { ...structuredClone(base), label: t(`snippets.${id}.phaseLabel`), role: t(`snippets.${id}.role`), instructions: t(`snippets.${id}.instructions`) },
  }));
}
