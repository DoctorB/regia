import { PRINCIPLES, activePrinciples, principlesText } from '../../../shared/principles.ts';
import type { PhaseKind } from '../../../shared/types.ts';
import { useI18n } from '../i18n.tsx';
import { Switch } from '../ui.tsx';

/** Un interruttore per ogni principio di progettazione; il valore è l'elenco dei principi attivi. */
export function PrinciplePicker({ value, onChange }: { value?: string[]; onChange: (v: string[] | undefined) => void }) {
  const { t } = useI18n();
  const on = activePrinciples(value);
  const toggle = (p: string, v: boolean) => {
    const next = activePrinciples(v ? [...on, p] : on.filter((x) => x !== p));
    onChange(next.length ? next : undefined);
  };
  return (
    <div className="principle-grid">
      {PRINCIPLES.map((p) => (
        <Switch key={p} id={`principle-${p}`} checked={on.includes(p)} onChange={(v) => toggle(p, v)} label={t(`principles.${p}.name`)} hint={t(`principles.${p}.summary`)} />
      ))}
    </div>
  );
}

/** Anteprima delle indicazioni che i principi attivi aggiungono a una fase. */
export function PrinciplesPreview({ value, kind }: { value?: string[]; kind: PhaseKind }) {
  const { t } = useI18n();
  const text = principlesText(value, kind, t);
  if (!text) return null;
  const names = activePrinciples(value).map((p) => p.toUpperCase()).join(' · ');
  return (
    <details className="principles-preview">
      <summary><span>{t('principles.preview')}</span><span className="pill tone-active">{names}</span></summary>
      <p className="reason">{text}</p>
    </details>
  );
}
