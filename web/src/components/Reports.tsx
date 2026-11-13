// Segnalazioni di errore: la richiesta di consenso (una sola volta) e il pannello con la scelta e il contenuto esatto
// di ogni segnalazione inviata. Finché non si risponde, Regia non invia nulla.
import { useCallback, useEffect, useState } from 'react';
import { Bug, ChevronDown, X } from 'lucide-react';
import type { ErrorReport, ReportsInfo } from '../../../shared/types.ts';
import { api, fmtTime } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { Modal, Switch, toast } from '../ui.tsx';

/** Stato condiviso tra il riquadro del consenso e il pannello: si ricarica dopo ogni scelta. */
let listeners = new Set<(i: ReportsInfo) => void>();
async function refresh() {
  const info = await api.reports();
  for (const l of listeners) l(info);
  return info;
}
function useReports() {
  const [info, setInfo] = useState<ReportsInfo | null>(null);
  useEffect(() => {
    listeners.add(setInfo);
    void refresh().catch(() => undefined);
    return () => { listeners.delete(setInfo); };
  }, []);
  const choose = useCallback(async (consent: 'si' | 'no') => {
    try { await api.setReportsConsent(consent); await refresh(); } catch (e) { toast((e as Error).message, 'bad'); }
  }, []);
  return { info, choose };
}

/** Cosa contiene una segnalazione e cosa no: testo comune al riquadro e al pannello. */
function WhatIsSent() {
  const { t } = useI18n();
  return (
    <ul className="reports-what">
      <li>{t('reports.what.sent')}</li>
      <li>{t('reports.what.notSent')}</li>
      <li>{t('reports.what.where')}</li>
    </ul>
  );
}

/** Richiesta di consenso, in basso a destra, finché la persona non sceglie. */
export function ReportsConsent() {
  const { t } = useI18n();
  const { info, choose } = useReports();
  const [more, setMore] = useState(false);
  if (!info || info.disabled || info.consent) return null;
  return (
    <div className="reports-consent card" role="dialog" aria-label={t('reports.consent.title')}>
      <div className="reports-consent-head"><Bug /><strong>{t('reports.consent.title')}</strong></div>
      <p>{t('reports.consent.body')}</p>
      <button className="link-btn" onClick={() => setMore((m) => !m)}><ChevronDown className={more ? 'rot' : ''} />{t('reports.consent.what')}</button>
      {more && <WhatIsSent />}
      <div className="actions">
        <button className="btn primary" onClick={() => void choose('si')}>{t('reports.consent.yes')}</button>
        <button className="btn ghost" onClick={() => void choose('no')}>{t('reports.consent.no')}</button>
      </div>
    </div>
  );
}

const shown = (r: ErrorReport) => {
  const { sent, sentAt, rejected, ...body } = r;
  void sent; void sentAt; void rejected;
  return JSON.stringify(body, null, 2);
};

/** Pulsante della barra in alto con il pannello delle segnalazioni. */
export function ReportsButton() {
  const { t } = useI18n();
  const { info, choose } = useReports();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button className="icon-btn" onClick={() => { setOpen(true); void refresh(); }} title={t('reports.button')} aria-label={t('reports.button')}><Bug /></button>
      {open && info && (
        <Modal title={t('reports.title')} icon={<Bug />} onClose={close} wide>
          {info.disabled ? <p className="hint">{t('reports.disabled')}</p> : (
            <Switch checked={info.consent === 'si'} onChange={(v) => void choose(v ? 'si' : 'no')} label={t('reports.toggle')} hint={t('reports.toggleHint')} />
          )}
          <WhatIsSent />
          <p className="muted small">{t('reports.endpoint', { url: info.endpoint })}</p>
          <h4 className="reports-list-title">{t('reports.listTitle', { count: info.reports.length })}</h4>
          {info.reports.length === 0 ? <p className="hint">{t('reports.none')}</p> : (
            <div className="reports-list">
              {info.reports.map((r) => (
                <details key={r.at + r.message.slice(0, 20)} className="pred">
                  <summary>
                    <span className={`pill ${r.sent ? 'tone-good' : r.rejected ? 'tone-bad' : 'tone-warn'}`}>{t(r.sent ? 'reports.status.sent' : r.rejected ? 'reports.status.rejected' : 'reports.status.queued')}</span>
                    <span className="muted small">{fmtTime(r.at)} · {t(`reports.source.${r.source}`)}</span>
                    <span className="reports-msg">{r.message}</span>
                  </summary>
                  <pre className="pre reports-json">{shown(r)}</pre>
                </details>
              ))}
            </div>
          )}
          <div className="actions"><span className="grow" /><button className="btn ghost" onClick={close}><X />{t('reports.close')}</button></div>
        </Modal>
      )}
    </>
  );
}

/** Errori dell'interfaccia: passati a Regia, che li invia solo se c'è il consenso. Al massimo 5 per sessione. */
export function captureUiErrors() {
  let left = 5;
  const send = (message: string, detail?: string) => {
    if (left-- <= 0 || !message) return;
    void api.reportUi(message, detail).catch(() => undefined);
  };
  window.addEventListener('error', (e) => send(e.message, e.error instanceof Error ? e.error.stack : `${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    send(r instanceof Error ? r.message : String(r), r instanceof Error ? r.stack : undefined);
  });
}
