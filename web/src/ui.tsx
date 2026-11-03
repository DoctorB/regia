// Elementi visivi condivisi: icone e colori per tipo di fase e stato, notifiche, piccoli componenti.
import { useEffect, useState, type ReactNode } from 'react';
import {
  Ban, CircleCheck, CircleDashed, CircleX, Eye, FlaskConical, Globe, Hand, Info, Loader2, OctagonPause, Recycle, Rocket, Search, Sparkles,
  TriangleAlert, Wrench, X, type LucideIcon,
} from 'lucide-react';
import type { NodeStatus, PhaseKind, RunStatus } from '../../shared/types.ts';

export const KIND_META: Record<PhaseKind, { label: string; icon: LucideIcon; hint: string }> = {
  analisi: { label: 'Analisi', icon: Search, hint: 'Legge il codice e individua cosa fare' },
  implementazione: { label: 'Implementazione', icon: Wrench, hint: 'Modifica il codice' },
  test: { label: 'Test', icon: FlaskConical, hint: 'Esegue i test e riporta l\'esito' },
  revisione: { label: 'Revisione', icon: Eye, hint: 'Controlla le modifiche' },
  approvazione: { label: 'Approvazione umana', icon: Hand, hint: 'Si ferma finché non decidi tu' },
  server: { label: 'Server locale', icon: Globe, hint: 'Avvia l\'anteprima nel browser' },
  personalizzata: { label: 'Personalizzata', icon: Sparkles, hint: 'Agente con istruzioni libere' },
};

export const STATUS_META: Record<NodeStatus, { label: string; icon: LucideIcon; tone: string; spin?: boolean }> = {
  in_attesa: { label: 'In attesa', icon: CircleDashed, tone: 'idle' },
  attiva: { label: 'Attiva', icon: Loader2, tone: 'active', spin: true },
  completata: { label: 'Completata', icon: CircleCheck, tone: 'good' },
  fallita: { label: 'Fallita', icon: CircleX, tone: 'bad' },
  bloccata: { label: 'Bloccata', icon: OctagonPause, tone: 'warn' },
  attesa_intervento: { label: 'Attende te', icon: Hand, tone: 'warn' },
  saltata: { label: 'Saltata', icon: Ban, tone: 'idle' },
  riusata: { label: 'Ripresa', icon: Recycle, tone: 'reused' },
};

export const RUN_STATUS_META: Record<RunStatus, { label: string; tone: string }> = {
  in_corso: { label: 'In corso', tone: 'active' },
  attesa_intervento: { label: 'Serve il tuo intervento', tone: 'warn' },
  completata: { label: 'Completata', tone: 'good' },
  fallita: { label: 'Fallita', tone: 'bad' },
  annullata: { label: 'Annullata', tone: 'idle' },
  interrotta: { label: 'Interrotta', tone: 'bad' },
};

export function KindTile({ kind, size = 'md' }: { kind: PhaseKind; size?: 'sm' | 'md' | 'lg' }) {
  const Icon = KIND_META[kind].icon;
  return <span className={`kind-tile kind-${kind} kt-${size}`} aria-hidden><Icon /></span>;
}

export function StatusPill({ status, compact = false }: { status: NodeStatus; compact?: boolean }) {
  const m = STATUS_META[status];
  const Icon = m.icon;
  return (
    <span className={`pill tone-${m.tone}`} title={m.label}>
      <Icon className={m.spin ? 'spin' : ''} />{!compact && m.label}
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
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => { listeners.add(setList); return () => { listeners.delete(setList); }; }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => {
        const Icon = t.tone === 'bad' ? TriangleAlert : t.tone === 'good' ? CircleCheck : Info;
        return (
          <div key={t.id} className={`toast tone-${t.tone}`}>
            <Icon /><span>{t.text}</span>
            <button className="icon-btn ghost" onClick={() => dismiss(t.id)} aria-label="Chiudi"><X /></button>
          </div>
        );
      })}
    </div>
  );
}

// ---------- Componenti ----------
export function Modal({ title, icon, onClose, children, footer, wide = false }: { title: string; icon?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <header className="modal-head">
          {icon}<h2>{title}</h2>
          <button className="icon-btn ghost" onClick={onClose} aria-label="Chiudi"><X /></button>
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
