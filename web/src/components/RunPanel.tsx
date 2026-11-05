import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, Bot, CircleAlert, CircleCheck, Clock, Coins, Copy, CornerDownRight, Download, ExternalLink, FileText, Flag, Gauge, Globe, Hand, Info, Lightbulb, ListTree,
  MessageSquareText, OctagonX, Pause, Play, Recycle, RotateCcw, SkipForward, Square, Terminal, TriangleAlert, Undo2, Workflow as WorkflowIcon, X,
  type LucideIcon,
} from 'lucide-react';
import { isAgentKind, RESUMABLE, type EventKind, type HumanAction, type Insight, type Run, type RunSummary } from '../../../shared/types.ts';
import { layoutGraph } from '../../../shared/layout.ts';
import { runReport } from '../../../shared/report.ts';
import { api, fmtDur, fmtTime, fmtTok, fmtUsd, runDuration } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { EmptyState, KindTile, Modal, RUN_STATUS_META, STATUS_META, StatusPill, runStatusLabel, serviceLabel, statusLabel, toast } from '../ui.tsx';
import { AppliedRulesView } from './Setup.tsx';
import { UsageView } from './UsageView.tsx';

// Etichette e aiuti in locales/<lingua>/run.json (actions.<azione>.label e .help).
const ACTION: Record<HumanAction, { icon: LucideIcon; cls?: string; help?: boolean }> = {
  approva: { icon: CircleCheck, cls: 'primary' },
  respingi: { icon: Undo2, help: true },
  riprova: { icon: RotateCcw, help: true },
  riprendi: { icon: Play, help: true },
  salta: { icon: SkipForward, help: true },
  annulla: { icon: OctagonX, cls: 'danger' },
  installa_node: { icon: Play, cls: 'primary', help: true },
  installa_dipendenze: { icon: Play, cls: 'primary', help: true },
};

// Etichette in locales/<lingua>/run.json (events.kind.<tipo>).
const EVENT: Record<EventKind, { icon: LucideIcon }> = {
  run: { icon: Flag }, fase: { icon: WorkflowIcon }, testo: { icon: MessageSquareText },
  decisione: { icon: Lightbulb }, strumento: { icon: Terminal }, esito_strumento: { icon: CornerDownRight },
  subagente: { icon: Bot }, consumi: { icon: Coins }, risultato: { icon: CircleCheck },
  errore: { icon: TriangleAlert }, intervento: { icon: Hand }, limite: { icon: Gauge }, servizio: { icon: Globe },
};

type Tab = 'stato' | 'eventi' | 'decisioni' | 'consumi' | 'ottimizza';

interface Props {
  run: Run;
  runs: RunSummary[];
  selectedNode: string | null;
  onSelectNode: (id: string | null) => void;
  onOpenRun: (id: string) => void;
  onContinue?: () => void;
}

