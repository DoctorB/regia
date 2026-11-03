// Elementi visivi condivisi: icone e colori per tipo di fase e stato, notifiche, piccoli componenti.
import { useEffect, useState, type ReactNode } from 'react';
import {
  Ban, CircleCheck, CircleDashed, CircleX, Eye, FlaskConical, Globe, Hand, Info, Loader2, OctagonPause, Recycle, Rocket, Search, Sparkles,
  TriangleAlert, Wrench, X, type LucideIcon,
} from 'lucide-react';
import type { NodeStatus, PhaseKind, RunStatus, ServiceStatus } from '../../shared/types.ts';
import { t, useI18n } from './i18n.tsx';

// Etichette tradotte (chiavi in locales/<lingua>/app.json). Funzioni, non costanti: seguono la lingua corrente.
export const kindLabel = (k: PhaseKind) => t(`kinds.${k}.label`);
export const kindHint = (k: PhaseKind) => t(`kinds.${k}.hint`);
export const statusLabel = (s: NodeStatus) => t(`status.${s}`);
export const runStatusLabel = (s: RunStatus) => t(`runStatus.${s}`);
export const serviceLabel = (s: ServiceStatus) => t(`service.${s}`);

// Le etichette restano leggibili come proprietà calcolate (deprecate) finché tutti i componenti usano le funzioni sopra.
type Labeled<T> = T & {
  /** @deprecated usare kindLabel / statusLabel / runStatusLabel */
  readonly label: string;
  /** @deprecated usare kindHint */
  readonly hint: string;
};
function withLabels<K extends string, T extends object>(meta: Record<K, T>, label: (k: K) => string, hint?: (k: K) => string): Record<K, Labeled<T>> {
  for (const k of Object.keys(meta) as K[]) {
    Object.defineProperty(meta[k], 'label', { get: () => label(k), enumerable: true });
    if (hint) Object.defineProperty(meta[k], 'hint', { get: () => hint(k), enumerable: true });
  }
  return meta as Record<K, Labeled<T>>;
}

export const KIND_META = withLabels<PhaseKind, { icon: LucideIcon }>({
  analisi: { icon: Search },
  implementazione: { icon: Wrench },
  test: { icon: FlaskConical },
  revisione: { icon: Eye },
  approvazione: { icon: Hand },
  server: { icon: Globe },
  personalizzata: { icon: Sparkles },
}, kindLabel, kindHint);

export const STATUS_META = withLabels<NodeStatus, { icon: LucideIcon; tone: string; spin?: boolean }>({
  in_attesa: { icon: CircleDashed, tone: 'idle' },
  attiva: { icon: Loader2, tone: 'active', spin: true },
  completata: { icon: CircleCheck, tone: 'good' },
  fallita: { icon: CircleX, tone: 'bad' },
  bloccata: { icon: OctagonPause, tone: 'warn' },
  attesa_intervento: { icon: Hand, tone: 'warn' },
  saltata: { icon: Ban, tone: 'idle' },
  riusata: { icon: Recycle, tone: 'reused' },
}, statusLabel);

export const RUN_STATUS_META = withLabels<RunStatus, { tone: string }>({
  in_corso: { tone: 'active' },
  attesa_intervento: { tone: 'warn' },
  completata: { tone: 'good' },
  fallita: { tone: 'bad' },
  annullata: { tone: 'idle' },
  interrotta: { tone: 'bad' },
}, runStatusLabel);

export function KindTile({ kind, size = 'md' }: { kind: PhaseKind; size?: 'sm' | 'md' | 'lg' }) {
  const Icon = KIND_META[kind].icon;
  return <span className={`kind-tile kind-${kind} kt-${size}`} aria-hidden><Icon /></span>;
}

export function StatusPill({ status, compact = false }: { status: NodeStatus; compact?: boolean }) {
  useI18n();
  const m = STATUS_META[status];
  const Icon = m.icon;
  const label = statusLabel(status);
  return (
    <span className={`pill tone-${m.tone}`} title={label}>
      <Icon className={m.spin ? 'spin' : ''} />{!compact && label}
    </span>
  );
}

export const modelTier = (m: string) => (/haiku/i.test(m) ? 1 : /opus|fable/i.test(m) ? 3 : /sonnet/i.test(m) ? 2 : 0);

// ---------- Notifiche ----------
type Toast = { id: number; tone: 'info' | 'good' | 'bad'; text: string };
let toasts: Toast[] = [];
const listeners = new Set<(t: Toast[]) => void>();
let seq = 0;
export function toast(text: string, tone: Toast['tone'] = 'info') {
  const t = { id: ++seq, tone, text };
  toasts = [...toasts, t];
  listeners.forEach((l) => l(toasts));
  setTimeout(() => dismiss(t.id), tone === 'bad' ? 8000 : 3500);
}
function dismiss(id: number) {
  toasts = toasts.filter((x) => x.id !== id);
  listeners.forEach((l) => l(toasts));
}
export function Toasts() {
  const { t } = useI18n();
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => { listeners.add(setList); return () => { listeners.delete(setList); }; }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((item) => {
        const Icon = item.tone === 'bad' ? TriangleAlert : item.tone === 'good' ? CircleCheck : Info;
        return (
          <div key={item.id} className={`toast tone-${item.tone}`}>
            <Icon /><span>{item.text}</span>
            <button className="icon-btn ghost" onClick={() => dismiss(item.id)} aria-label={t('common.close')}><X /></button>
          </div>
        );
      })}
    </div>
  );
}

// ---------- Componenti ----------
/** Finestre aperte, dalla più vecchia alla più recente: Esc chiude solo l'ultima. */
const modalStack: symbol[] = [];

// ---------- Tema ----------
export type ThemeChoice = 'system' | 'light' | 'dark';
const THEME_KEY = 'regia.theme';
export function readTheme(): ThemeChoice {
  try { const v = localStorage.getItem(THEME_KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; }
}
export function applyTheme(choice: ThemeChoice) {
  if (choice === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;
  try { if (choice === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, choice); } catch { /* non disponibile */ }
}
export function Modal({ title, icon, onClose, children, footer, wide = false }: { title: string; icon?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const { t } = useI18n();
  useEffect(() => {
    const id = Symbol('modal');
    modalStack.push(id);
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && modalStack.at(-1) === id) onClose(); };
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('keydown', k); modalStack.splice(modalStack.indexOf(id), 1); };
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <header className="modal-head">
          {icon}<h2>{title}</h2>
          <button className="icon-btn ghost" onClick={onClose} aria-label={t('common.close')}><X /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head"><h4>{title}</h4>{aside}</div>
      <div className="section-body">{children}</div>
    </section>
  );
}

export function Switch({ checked, onChange, label, hint, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; id?: string }) {
  return (
    <label className="switch-row" htmlFor={id}>
      <span className="switch-text"><span>{label}</span>{hint && <small>{hint}</small>}</span>
      <input id={id} type="checkbox" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return <div className="empty-state">{icon}<strong>{title}</strong>{children && <p>{children}</p>}</div>;
}

export { Rocket };
