import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import {
  Activity, ChevronDown, CircleAlert, CircleCheck, FilePlus2, FlaskConical, GitCompare, KeyRound, PenLine, Play, Rocket, Save, ScrollText, ShieldAlert,
  Trash2, TriangleAlert, Workflow as WorkflowIcon,
} from 'lucide-react';
import {
  PHASE_PRESETS, PHASE_SNIPPETS, WRITE_TOOLS, isAgentKind, type EnvInfo, type PhaseConfig, type PhaseKind, type Run, type RunSummary, type ValidationIssue, type Workflow,
} from '../../shared/types.ts';
import { NODE_H, looksHorizontal, withLayout } from '../../shared/layout.ts';
import { api, fmtTime, fmtUsd } from './api.ts';
import { Canvas } from './components/Canvas.tsx';
import { Compare } from './components/Compare.tsx';
import { PhaseInspector, WorkflowSettingsForm } from './components/Inspector.tsx';
import { RunPanel } from './components/RunPanel.tsx';
import { ContinueDialog, FolderStatus, NewWorkflowDialog, RulesDialog } from './components/Setup.tsx';
import { KIND_META, KindTile, Modal, Toasts, toast } from './ui.tsx';

type View = 'editor' | 'run' | 'compare';

const PALETTE: { title: string; kinds: PhaseKind[] }[] = [
  { title: 'Agenti', kinds: ['analisi', 'implementazione', 'test', 'revisione', 'personalizzata'] },
  { title: 'Controllo', kinds: ['approvazione', 'server'] },
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

export function App() {
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
  const issuesPop = usePopover();

  const dirty = wf ? JSON.stringify(wf) !== saved : false;

  const select = useCallback((w: Workflow | null) => {
    setSaved(w ? JSON.stringify(w) : '');
    // I diagrammi salvati da sinistra a destra vengono ridisposti dall'alto verso il basso (da salvare).
    if (w && looksHorizontal(w.nodes, w.edges)) {
      setWf({ ...w, nodes: withLayout(w.nodes, w.edges) });
      toast('Diagramma ridisposto dall\'alto verso il basso: salva per mantenere la nuova disposizione.');
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
    const t = setTimeout(() => api.validate(wf, 'prova').then(setIssues).catch(() => undefined), 300);
    return () => clearTimeout(t);
  }, [wf]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); void save(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const confirmDiscard = () => !dirty || confirm('Ci sono modifiche non salvate. Continuare e perderle?');

  async function save() {
    if (!wf || !dirty) return;
    try {
      const s = await api.saveWorkflow(wf);
      setWf(s); setSaved(JSON.stringify(s));
      setWorkflows((l) => l.map((x) => (x.id === s.id ? s : x)));
      toast('Workflow salvato', 'good');
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
      toast(mode === 'prova' ? 'Esecuzione di prova avviata' : 'Esecuzione reale avviata', 'good');
    } catch (e) {
      const err = e as Error & { issues?: ValidationIssue[] };
      if (err.issues) setIssues(err.issues);
      toast(err.message, 'bad');
    } finally { setBusy(false); }
  }

  function addPhase(kind: PhaseKind, data?: PhaseConfig, at?: { x: number; y: number }) {
    if (!wf) return;
    const preset = data ?? PHASE_PRESETS[kind];
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
    else { const s = PHASE_SNIPPETS.find((x) => x.id === key); if (s) addPhase(s.data.kind, s.data, at); }
  }

  async function onCreated(id: string) {
    setNewDialog(false);
    setView('editor');
    setRun(null);
    await loadWorkflows(id);
    toast('Workflow creato. Controlla le fasi, poi prova con "Prova".', 'good');
  }

  async function removeWorkflow() {
    wfMenu.setOpen(false);
    if (!wf || !confirm(`Eliminare il workflow "${wf.name}"? Le esecuzioni salvate restano.`)) return;
    await api.deleteWorkflow(wf.id);
    setRun(null);
    setView('editor');
    await loadWorkflows();
  }

  function switchWorkflow(w: Workflow) {
    wfMenu.setOpen(false);
    if (w.id === wf?.id || !confirmDiscard()) return;
    select(w); setView('editor'); setRun(null);
  }

  const shownWf = view === 'run' && run ? run.snapshot : wf;
  const selNode = wf?.nodes.find((n) => n.id === selected);
  const errCount = issues.filter((i) => i.level === 'errore').length;
  const warnCount = issues.length - errCount;
  const sortedIssues = useMemo(() => [...issues].sort((a, b) => (a.level === b.level ? 0 : a.level === 'errore' ? -1 : 1)), [issues]);
  const liveRun = run && (run.status === 'in_corso' || run.status === 'attesa_intervento') && run.workflowId === wf?.id;

  if (!loaded) return <div className="boot">{loadError ? `Errore: ${loadError}` : <span className="brand-mark"><WorkflowIcon /></span>}</div>;

  const brand = <div className="brand"><span className="brand-mark" aria-hidden><WorkflowIcon /></span><span>Regia</span></div>;

  if (!wf || !shownWf) {
    return (
      <div className="app">
        <header className="topbar simple">{brand}<span className="grow" /><button className="btn ghost" onClick={() => setRulesDialog(true)}><ScrollText />Regole</button></header>
        <NewWorkflowDialog inline onCreated={onCreated} />
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
              <span className="wf-name">{wf.name || 'Senza nome'}</span><ChevronDown />
            </button>
            {wfMenu.open && (
              <div className="popover menu" role="menu">
                <div className="menu-label">Workflow</div>
                {workflows.map((w) => (
                  <button key={w.id} role="menuitem" className={`menu-item ${w.id === wf.id ? 'on' : ''}`} onClick={() => switchWorkflow(w)}>
                    <span className="menu-main">{w.name}</span><span className="menu-sub">{w.nodes.length} fasi · {fmtTime(w.updatedAt)}</span>
                  </button>
                ))}
                <div className="menu-sep" />
                <button role="menuitem" className="menu-item" onClick={() => { wfMenu.setOpen(false); if (confirmDiscard()) setNewDialog(true); }}><FilePlus2 />Nuovo workflow…</button>
                <button role="menuitem" className="menu-item danger" onClick={removeWorkflow}><Trash2 />Elimina questo workflow</button>
              </div>
            )}
          </div>
          {dirty
            ? <button className="btn sm soft" onClick={save} title="Salva (Ctrl+S)"><Save />Salva</button>
            : <span className="save-state"><CircleCheck />Salvato</span>}
        </div>

        <nav className="seg" aria-label="Vista">
          <button className={view === 'editor' ? 'on' : ''} onClick={() => setView('editor')}><PenLine />Editor</button>
          <button className={view === 'run' ? 'on' : ''} disabled={!run && runs.length === 0}
            title={runs.length || run ? undefined : 'Nessuna esecuzione per questo workflow'}
            onClick={() => (run && run.workflowId === wf.id ? setView('run') : runs[0] && openRun(runs[0].id))}>
            <Activity />Esecuzione{liveRun && <span className="dot pulse live-dot" />}
          </button>
          <button className={view === 'compare' ? 'on' : ''} disabled={runs.length < 2} title={runs.length < 2 ? 'Servono almeno due esecuzioni' : undefined} onClick={() => setView('compare')}><GitCompare />Confronta</button>
        </nav>

        <div className="tb-right">
          <div className="popover-wrap" ref={issuesPop.ref}>
            <button className={`validity ${errCount ? 'tone-bad' : warnCount ? 'tone-warn' : 'tone-good'}`} onClick={() => issuesPop.setOpen(!issuesPop.open)} aria-expanded={issuesPop.open}>
              {errCount ? <CircleAlert /> : warnCount ? <TriangleAlert /> : <CircleCheck />}
              {errCount ? `${errCount} ${errCount === 1 ? 'errore' : 'errori'}` : 'Valido'}{warnCount ? <span className="muted">· {warnCount} avvisi</span> : null}
            </button>
            {issuesPop.open && (
              <div className="popover issues-pop">
                <div className="menu-label">Controllo del workflow</div>
                {sortedIssues.length === 0 && <p className="muted small pad">Nessun problema: puoi avviare.</p>}
                {sortedIssues.map((i, k) => (
                  <button key={k} className={`issue-row tone-${i.level === 'errore' ? 'bad' : 'warn'}`} onClick={() => { if (i.nodeId) { setView('editor'); setSelected(i.nodeId); } issuesPop.setOpen(false); }}>
                    {i.level === 'errore' ? <CircleAlert /> : <TriangleAlert />}<span>{i.message}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="icon-btn" onClick={() => setRulesDialog(true)} title="Regole generali" aria-label="Regole generali"><ScrollText /></button>
          <button className="btn" disabled={busy || errCount > 0} onClick={() => start('prova')} title="Agenti simulati: nessuna chiamata, nessun costo"><FlaskConical />Prova</button>
          <button className="btn primary" disabled={busy || errCount > 0 || !env?.realRunsEnabled} onClick={() => { api.env(true).then(setEnv); setRealDialog(true); }}><Rocket />Esegui</button>
        </div>
      </header>

      <div className={`main view-${view}`}>
        {view === 'editor' && (
          <aside className="palette" aria-label="Fasi disponibili">
            {PALETTE.map((g) => (
              <div key={g.title} className="pal-group">
                <div className="pal-title">{g.title}</div>
                {g.kinds.map((k) => (
                  <button key={k} className="pal-item" draggable onDragStart={(e) => { e.dataTransfer.setData('application/regia-phase', `kind:${k}`); e.dataTransfer.effectAllowed = 'copy'; }}
                    onClick={() => addPhase(k)} title="Trascina sul diagramma o fai clic per aggiungere">
                    <KindTile kind={k} /><span className="pal-text"><span>{KIND_META[k].label}</span><small>{KIND_META[k].hint}</small></span>
                  </button>
                ))}
              </div>
            ))}
            <div className="pal-group">
              <div className="pal-title">Pronte all'uso</div>
              {PHASE_SNIPPETS.map((s) => (
                <button key={s.id} className="pal-item" draggable onDragStart={(e) => { e.dataTransfer.setData('application/regia-phase', `snippet:${s.id}`); e.dataTransfer.effectAllowed = 'copy'; }}
                  onClick={() => addPhase(s.data.kind, s.data)} title={s.hint}>
                  <span className="kind-tile kind-publish" aria-hidden><Rocket /></span><span className="pal-text"><span>{s.label}</span><small>Commit, push e pubblicazioni</small></span>
                </button>
              ))}
            </div>
            <p className="pal-hint">Trascina una fase sul diagramma, oppure selezionane una e fai clic qui: la nuova viene collegata dopo.</p>
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
              ? <PhaseInspector key={selNode.id} cfg={selNode.data} issues={issues.filter((i) => i.nodeId === selNode.id)}
                  onChange={(c) => setWf({ ...wf, nodes: wf.nodes.map((n) => (n.id === selNode.id ? { ...n, data: c } : n)) })}
                  onDelete={() => { setWf({ ...wf, nodes: wf.nodes.filter((n) => n.id !== selNode.id), edges: wf.edges.filter((e) => e.source !== selNode.id && e.target !== selNode.id) }); setSelected(null); }} />
              : <WorkflowSettingsForm wf={wf} onChange={setWf} onShowRules={() => setRulesDialog(true)} />}
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
      {newDialog && <NewWorkflowDialog onCancel={() => setNewDialog(false)} onCreated={onCreated} />}
      {rulesDialog && <RulesDialog projectDir={wf.settings.projectDir} onClose={() => setRulesDialog(false)} />}
      {realDialog && <RealRunDialog env={env} wf={wf} busy={busy} onCancel={() => setRealDialog(false)} onConfirm={() => start('reale')} />}
      <Toasts />
    </div>
  );
}

function RealRunDialog({ env, wf, busy, onCancel, onConfirm }: { env: EnvInfo | null; wf: Workflow; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const [ok, setOk] = useState(false);
  const [warn, setWarn] = useState<ValidationIssue[]>([]);
  useEffect(() => { api.validate(wf, 'reale').then((i) => setWarn(i)); }, [wf]);
  const a = env?.auth;
  const agents = wf.nodes.filter((n) => isAgentKind(n.data.kind));
  const servers = wf.nodes.filter((n) => n.data.kind === 'server');
  const writers = agents.filter((n) => n.data.allowedTools.some((t) => WRITE_TOOLS.includes(t)));
  const subscription = a?.authMethod === 'claude.ai' && !a.apiKeyEnv;
  const models = [...new Set(agents.map((n) => n.data.model || 'predefinito'))];
  const canStart = ok && !busy && a && (a.loggedIn || a.apiKeyEnv) && !warn.some((i) => i.level === 'errore');
  return (
    <Modal title="Esecuzione reale" icon={<span className="kind-tile kind-publish"><Rocket /></span>} onClose={onCancel} wide
      footer={<>
        <label className="check grow"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />Ho letto il riepilogo e voglio avviare</label>
        <button className="btn ghost" onClick={onCancel}>Annulla</button>
        <button className="btn primary" disabled={!canStart} onClick={onConfirm}><Play />Avvia</button>
      </>}>
      <div className="summary-grid">
        <div className="summary-card">
          <div className="summary-head"><KeyRound />Autenticazione</div>
          {!env ? <p className="muted">Verifica…</p> : (
            <dl className="kv">
              <dt>Accesso</dt><dd>{a?.apiKeyEnv ? 'Chiave API (ANTHROPIC_API_KEY)' : a?.loggedIn ? `Login ${a.authMethod}${a.subscriptionType ? `, piano ${a.subscriptionType}` : ''}` : <span className="tone-bad">nessuno</span>}</dd>
              <dt>Claude Code</dt><dd>{env.claudeCodeVersion ?? 'eseguibile del SDK'}</dd>
              <dt>Agent SDK</dt><dd>{env.sdkVersion}</dd>
            </dl>
          )}
        </div>
        <div className="summary-card">
          <div className="summary-head"><WorkflowIcon />Cosa succederà</div>
          <dl className="kv">
            <dt>Fasi con agenti</dt><dd>{agents.length} · {models.join(', ')}</dd>
            <dt>Spesa massima</dt><dd>{wf.settings.runBudgetUsd ? fmtUsd(wf.settings.runBudgetUsd, 2) : <span className="tone-warn">nessun limite</span>}</dd>
            <dt>Regole generali</dt><dd>{wf.settings.applyGeneralRules === false ? 'non applicate' : 'applicate a ogni fase'}</dd>
          </dl>
        </div>
      </div>

      <div className="field-label">Cartella di lavoro</div>
      <code className="path">{wf.settings.projectDir}</code>
      <FolderStatus path={wf.settings.projectDir} />

      {(writers.length > 0 || servers.length > 0) && (
        <div className="callout tone-warn">
          <ShieldAlert />
          <div>
            {writers.length > 0 && <p><strong>Possono modificare file o eseguire comandi:</strong> {writers.map((n) => n.data.label).join(', ')}. Gli strumenti non concessi vengono negati.</p>}
            {servers.length > 0 && <p><strong>Comandi locali avviati da Regia:</strong> {servers.map((n) => <code key={n.id}>{n.data.command}</code>)}</p>}
          </div>
        </div>
      )}
      {subscription && (
        <div className="callout tone-info">
          <KeyRound />
          <p>Il consumo rientra nei limiti del tuo piano {a?.subscriptionType} (e nei crediti extra solo se attivi): i dollari mostrati sono un equivalente a prezzi di listino calcolato dal SDK. La documentazione del SDK chiede ai prodotti di terze parti di usare chiavi API: per uso personale e locale il login funziona, ma verifica le regole della tua organizzazione.</p>
        </div>
      )}
      {a?.apiKeyEnv && <div className="callout tone-info"><KeyRound /><p>Con la chiave API il consumo è fatturato a token: il costo effettivo si verifica nella Console.</p></div>}
      {warn.map((i, k) => <div key={k} className={`callout ${i.level === 'errore' ? 'tone-bad' : 'tone-warn'}`}>{i.level === 'errore' ? <CircleAlert /> : <TriangleAlert />}<span>{i.message}</span></div>)}
    </Modal>
  );
}