export function RunPanel({ run, runs, selectedNode, onSelectNode, onOpenRun, onContinue }: Props) {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('stato');
  const [report, setReport] = useState(false);
  const pending = Object.values(run.nodes).filter((n) => n.pendingActions?.length);
  useEffect(() => { if (pending.length) setTab('stato'); }, [pending.length]);
  const label = (id?: string) => run.snapshot.nodes.find((n) => n.id === id)?.data.label ?? id ?? '';
  const live = run.status === 'in_corso' || run.status === 'attesa_intervento';
  const [, force] = useState(0);
  useEffect(() => { if (!live) return; const h = setInterval(() => force((x) => x + 1), 1000); return () => clearInterval(h); }, [live]);

  const ordered = useMemo(() => {
    const pos = layoutGraph(run.snapshot.nodes, run.snapshot.edges);
    return [...run.snapshot.nodes].sort((a, b) => pos[a.id].y - pos[b.id].y || pos[a.id].x - pos[b.id].x);
  }, [run.snapshot]);
  const doneCount = ordered.filter((n) => ['completata', 'riusata', 'saltata'].includes(run.nodes[n.id]?.status)).length;
  const decisions = run.events.filter((e) => e.kind === 'decisione').length;
  const rs = RUN_STATUS_META[run.status];
  const cost = run.totals.costUsd ?? 0;
  const budgetPct = run.budgetUsd ? Math.min(100, (cost / run.budgetUsd) * 100) : 0;
  const totalTok = run.totals.inputTokens + run.totals.outputTokens + run.totals.cacheCreationInputTokens + run.totals.cacheReadInputTokens;

  const resumable = RESUMABLE.includes(run.status);
  const [busy, setBusy] = useState(false);

  const cancel = async () => {
    if (!confirm(t('run.confirmCancel'))) return;
    try {
      await api.cancel(run.id);
      // Un'esecuzione sospesa non ha uno stream attivo: si ricarica dal file.
      if (resumable) onOpenRun(run.id);
    } catch (e) { toast((e as Error).message, 'bad'); }
  };

  const suspend = async () => {
    setBusy(true);
    try { await api.suspend(run.id); toast(t('run.suspend.done'), 'good'); } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
  };

  const resume = async () => {
    setBusy(true);
    try {
      // Avviso se nel frattempo il progetto ha cambiato ramo o commit (pull, checkout, commit manuali).
      const g = await api.resumeCheck(run.id);
      const changes = [
        g.branchChanged ? t('run.resume.branchChanged', { before: g.before?.branch ?? '', now: g.now?.branch ?? '' }) : '',
        g.headChanged ? t('run.resume.headChanged', { before: g.before?.head?.slice(0, 8) ?? '', now: g.now?.head?.slice(0, 8) ?? '' }) : '',
      ].filter(Boolean);
      if (changes.length && !confirm(`${changes.join('\n')}\n\n${t('run.resume.confirmChanged')}`)) return;
      await api.resume(run.id, run.mode === 'reale');
      onOpenRun(run.id);
      toast(t('run.resume.done'), 'good');
    } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
  };

  const TABS: [Tab, string, LucideIcon, number?][] = [
    ['stato', t('run.tabs.status'), Activity, pending.length || undefined],
    ['eventi', t('run.tabs.events'), ListTree],
    ['decisioni', t('run.tabs.decisions'), Lightbulb, decisions || undefined],
    ['consumi', t('run.tabs.usage'), Coins],
    ['ottimizza', t('run.tabs.optimize'), Gauge],
  ];

  return (
    <div className="runpanel">
      <header className="run-head">
        <div className="run-head-row">
          <span className={`pill lg tone-${rs.tone}`}><span className={`dot ${live ? 'pulse' : ''}`} />{runStatusLabel(run.status)}</span>
          <span className={`tag ${run.mode === 'reale' ? 'tag-real' : ''}`}>{run.mode === 'prova' ? t('run.mode.prova') : t('run.mode.reale')}</span>
          <span className="muted small inline-ic"><Clock />{fmtDur(runDuration(run))}</span>
          {/* Le azioni restano insieme a destra e vanno a capo insieme se lo spazio non basta. */}
          <span className="run-head-actions">
            <button className="btn sm ghost" onClick={() => setReport(true)} title={t('report.buttonTitle')}><FileText />{t('report.button')}</button>
            {live && <button className="btn sm ghost" disabled={busy} onClick={suspend} title={t('run.suspend.hint')}><Pause />{t('run.suspend.label')}</button>}
            {resumable && <button className="btn sm primary" disabled={busy} onClick={resume} title={t('run.resume.hint')}><Play />{t('run.resume.label')}</button>}
            {(live || resumable) && <button className="btn sm ghost danger" disabled={busy} onClick={cancel}><Square />{t('run.cancel')}</button>}
            {!live && onContinue && <button className="btn sm soft" onClick={onContinue} title={t('run.continueHint')}><Recycle />{t('run.continue')}</button>}
          </span>
        </div>
        <select className="run-picker" value={run.id} onChange={(e) => onOpenRun(e.target.value)} aria-label={t('run.picker')}>
          {runs.map((r) => <option key={r.id} value={r.id}>{fmtTime(r.startedAt)} · {r.mode === 'prova' ? t('run.modeLower.prova') : t('run.modeLower.reale')} · {runStatusLabel(r.status).toLowerCase()} · {fmtUsd(r.costUsd, 2)}</option>)}
          {!runs.some((r) => r.id === run.id) && <option value={run.id}>{fmtTime(run.startedAt)}</option>}
        </select>

        <div className="metrics">
          <div className="metric">
            <span className="metric-label">{run.mode === 'prova' ? t('run.metrics.costSimulated') : t('run.metrics.costEstimated')}</span>
            <span className="metric-value num">{fmtUsd(run.totals.costUsd, 3)}</span>
            {run.budgetUsd
              ? <span className="meter" title={t('run.metrics.budgetPct', { pct: Math.round(budgetPct), budget: fmtUsd(run.budgetUsd, 2) })}><span style={{ width: `${budgetPct}%` }} className={budgetPct > 85 ? 'hot' : ''} /></span>
              : <span className="metric-sub">{t('run.metrics.noLimit')}</span>}
            {run.budgetUsd ? <span className="metric-sub">{t('run.metrics.limit', { budget: fmtUsd(run.budgetUsd, 2) })}</span> : null}
          </div>
          <div className="metric">
            <span className="metric-label">{t('run.metrics.phasesDone')}</span>
            <span className="metric-value num">{doneCount}<small>/{ordered.length}</small></span>
          </div>
          <div className="metric">
            <span className="metric-label">{t('run.metrics.tokens')}</span>
            <span className="metric-value num">{fmtTok(totalTok)}</span>
          </div>
        </div>

        <div className="progress" role="list" aria-label={t('run.progress')}>
          {ordered.map((n) => {
            const st = run.nodes[n.id]?.status ?? 'in_attesa';
            return (
              <button key={n.id} role="listitem" className={`seg-step tone-${STATUS_META[st].tone} ${selectedNode === n.id ? 'sel' : ''}`}
                title={`${n.data.label}: ${statusLabel(st)}`} onClick={() => onSelectNode(selectedNode === n.id ? null : n.id)} />
            );
          })}
        </div>
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map(([k, l, Icon, count]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            <Icon />{l}{count ? <span className={`count ${k === 'stato' ? 'warn' : ''}`}>{count}</span> : null}
          </button>
        ))}
      </nav>
      <div className="tab-body">
        {tab === 'stato' && <StatusTab run={run} ordered={ordered.map((n) => n.id)} label={label} selectedNode={selectedNode} onSelectNode={onSelectNode} />}
        {tab === 'eventi' && <EventsTab run={run} label={label} selectedNode={selectedNode} onSelectNode={onSelectNode} />}
        {tab === 'decisioni' && <DecisionsTab run={run} label={label} selectedNode={selectedNode} onSelectNode={onSelectNode} />}
        {tab === 'consumi' && <UsageView run={run} />}
        {tab === 'ottimizza' && <InsightsTab run={run} label={label} onSelectNode={onSelectNode} />}
      </div>
      {report && <ReportDialog run={run} onClose={() => setReport(false)} />}
    </div>
  );
}

