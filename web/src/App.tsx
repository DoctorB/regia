import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { Activity, TabletSmartphone, Check, ChevronDown, CircleAlert, CircleArrowUp, CircleCheck, FilePlus2, FlaskConical, GitCompare, KeyRound, Languages, PenLine, Play, Rocket, Save, ScrollText, ShieldAlert, LayoutList, Monitor, Moon, Search, Sun, TriangleAlert, Workflow as WorkflowIcon, Server, Smartphone, Globe } from 'lucide-react';
import {
  WRITE_TOOLS, isAgentKind, type EnvInfo, type PhaseConfig, type PhaseKind, type Run, type RunSummary, type ValidationIssue, type VersionInfo, type Workflow,
} from '../../shared/types.ts';
import { NODE_H, looksHorizontal, withLayout } from '../../shared/layout.ts';
import { phasePreset, phaseSnippets } from '../../shared/presets.ts';
import { api, fmtTime, fmtUsd } from './api.ts';
import { useI18n } from './i18n.tsx';
import { Canvas } from './components/Canvas.tsx';
import { Compare } from './components/Compare.tsx';
import { PhaseInspector, WorkflowSettingsForm } from './components/Inspector.tsx';
import { RunPanel } from './components/RunPanel.tsx';
import { WorkflowManager, groupNames, grouped } from './components/WorkflowManager.tsx';
import { ContinueDialog, FolderStatus, NewWorkflowDialog, RulesDialog } from './components/Setup.tsx';
import { KindTile, Modal, Toasts, applyTheme, kindHint, kindLabel, readTheme, toast, type ThemeChoice } from './ui.tsx';

type View = 'editor' | 'run' | 'compare';

const PALETTE: { titleKey: string; kinds: PhaseKind[] }[] = [
  { titleKey: 'palette.agents', kinds: ['analisi', 'implementazione', 'test', 'revisione', 'personalizzata'] },
  { titleKey: 'palette.control', kinds: ['approvazione', 'server'] },
];