function StatusTab({ run, ordered, label, selectedNode, onSelectNode }: { run: Run; ordered: string[]; label: (id?: string) => string; selectedNode: string | null; onSelectNode: (id: string | null) => void }) {
  const { t } = useI18n();
  const pending = ordered.map((id) => run.nodes[id]).filter((n) => n?.pendingActions?.length);
  const services = ordered.map((id) => run.nodes[id])
    .filter((n) => n?.service && !n.pendingActions?.length)
    .filter((n) => !run.snapshot.edges.some((e) => e.source === n.nodeId && run.nodes[e.target]?.pendingActions?.includes('approva')));
  const resumable = RESUMABLE.includes(run.status);
  const interrupted = ordered.filter((id) => run.nodes[id]?.interrupted).map(label);
  return (
    <div className="stack">
      {resumable && (
        <div className="callout tone-warn">
          <Pause />
          <span>
            {t(run.status === 'sospesa' ? 'run.resume.calloutSuspended' : 'run.resume.calloutInterrupted', { date: fmtTime(run.suspendedAt ?? run.endedAt) })}{' '}
            {interrupted.length ? t('run.resume.calloutPhases', { phases: interrupted.join(', ') }) : t('run.resume.calloutNoPhases')}
          </span>
        </div>
      )}
      {pending.map((n) => <InterventionCard key={n.nodeId} run={run} nodeId={n.nodeId} label={label(n.nodeId)} readOnly={resumable} />)}
      {services.map((n) => <ServiceCard key={n.nodeId} run={run} nodeId={n.nodeId} />)}
      {run.notes.map((n, i) => <div key={i} className="callout tone-warn"><TriangleAlert /><span>{n}</span></div>)}
      {run.rateLimit && run.rateLimit.status !== 'allowed' && (
        <div className="callout tone-warn"><Gauge /><span>{t('run.rateLimit', { status: run.rateLimit.status })}{run.rateLimit.type ? ` (${run.rateLimit.type})` : ''}{run.rateLimit.utilization !== undefined ? t('run.rateLimitUsage', { pct: Math.round(run.rateLimit.utilization * 100) }) : ''}.</span></div>
      )}
      <div className="phase-list">
        {ordered.map((id) => {
          const n = run.snapshot.nodes.find((x) => x.id === id)!;
          const s = run.nodes[id];
          const c = s.attempts.reduce((x, a) => x + (a.usage.costUsd ?? 0), 0);
          return (
            <button key={id} className={`phase-row ${selectedNode === id ? 'sel' : ''}`} onClick={() => onSelectNode(selectedNode === id ? null : id)}>
              <KindTile kind={n.data.kind} size="sm" />
              <span className="phase-row-main">
                <span className="phase-row-title">{n.data.label}</span>
                {s.activity ? <span className="phase-row-sub">{s.activity}</span> : s.attempts.length > 1 ? <span className="phase-row-sub">{t('run.attempts', { count: s.attempts.length })}</span> : null}
              </span>
              <StatusPill status={s.status} />
              <span className="phase-row-cost num">{isAgentKind(n.data.kind) && s.attempts.length ? fmtUsd(c, 3) : ''}</span>
            </button>
          );
        })}
      </div>
      {run.reference && (
        <details className="pred">
          <summary><FileText /><strong>{t('run.reference.title')}</strong><span className="muted small">{run.reference.workflowName} · {fmtTime(run.reference.startedAt)}</span></summary>
          <p className="pre">{run.reference.text}</p>
        </details>
      )}
      <AppliedRulesView rules={run.rules} />
      {run.continuedFrom && <p className="muted small">{t('run.continuedFrom', { id: run.continuedFrom })}</p>}
    </div>
  );
}

function InterventionCard({ run, nodeId, label, readOnly = false }: { run: Run; nodeId: string; label: string; readOnly?: boolean }) {
  const { t, tm } = useI18n();
  const n = run.nodes[nodeId];
  const [fb, setFb] = useState('');
  const [busy, setBusy] = useState(false);
  const node = run.snapshot.nodes.find((x) => x.id === nodeId)!;
  const isApproval = node.data.kind === 'approvazione';
  const preds = run.snapshot.edges.filter((e) => e.target === nodeId).map((e) => run.nodes[e.source]).filter(Boolean);
  const needsText = n.pendingActions?.includes('respingi') || n.pendingActions?.includes('riprendi');
  const act = async (a: HumanAction) => {
    if (a === 'annulla' && !confirm(t('run.confirmCancelShort'))) return;
    if (a === 'respingi' && !fb.trim()) { toast(t('run.intervention.needComment'), 'bad'); return; }
    setBusy(true);
    try { await api.action(run.id, nodeId, a, fb); setFb(''); } catch (e) { toast((e as Error).message, 'bad'); } finally { setBusy(false); }
  };
  const primary = n.pendingActions!.filter((a) => a !== 'annulla');
  const reason = tm(n.pendingMsg, n.pendingReason);
  return (
    <div className={`card intervention ${isApproval ? '' : 'tone-bad'}`}>
      <div className="card-head">
        <KindTile kind={node.data.kind} />
        <div className="grow">
          <div className="card-title">{label}</div>
          <div className="card-sub">{isApproval ? t('run.intervention.awaitingApproval') : statusLabel(n.status)}</div>
        </div>
      </div>
      {reason && <p className="reason">{reason}</p>}
      {isApproval && preds.map((p) => {
        if (p.service) return <ServiceCard key={p.nodeId} run={run} nodeId={p.nodeId} embedded />;
        const pn = run.snapshot.nodes.find((x) => x.id === p.nodeId)!;
        const last = p.attempts.at(-1);
        return (
          <details key={p.nodeId} className="pred" open={preds.length <= 2}>
            <summary>
              <KindTile kind={pn.data.kind} size="sm" /><strong>{pn.data.label}</strong>
              {last?.declared && <span className={`pill ${last.declared.esito === 'ok' ? 'tone-good' : 'tone-bad'}`}>{t('run.intervention.outcome', { esito: last.declared.esito })}</span>}
            </summary>
            <p className="pre">{p.output ?? t('run.intervention.noOutput')}</p>
          </details>
        );
      })}
      {readOnly && <p className="muted small">{t('run.intervention.resumeToAct')}</p>}
      {needsText && !readOnly && (
        <textarea rows={3} placeholder={isApproval ? t('run.intervention.commentPlaceholder') : t('run.intervention.messagePlaceholder')} value={fb} onChange={(e) => setFb(e.target.value)} />
      )}
      {!readOnly && <div className="actions">
        {primary.map((a) => {
          const m = ACTION[a];
          const Icon = m.icon;
          return <button key={a} disabled={busy} className={`btn ${m.cls ?? 'ghost'}`} title={m.help ? t(`actions.${a}.help`) : undefined} onClick={() => act(a)}><Icon />{t(`actions.${a}.label`)}</button>;
        })}
        <span className="grow" />
        {n.pendingActions!.includes('annulla') && <button className="btn ghost danger" disabled={busy} onClick={() => act('annulla')}><X />{t('actions.annulla.label')}</button>}
      </div>}
    </div>
  );
}