/** Popover semplice che si chiude con un clic fuori o Esc. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', click);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', click); document.removeEventListener('keydown', key); };
  }, [open]);
  return { open, setOpen, ref };
}

/** Scelta della lingua dell'interfaccia. */
function ThemeSwitch() {
  const { t } = useI18n();
  const pop = usePopover();
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  const opts: [ThemeChoice, typeof Sun][] = [['system', Monitor], ['light', Sun], ['dark', Moon]];
  const Current = opts.find(([c]) => c === choice)![1];
  return (
    <div className="popover-wrap" ref={pop.ref}>
      <button className="icon-btn" onClick={() => pop.setOpen(!pop.open)} aria-expanded={pop.open} aria-haspopup="menu" title={t('theme.title')} aria-label={t('theme.title')}>
        <Current />
      </button>
      {pop.open && (
        <div className="popover menu lang-pop" role="menu">
          <div className="menu-label">{t('theme.title')}</div>
          {opts.map(([c, Icon]) => (
            <button key={c} role="menuitemradio" aria-checked={c === choice} className={`menu-item ${c === choice ? 'on' : ''}`}
              onClick={() => { pop.setOpen(false); setChoice(c); applyTheme(c); }}>
              <Icon /><span className="menu-main">{t(`theme.${c}`)}</span>{c === choice && <Check />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Versione in uso accanto al nome; se sul repository ce n'è una più recente, la segnala con le istruzioni per aggiornare. */
function VersionBadge() {
  const { t } = useI18n();
  const pop = usePopover();
  const [info, setInfo] = useState<VersionInfo | null>(null);
  useEffect(() => {
    api.version().then((v) => {
      setInfo(v);
      if (!v.updateAvailable || !v.latest) return;
      // Avviso una sola volta per ogni nuova versione; il badge resta visibile.
      try {
        if (localStorage.getItem('regia.updateNotified') === v.latest) return;
        localStorage.setItem('regia.updateNotified', v.latest);
      } catch { /* archivio non disponibile: si avvisa comunque */ }
      toast(t('version.toast', { version: v.latest }));
    }).catch(() => undefined);
  }, []);
  if (!info) return null;
  if (!info.updateAvailable) return <span className="version-label" title={t('version.current')}>v{info.current}</span>;
  return (
    <div className="popover-wrap" ref={pop.ref}>
      <button className="pill tone-active version-pill" onClick={() => pop.setOpen(!pop.open)} aria-expanded={pop.open} title={t('version.available', { version: info.latest! })}>
        <CircleArrowUp />v{info.current} → v{info.latest}
      </button>
      {pop.open && (
        <div className="popover version-pop">
          <div className="menu-label">{t('version.available', { version: info.latest! })}</div>
          <p className="small pad">{t('version.inUse', { version: info.current })}</p>
          <p className="small pad">{t('version.howTo')}</p>
          <pre className="version-cmd"><code>git pull{'\n'}npm install</code></pre>
          <p className="small pad muted">{t('version.restart')}</p>
          {info.repoUrl && <p className="small pad"><a href={`${info.repoUrl}/commits/main`} target="_blank" rel="noreferrer">{t('version.changes')}</a></p>}
        </div>
      )}
    </div>
  );
}

function LanguageSwitch() {
  const { t, lang, languages, setLang } = useI18n();
  const pop = usePopover();
  if (languages.length < 2) return null;
  return (
    <div className="popover-wrap" ref={pop.ref}>
      <button className="icon-btn" onClick={() => pop.setOpen(!pop.open)} aria-expanded={pop.open} aria-haspopup="menu" title={t('topbar.language')} aria-label={t('topbar.language')}>
        <Languages />
      </button>
      {pop.open && (
        <div className="popover menu lang-pop" role="menu">
          <div className="menu-label">{t('topbar.language')}</div>
          {languages.map((l) => (
            <button key={l.code} role="menuitemradio" aria-checked={l.code === lang} lang={l.code} className={`menu-item ${l.code === lang ? 'on' : ''}`}
              onClick={() => { pop.setOpen(false); if (l.code !== lang) setLang(l.code); }}>
              <span className="menu-main">{l.name}</span>{l.code === lang && <Check />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function App() {
  const { t, tm } = useI18n();
  const [env, setEnv] = useState<EnvInfo | null>(null);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [wf, setWf] = useState<Workflow | null>(null);
  const [saved, setSaved] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [view, setView] = useState<View>('editor');
  const [run, setRun] = useState<Run | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [realDialog, setRealDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newDialog, setNewDialog] = useState(false);
  const [rulesDialog, setRulesDialog] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [continueFrom, setContinueFrom] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const wfMenu = usePopover();
  const [wfQuery, setWfQuery] = useState('');
  const [manager, setManager] = useState(false);
  const issuesPop = usePopover();

  const dirty = wf ? JSON.stringify(wf) !== saved : false;

  const select = useCallback((w: Workflow | null) => {
    setSaved(w ? JSON.stringify(w) : '');
    // I diagrammi salvati da sinistra a destra vengono ridisposti dall'alto verso il basso (da salvare).
    if (w && looksHorizontal(w.nodes, w.edges)) {
      setWf({ ...w, nodes: withLayout(w.nodes, w.edges) });
      toast(t('toast.relayouted'));
    } else setWf(w);
    setSelected(null);
  }, []);

  const loadWorkflows = useCallback(async (selectId?: string) => {
    const list = await api.workflows();
    setWorkflows(list);
    select(list.find((w) => w.id === selectId) ?? list[0] ?? null);
    setLoaded(true);
  }, [select]);

  useEffect(() => { loadWorkflows().catch((e) => setLoadError(e.message)); api.env().then(setEnv).catch(() => undefined); }, [loadWorkflows]);
  useEffect(() => { if (wf) api.runs(wf.id).then(setRuns).catch(() => undefined); }, [wf?.id, run?.status, run?.id]);
  useEffect(() => { setIssues([]); }, [wf?.id]);
  useEffect(() => {
    if (!wf) return;
    const timer = setTimeout(() => api.validate(wf, 'prova').then(setIssues).catch(() => undefined), 300);
    return () => clearTimeout(timer);
  }, [wf]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); void save(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const confirmDiscard = () => !dirty || confirm(t('app.confirmDiscard'));

  async function save() {
    if (!wf || !dirty) return;
    try {
      const s = await api.saveWorkflow(wf);
      setWf(s); setSaved(JSON.stringify(s));
      setWorkflows((l) => l.map((x) => (x.id === s.id ? s : x)));
      toast(t('toast.saved'), 'good');
    } catch (e) { toast((e as Error).message, 'bad'); }
  }

  function openRun(id: string) {
    esRef.current?.close();
    setView('run');
    setSelected(null);
    const es = new EventSource(`/api/runs/${id}/stream`);
    esRef.current = es;
    es.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      setRun((prev) => {
        if (msg.t === 'snapshot') return msg.run;
        if (!prev || prev.id !== id) return prev;
        if (msg.t === 'event') return { ...prev, events: [...prev.events, msg.e] };
        if (msg.t === 'node') return { ...prev, nodes: { ...prev.nodes, [msg.node.nodeId]: msg.node } };
        if (msg.t === 'run') return { ...prev, ...msg.run };
        return prev;
      });
    };
    es.onerror = () => es.close();
  }
  useEffect(() => () => esRef.current?.close(), []);

  async function start(mode: 'prova' | 'reale') {
    if (!wf) return;
    setBusy(true);
    try {
      if (dirty) await save();
      const { id } = await api.startRun(wf.id, mode, mode === 'reale');
      setRealDialog(false);
      openRun(id);
      toast(mode === 'prova' ? t('toast.testStarted') : t('toast.realStarted'), 'good');
    } catch (e) {
      const err = e as Error & { issues?: ValidationIssue[] };
      if (err.issues) setIssues(err.issues);
      toast(err.message, 'bad');
    } finally { setBusy(false); }
  }

  function addPhase(kind: PhaseKind, data?: PhaseConfig, at?: { x: number; y: number }) {
    if (!wf) return;
    const preset = data ?? phasePreset(kind, t);
    const id = `${kind.slice(0, 4)}_${Math.random().toString(36).slice(2, 7)}`;
    const after = at ? undefined : wf.nodes.find((n) => n.id === selected);
    const lowest = wf.nodes.reduce<typeof wf.nodes[number] | undefined>((m, n) => (!m || n.position.y > m.position.y ? n : m), undefined);
    const anchor = after ?? lowest;
    const position = at ?? (anchor ? { x: anchor.position.x, y: anchor.position.y + NODE_H + 64 } : { x: 0, y: 0 });
    setWf({
      ...wf,
      nodes: [...wf.nodes, { id, position, data: { ...structuredClone(preset) } }],
      edges: after ? [...wf.edges, { id: `e_${id}`, source: after.id, target: id }] : wf.edges,
    });
    setSelected(id);
  }

  function onDropPhase(payload: string, at: { x: number; y: number }) {
    const [type, key] = payload.split(':');
    if (type === 'kind') addPhase(key as PhaseKind, undefined, at);
    else { const s = phaseSnippets(t).find((x) => x.id === key); if (s) addPhase(s.data.kind, s.data, at); }
  }

  async function onCreated(id: string) {
    setNewDialog(false);
    setView('editor');
    setRun(null);
    await loadWorkflows(id);
    toast(t('toast.created'), 'good');
  }

  /** Dopo una modifica dalla gestione workflow: aggiorna l'elenco senza perdere le modifiche in corso. */
  async function afterManage(deleted?: string[]) {
    const list = await api.workflows();
    setWorkflows(list);
    if (!wf) return;
    if (deleted?.includes(wf.id)) {
      setRun(null); setView('editor');
      select(list[0] ?? null);
      return;
    }
    const fresh = list.find((w) => w.id === wf.id);
    if (!fresh) return;
    if (!dirty) select(fresh);
    else {
      // Modifiche non salvate: si aggiornano solo nome e gruppo cambiati dalla gestione.
      setWf({ ...wf, name: fresh.name, group: fresh.group });
      setSaved(JSON.stringify({ ...JSON.parse(saved), name: fresh.name, group: fresh.group, updatedAt: fresh.updatedAt }));
    }
  }

  function openFromManager(id: string) {
    const w = workflows.find((x) => x.id === id);
    if (!w) return;
    if (w.id !== wf?.id) {
      if (!confirmDiscard()) return;
      select(w); setView('editor'); setRun(null);
    }
    setManager(false);
  }

  function switchWorkflow(w: Workflow) {
    wfMenu.setOpen(false);
    setWfQuery('');
    if (w.id === wf?.id || !confirmDiscard()) return;
    select(w); setView('editor'); setRun(null);
  }

  const shownWf = view === 'run' && run ? run.snapshot : wf;
  const selNode = wf?.nodes.find((n) => n.id === selected);
  const errCount = issues.filter((i) => i.level === 'errore').length;
  const warnCount = issues.length - errCount;
  const sortedIssues = useMemo(() => [...issues].sort((a, b) => (a.level === b.level ? 0 : a.level === 'errore' ? -1 : 1)), [issues]);
  const liveRun = run && (run.status === 'in_corso' || run.status === 'attesa_intervento') && run.workflowId === wf?.id;

  if (!loaded) return <div className="boot">{loadError ? t('app.loadError', { message: loadError }) : <span className="brand-mark"><WorkflowIcon /></span>}</div>;

  const brand = <div className="brand"><span className="brand-mark" aria-hidden><WorkflowIcon /></span><span>Regia</span><VersionBadge /></div>;

  if (!wf || !shownWf) {
    return (
      <div className="app">
        <header className="topbar simple">{brand}<span className="grow" /><ThemeSwitch /><LanguageSwitch /><button className="btn ghost" onClick={() => setRulesDialog(true)}><ScrollText />{t('topbar.rules')}</button></header>
        <NewWorkflowDialog inline groups={[]} onCreated={onCreated} />
        {rulesDialog && <RulesDialog onClose={() => setRulesDialog(false)} />}
        <Toasts />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="tb-left">
          {brand}
          <span className="tb-divider" />
          <div className="popover-wrap" ref={wfMenu.ref}>
            <button className="wf-switch" onClick={() => wfMenu.setOpen(!wfMenu.open)} aria-expanded={wfMenu.open} aria-haspopup="menu">
              <span className="wf-name">{wf.name || t('common.untitled')}</span><ChevronDown />
            </button>
            {wfMenu.open && (
              <div className="popover menu wf-pop" role="menu">
                <label className="search sm">
                  <Search /><input autoFocus value={wfQuery} onChange={(e) => setWfQuery(e.target.value)} placeholder={t('manage.search')} aria-label={t('manage.search')}
                    onKeyDown={(e) => { if (e.key === 'Enter') { const first = grouped(workflows, wfQuery)[0]?.[1][0]; if (first) switchWorkflow(first); } }} />
                </label>
                <div className="wf-pop-list">
                  {grouped(workflows, wfQuery).map(([g, list]) => (
                    <div key={g || '__none'}>
                      <div className="menu-label">{g || t('manage.ungrouped')}</div>
                      {list.map((w) => (
                        <button key={w.id} role="menuitem" className={`menu-item ${w.id === wf.id ? 'on' : ''}`} onClick={() => switchWorkflow(w)}>
                          <span className="menu-main">{w.name}</span><span className="menu-sub">{t('topbar.phases', { count: w.nodes.length })} · {fmtTime(w.updatedAt)}</span>
                        </button>
                      ))}
                    </div>
                  ))}
                  {grouped(workflows, wfQuery).length === 0 && <p className="muted small pad">{t('manage.noResults')}</p>}
                </div>
                <div className="menu-sep" />
                <button role="menuitem" className="menu-item" onClick={() => { wfMenu.setOpen(false); setWfQuery(''); if (confirmDiscard()) setNewDialog(true); }}><FilePlus2 />{t('topbar.newWorkflow')}</button>
                <button role="menuitem" className="menu-item" onClick={() => { wfMenu.setOpen(false); setWfQuery(''); setManager(true); }}><LayoutList />{t('manage.openManager')}</button>
              </div>
            )}
          </div>
          {dirty
            ? <button className="btn sm soft" onClick={save} title={t('topbar.saveTitle')}><Save />{t('topbar.save')}</button>
            : <span className="save-state"><CircleCheck />{t('topbar.saved')}</span>}
        </div>

        <nav className="seg" aria-label={t('topbar.view')}>
          <button className={view === 'editor' ? 'on' : ''} onClick={() => setView('editor')}><PenLine />{t('topbar.editor')}</button>
          <button className={view === 'run' ? 'on' : ''} disabled={!run && runs.length === 0}
            title={runs.length || run ? undefined : t('topbar.noRuns')}
            onClick={() => (run && run.workflowId === wf.id ? setView('run') : runs[0] && openRun(runs[0].id))}>
            <Activity />{t('topbar.run')}{liveRun && <span className="dot pulse live-dot" />}
          </button>
          <button className={view === 'compare' ? 'on' : ''} disabled={runs.length < 2} title={runs.length < 2 ? t('topbar.needTwoRuns') : undefined} onClick={() => setView('compare')}><GitCompare />{t('topbar.compare')}</button>
        </nav>

        <div className="tb-right">
          <div className="popover-wrap" ref={issuesPop.ref}>
            <button className={`validity ${errCount ? 'tone-bad' : warnCount ? 'tone-warn' : 'tone-good'}`} onClick={() => issuesPop.setOpen(!issuesPop.open)} aria-expanded={issuesPop.open}>
              {errCount ? <CircleAlert /> : warnCount ? <TriangleAlert /> : <CircleCheck />}
              {errCount ? t('topbar.errors', { count: errCount }) : t('topbar.valid')}{warnCount ? <span className="muted">· {t('topbar.warnings', { count: warnCount })}</span> : null}
            </button>
            {issuesPop.open && (
              <div className="popover issues-pop">
                <div className="menu-label">{t('topbar.checkTitle')}</div>
                {sortedIssues.length === 0 && <p className="muted small pad">{t('topbar.noIssues')}</p>}
                {sortedIssues.map((i, k) => (
                  <button key={k} className={`issue-row tone-${i.level === 'errore' ? 'bad' : 'warn'}`} onClick={() => { if (i.nodeId) { setView('editor'); setSelected(i.nodeId); } issuesPop.setOpen(false); }}>
                    {i.level === 'errore' ? <CircleAlert /> : <TriangleAlert />}<span>{tm(i.msg, i.message)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <ThemeSwitch />
          <LanguageSwitch />
          <button className="icon-btn" onClick={() => setRulesDialog(true)} title={t('topbar.rulesTitle')} aria-label={t('topbar.rulesTitle')}><ScrollText /></button>
          <button className="btn" disabled={busy || errCount > 0} onClick={() => start('prova')} title={t('topbar.testTitle')}><FlaskConical />{t('topbar.test')}</button>
          <button className="btn primary" disabled={busy || errCount > 0 || !env?.realRunsEnabled} onClick={() => { api.env(true).then(setEnv); setRealDialog(true); }}><Rocket />{t('topbar.runReal')}</button>
        </div>
      </header>

      <div className={`main view-${view}`}>
        {view === 'editor' && (
          <aside className="palette" aria-label={t('palette.label')}>
            {PALETTE.map((g) => (
              <div key={g.titleKey} className="pal-group">
                <div className="pal-title">{t(g.titleKey)}</div>
                {g.kinds.map((k) => (
                  <button key={k} className="pal-item" draggable onDragStart={(e) => { e.dataTransfer.setData('application/regia-phase', `kind:${k}`); e.dataTransfer.effectAllowed = 'copy'; }}
                    onClick={() => addPhase(k)} title={t('palette.itemTitle')}>
                    <KindTile kind={k} /><span className="pal-text"><span>{kindLabel(k)}</span><small>{kindHint(k)}</small></span>
                  </button>
                ))}
              </div>
            ))}
            <div className="pal-group">
              <div className="pal-title">{t('palette.ready')}</div>
              {phaseSnippets(t).map((s) => (
                <button key={s.id} className="pal-item" draggable onDragStart={(e) => { e.dataTransfer.setData('application/regia-phase', `snippet:${s.id}`); e.dataTransfer.effectAllowed = 'copy'; }}
                  onClick={() => addPhase(s.data.kind, s.data)} title={s.hint}>
                  {s.data.kind === 'server'
                    ? <span className="kind-tile kind-server" aria-hidden>{s.id === 'app-iis' ? <Server /> : s.id === 'app-desktop' ? <Monitor /> : s.id === 'app-mobile' ? <Smartphone /> : s.id === 'app-ios' ? <TabletSmartphone /> : <Globe />}</span>
                    : <span className="kind-tile kind-publish" aria-hidden><Rocket /></span>}
                  <span className="pal-text"><span>{s.label}</span><small>{s.data.kind === 'server' ? s.hint : t('palette.publishSub')}</small></span>
                </button>
              ))}
            </div>
            <p className="pal-hint">{t('palette.hint')}</p>
          </aside>
        )}

        {view !== 'compare' && (
          <section className="canvas">
            <ReactFlowProvider>
              <Canvas
                key={view === 'run' ? `run-${run?.id}` : `wf-${wf.id}`}
                workflow={shownWf}
                runNodes={view === 'run' ? run?.nodes : undefined}
                issues={view === 'editor' ? issues : []}
                selectedId={selected}
                editable={view === 'editor'}
                onSelect={setSelected}
                onChange={setWf}
                onDropPhase={onDropPhase}
              />
            </ReactFlowProvider>
          </section>
        )}

        {view === 'editor' && (
          <aside className="inspector">
            {selNode
              ? <PhaseInspector key={selNode.id} cfg={selNode.data} settings={wf.settings} issues={issues.filter((i) => i.nodeId === selNode.id)}
                  onChange={(c) => setWf({ ...wf, nodes: wf.nodes.map((n) => (n.id === selNode.id ? { ...n, data: c } : n)) })}
                  onDelete={() => { setWf({ ...wf, nodes: wf.nodes.filter((n) => n.id !== selNode.id), edges: wf.edges.filter((e) => e.source !== selNode.id && e.target !== selNode.id) }); setSelected(null); }} />
              : <WorkflowSettingsForm wf={wf} groups={groupNames(workflows)} onChange={setWf} onShowRules={() => setRulesDialog(true)} />}
          </aside>
        )}
        {view === 'run' && run && (
          <aside className="inspector wide">
            <RunPanel run={run} runs={runs} selectedNode={selected} onSelectNode={setSelected} onOpenRun={openRun}
              onContinue={run.workflowId === wf.id ? async () => { if (dirty) await save(); setContinueFrom(run.id); } : undefined} />
          </aside>
        )}
        {view === 'compare' && <section className="scroll-page"><Compare workflowId={wf.id} initialB={run?.workflowId === wf.id ? run.id : undefined} /></section>}
      </div>

      {continueFrom && <ContinueDialog runId={continueFrom} workflowId={wf.id} onCancel={() => setContinueFrom(null)} onStarted={(id) => { setContinueFrom(null); openRun(id); }} />}
      {newDialog && <NewWorkflowDialog groups={groupNames(workflows)} onCancel={() => setNewDialog(false)} onCreated={onCreated} />}
      {manager && <WorkflowManager workflows={workflows} currentId={wf.id} onOpen={openFromManager} onChanged={afterManage} onClose={() => setManager(false)} />}
      {rulesDialog && <RulesDialog projectDir={wf.settings.projectDir} onClose={() => setRulesDialog(false)} />}
      {realDialog && <RealRunDialog env={env} wf={wf} busy={busy} onCancel={() => setRealDialog(false)} onConfirm={() => start('reale')} />}
      <Toasts />
    </div>
  );
}

function RealRunDialog({ env, wf, busy, onCancel, onConfirm }: { env: EnvInfo | null; wf: Workflow; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const [ok, setOk] = useState(false);
  const { t, tm } = useI18n();
  const [warn, setWarn] = useState<ValidationIssue[]>([]);
  useEffect(() => { api.validate(wf, 'reale').then((i) => setWarn(i)); }, [wf]);
  const a = env?.auth;
  const agents = wf.nodes.filter((n) => isAgentKind(n.data.kind));
  const servers = wf.nodes.filter((n) => n.data.kind === 'server');
  const writers = agents.filter((n) => n.data.allowedTools.some((t) => WRITE_TOOLS.includes(t)));
  const subscription = a?.authMethod === 'claude.ai' && !a.apiKeyEnv;
  const models = [...new Set(agents.map((n) => n.data.model || t('common.defaultModel')))];
  const withSkills = agents.filter((n) => n.data.skills === 'all' || (n.data.skills?.length ?? 0) > 0)
    .map((n) => `${n.data.label} (${n.data.skills === 'all' ? t('realRun.skillsAll') : (n.data.skills as string[]).map((id) => id.replace(/^(progetto|personale):/, '')).join(', ')})`);
  const canStart = ok && !busy && a && (a.loggedIn || a.apiKeyEnv) && !warn.some((i) => i.level === 'errore');
  return (
    <Modal title={t('realRun.title')} icon={<span className="kind-tile kind-publish"><Rocket /></span>} onClose={onCancel} wide
      footer={<>
        <label className="check grow"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />{t('realRun.confirm')}</label>
        <button className="btn ghost" onClick={onCancel}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={!canStart} onClick={onConfirm}><Play />{t('common.start')}</button>
      </>}>
      <div className="summary-grid">
        <div className="summary-card">
          <div className="summary-head"><KeyRound />{t('realRun.auth')}</div>
          {!env ? <p className="muted">{t('realRun.checking')}</p> : (
            <dl className="kv">
              <dt>{t('realRun.access')}</dt><dd>{a?.apiKeyEnv ? t('realRun.apiKey') : a?.loggedIn ? `${t('realRun.login', { method: a.authMethod })}${a.subscriptionType ? t('realRun.plan', { plan: a.subscriptionType }) : ''}` : <span className="tone-bad">{t('realRun.none')}</span>}</dd>
              <dt>Claude Code</dt><dd>{env.claudeCodeVersion ?? t('realRun.sdkExecutable')}</dd>
              <dt>Agent SDK</dt><dd>{env.sdkVersion}</dd>
            </dl>
          )}
        </div>
        <div className="summary-card">
          <div className="summary-head"><WorkflowIcon />{t('realRun.whatHappens')}</div>
          <dl className="kv">
            <dt>{t('realRun.agentPhases')}</dt><dd>{agents.length} · {models.join(', ')}</dd>
            <dt>{t('realRun.maxSpend')}</dt><dd>{wf.settings.runBudgetUsd ? fmtUsd(wf.settings.runBudgetUsd, 2) : <span className="tone-warn">{t('realRun.noLimit')}</span>}</dd>
            <dt>{t('realRun.skills')}</dt><dd>{withSkills.length ? withSkills.join('; ') : t('realRun.noSkills')}</dd>
            <dt>{t('realRun.generalRules')}</dt><dd>{wf.settings.applyGeneralRules === false ? t('realRun.rulesOff') : t('realRun.rulesOn')}</dd>
          </dl>
        </div>
      </div>

      <div className="field-label">{t('realRun.workdir')}</div>
      <code className="path">{wf.settings.projectDir}</code>
      <FolderStatus path={wf.settings.projectDir} />

      {(writers.length > 0 || servers.length > 0) && (
        <div className="callout tone-warn">
          <ShieldAlert />
          <div>
            {writers.length > 0 && <p><strong>{t('realRun.writersTitle')}</strong> {t('realRun.writersText', { list: writers.map((n) => n.data.label).join(', ') })}</p>}
            {servers.length > 0 && <p><strong>{t('realRun.serversTitle')}</strong> {servers.map((n) => <code key={n.id}>{n.data.command?.trim() || n.data.url}</code>)}</p>}
          </div>
        </div>
      )}
      {subscription && (
        <div className="callout tone-info">
          <KeyRound />
          <p>{t('realRun.subscription', { plan: a?.subscriptionType })}</p>
        </div>
      )}
      {a?.apiKeyEnv && <div className="callout tone-info"><KeyRound /><p>{t('realRun.apiKeyNote')}</p></div>}
      {warn.map((i, k) => <div key={k} className={`callout ${i.level === 'errore' ? 'tone-bad' : 'tone-warn'}`}>{i.level === 'errore' ? <CircleAlert /> : <TriangleAlert />}<span>{tm(i.msg, i.message)}</span></div>)}
    </Modal>
  );
}