/** Server locale avviato da Regia: link, stato, azioni e ultime righe di output. */
function ServiceCard({ run, nodeId, embedded = false }: { run: Run; nodeId: string; embedded?: boolean }) {
  const { t } = useI18n();
  const svc = run.nodes[nodeId].service!;
  const label = run.snapshot.nodes.find((x) => x.id === nodeId)?.data.label ?? nodeId;
  const live = run.status === 'in_corso' || run.status === 'attesa_intervento';
  const up = svc.status === 'attivo' || svc.status === 'simulato';
  const done = svc.status === 'completato';
  const act = async (a: 'ferma' | 'riavvia') => {
    try { await api.serviceAction(run.id, nodeId, a); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  return (
    <div className={`service ${embedded ? 'embedded' : 'card'} ${up ? 'up' : ''}`}>
      <div className="service-head">
        <KindTile kind="server" size="sm" /><strong>{label}</strong>
        <span className={`pill ${up || done ? 'tone-good' : svc.status === 'avvio' ? 'tone-active' : 'tone-idle'}`}><span className={`dot ${up ? 'on' : ''}`} />{serviceLabel(svc.status)}</span>
      </div>
      {up && svc.url && (
        <a className="service-link" href={svc.url} target="_blank" rel="noreferrer"><Globe />{svc.url}<ExternalLink /></a>
      )}
      {up && !svc.url && !svc.external && <p className="muted small">{t('run.service.openOnDevice')}</p>}
      {svc.external && <p className="muted small">{t('run.service.external')}</p>}
      {svc.command && <div className="service-meta mono">{svc.command}{svc.node ? ` · Node ${svc.node}` : ''}{svc.pid && !done ? ` · PID ${svc.pid}` : ''}</div>}
      <div className="actions">
        {live && up && !svc.external && <button className="btn sm ghost" onClick={() => act('ferma')}><Square />{t('run.service.stop')}</button>}
        {live && svc.status !== 'avvio' && <button className="btn sm ghost" onClick={() => act('riavvia')}><RotateCcw />{up ? t('run.service.restart') : t('run.service.startAgain')}</button>}
        {!live && !svc.external && !done && <span className="muted small">{t('run.service.stoppedAtEnd')}</span>}
      </div>
      {svc.log.length > 0 && (
        <details className="logbox">
          <summary>{t('run.service.output')} <span className="count">{svc.log.length}</span></summary>
          <pre>{svc.log.slice(-80).join('\n')}</pre>
        </details>
      )}
    </div>
  );
}

function EventsTab({ run, label, selectedNode, onSelectNode }: { run: Run; label: (id?: string) => string; selectedNode: string | null; onSelectNode: (id: string | null) => void }) {
  const { t, tm, locale } = useI18n();
  const [hidden, setHidden] = useState<Set<EventKind>>(new Set(['esito_strumento', 'consumi']));
  const [showSub, setShowSub] = useState(true);
  const [follow, setFollow] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const events = useMemo(() => run.events.filter((e) => !hidden.has(e.kind) && (!selectedNode || e.nodeId === selectedNode) && (showSub || !e.subagent)), [run.events, hidden, selectedNode, showSub]);
  useEffect(() => { if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [events.length, follow]);
  const kinds = Object.keys(EVENT) as EventKind[];
  const toggle = (k: EventKind) => { const h = new Set(hidden); if (h.has(k)) h.delete(k); else h.add(k); setHidden(h); };
  return (
    <div className="events-wrap">
      <div className="filters">
        {selectedNode && <button className="chip on" onClick={() => onSelectNode(null)}>{t('events.only', { label: label(selectedNode) })}<X /></button>}
        {kinds.map((k) => { const Icon = EVENT[k].icon; return <button key={k} className={`chip ${hidden.has(k) ? '' : 'on'}`} aria-pressed={!hidden.has(k)} onClick={() => toggle(k)}><Icon />{t(`events.kind.${k}`)}</button>; })}
        <span className="grow" />
        <label className="check small"><input type="checkbox" checked={showSub} onChange={(e) => setShowSub(e.target.checked)} />{t('events.subagents')}</label>
        <label className="check small"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />{t('events.follow')}</label>
      </div>
      <div className="events" ref={ref}>
        {events.length === 0 && <EmptyState icon={<ListTree />} title={t('events.emptyTitle')}>{t('events.emptyText')}</EmptyState>}
        {events.map((e) => {
          const Icon = EVENT[e.kind].icon;
          return (
            <div key={e.seq} className={`ev ev-${e.kind}`}>
              <span className="ev-icon"><Icon /></span>
              <div className="ev-main">
                <div className="ev-meta">
                  {e.nodeId && <button className="ev-node" onClick={() => onSelectNode(e.nodeId!)}>{label(e.nodeId)}</button>}
                  <span>{t(`events.kind.${e.kind}`)}{e.subagent ? ` · ${t('events.subagentTag')}` : ''}</span>
                  <span className="ev-time num">{new Date(e.ts).toLocaleTimeString(locale)}</span>
                </div>
                <div className="ev-text">{tm(e.msg, e.text)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DecisionsTab({ run, label, selectedNode, onSelectNode }: { run: Run; label: (id?: string) => string; selectedNode: string | null; onSelectNode: (id: string | null) => void }) {
  const { t, tm } = useI18n();
  const decisions = run.events.filter((e) => e.kind === 'decisione' && (!selectedNode || e.nodeId === selectedNode));
  const kindOf = (id?: string) => run.snapshot.nodes.find((n) => n.id === id)?.data.kind ?? 'personalizzata';
  return (
    <div className="stack">
      <div className="callout tone-info">
        <Info />
        <span><strong>{t('decisions.legend.declared')}</strong>{t('decisions.legend.declaredText')} <strong>{t('decisions.legend.observed')}</strong>{t('decisions.legend.observedText')} {t('decisions.legend.reasoning')}</span>
      </div>
      {selectedNode && <button className="chip on self-start" onClick={() => onSelectNode(null)}>{t('events.only', { label: label(selectedNode) })}<X /></button>}
      {decisions.length === 0 && <EmptyState icon={<Lightbulb />} title={t('decisions.emptyTitle')}>{selectedNode ? t('decisions.emptyPhase') : t('decisions.emptyText')}</EmptyState>}
      <ol className="decisions">
        {decisions.map((d) => (
          <li key={d.seq} className="decision">
            <KindTile kind={kindOf(d.nodeId)} size="sm" />
            <div>
              <div className="decision-meta"><strong>{label(d.nodeId)}</strong><span className={`tag ${d.source === 'dichiarata' ? 'tag-accent' : ''}`}>{d.source ? t(`decisions.source.${d.source}`) : ''}</span></div>
              <p>{tm(d.msg, d.text)}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function InsightsTab({ run, label, onSelectNode }: { run: Run; label: (id?: string) => string; onSelectNode: (id: string | null) => void }) {
  const { t, tm } = useI18n();
  const [items, setItems] = useState<Insight[] | null>(null);
  const done = !['in_corso', 'attesa_intervento'].includes(run.status);
  useEffect(() => { api.insights(run.id).then(setItems).catch(() => setItems([])); }, [run.id, done, run.totals.costUsd]);
  if (!items) return <p className="muted">{t('insights_ui.computing')}</p>;
  const SEV: Record<Insight['severity'], { icon: LucideIcon; label: string; tone: string }> = {
    alta: { icon: TriangleAlert, label: t('insights_ui.severity.alta'), tone: 'bad' }, media: { icon: CircleAlert, label: t('insights_ui.severity.media'), tone: 'warn' }, info: { icon: Info, label: t('insights_ui.severity.info'), tone: 'info' },
  };
  return (
    <div className="stack">
      <p className="lead small">{run.mode === 'prova' ? t('insights_ui.leadSimulated') : t('insights_ui.lead')} {t('insights_ui.leadCompare')} <strong>{t('insights_ui.compare')}</strong>.</p>
      {!done && <p className="muted small">{t('insights_ui.live')}</p>}
      {items.length === 0 && <EmptyState icon={<CircleCheck />} title={t('insights_ui.emptyTitle')}>{t('insights_ui.emptyText')}</EmptyState>}
      {items.map((i) => {
        const s = SEV[i.severity];
        const Icon = s.icon;
        return (
          <article key={i.id} className={`insight tone-${s.tone}`}>
            <header><Icon /><h5>{tm(i.title)}</h5></header>
            <div className="insight-meta"><span className={`tag tone-${s.tone}`}>{s.label}</span>{i.nodeId && <button className="link" onClick={() => onSelectNode(i.nodeId!)}>{label(i.nodeId)}</button>}</div>
            <dl>
              <dt>{t('insights_ui.evidence')}</dt><dd>{tm(i.evidence)}</dd>
              <dt>{t('insights_ui.suggestion')}</dt><dd>{tm(i.suggestion)}</dd>
              <dt>{t('insights_ui.tradeoff')}</dt><dd>{tm(i.tradeoff)}</dd>
            </dl>
          </article>
        );
      })}
    </div>
  );
}

/** Resoconto in Markdown dell'esecuzione, da copiare o scaricare. */
function ReportDialog({ run, onClose }: { run: Run; onClose: () => void }) {
  const { t, locale } = useI18n();
  const text = useMemo(() => runReport(run, t, locale), [run, t, locale]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); toast(t('report.copied'), 'good'); } catch { toast(t('report.copyFailed'), 'bad'); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `regia-${run.id}.md` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Modal title={t('report.dialogTitle')} icon={<FileText />} onClose={onClose} wide
      footer={<>
        <span className="grow" />
        <button className="btn" onClick={copy}><Copy />{t('report.copy')}</button>
        <button className="btn primary" onClick={download}><Download />{t('report.download')}</button>
      </>}>
      <textarea className="report-text" readOnly value={text} aria-label={t('report.dialogTitle')} />
    </Modal>
  );
}
