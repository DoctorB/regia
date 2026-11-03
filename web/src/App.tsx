import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { PHASE_PRESETS, PHASE_SNIPPETS, WRITE_TOOLS, isAgentKind, type PhaseConfig, type EnvInfo, type PhaseKind, type Run, type RunSummary, type ValidationIssue, type Workflow } from '../../shared/types.ts';
import { api, fmtTime, fmtUsd } from './api.ts';
import { Canvas, KIND_LABEL } from './components/Canvas.tsx';
import { Compare } from './components/Compare.tsx';
import { PhaseInspector, WorkflowSettingsForm } from './components/Inspector.tsx';
import { RunPanel } from './components/RunPanel.tsx';
import { ContinueDialog, FolderStatus, NewWorkflowDialog, RulesDialog } from './components/Setup.tsx';

type View = 'editor' | 'run' | 'compare';

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
  const [error, setError] = useState('');
  const [realDialog, setRealDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newDialog, setNewDialog] = useState(false);
  const [rulesDialog, setRulesDialog] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [continueFrom, setContinueFrom] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const dirty = wf ? JSON.stringify(wf) !== saved : false;

  const loadWorkflows = useCallback(async (selectId?: string) => {
    const list = await api.workflows();
    setWorkflows(list);
    const pick = list.find((w) => w.id === selectId) ?? list[0] ?? null;
    setWf(pick);
    setSaved(pick ? JSON.stringify(pick) : '');
    setSelected(null);
    setLoaded(true);
  }, []);

  useEffect(() => { loadWorkflows().catch((e) => setError(e.message)); api.env().then(setEnv).catch(() => undefined); }, [loadWorkflows]);
  useEffect(() => { if (wf) api.runs(wf.id).then(setRuns).catch(() => undefined); }, [wf?.id, run?.status]);

  useEffect(() => { setIssues([]); }, [wf?.id]);

  // Validazione continua mentre si modifica.
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
    if (!wf) return;
    try { const s = await api.saveWorkflow(wf); setWf(s); setSaved(JSON.stringify(s)); setWorkflows((l) => l.map((x) => (x.id === s.id ? s : x))); } catch (e) { setError((e as Error).message); }
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
    setBusy(true); setError('');
    try {
      if (dirty) await save();
      const { id } = await api.startRun(wf.id, mode, mode === 'reale');
      setRealDialog(false);
      openRun(id);
    } catch (e) {
      const err = e as Error & { issues?: ValidationIssue[] };
      if (err.issues) setIssues(err.issues);
      setError(err.message);
    } finally { setBusy(false); }
  }

  function addPhase(kind: PhaseKind, data?: PhaseConfig) {
    if (!wf) return;
    const preset = data ?? PHASE_PRESETS[kind];
    const maxX = wf.nodes.reduce((m, n) => Math.max(m, n.position.x), -280);
    const avgY = wf.nodes.length ? wf.nodes.reduce((s, n) => s + n.position.y, 0) / wf.nodes.length : 100;
    const id = `${kind.slice(0, 4)}_${Math.random().toString(36).slice(2, 7)}`;
    const last = wf.nodes.find((n) => n.id === selected);
    setWf({
      ...wf,
      nodes: [...wf.nodes, { id, position: { x: maxX + 280, y: avgY }, data: { ...structuredClone(preset) } }],
      edges: last ? [...wf.edges, { id: `e_${id}`, source: last.id, target: id }] : wf.edges,
    });
    setSelected(id);
  }

  function newWorkflow() {
    if (confirmDiscard()) setNewDialog(true);
  }

  async function onCreated(id: string) {
    setNewDialog(false);
    setView('editor');
    setRun(null);
    await loadWorkflows(id);
  }

  async function removeWorkflow() {
    if (!wf || !confirm(`Eliminare il workflow "${wf.name}"? Le esecuzioni salvate restano.`)) return;
    await api.deleteWorkflow(wf.id);
    setRun(null);
    setView('editor');
    await loadWorkflows();
  }

  const shownWf = view === 'run' && run ? run.snapshot : wf;
  const selNode = wf?.nodes.find((n) => n.id === selected);
  const errCount = issues.filter((i) => i.level === 'errore').length;
  const warnCount = issues.length - errCount;
  const generalIssues = useMemo(() => issues.filter((i) => !i.nodeId), [issues]);

  if (!loaded) return <div className="empty">{error ? `Errore: ${error}` : 'Caricamento…'}</div>;
  if (!wf || !shownWf) {
    return (
      <div className="app">
        <header className="topbar"><div className="brand">Regia</div><div className="spacer" /><button onClick={() => setRulesDialog(true)}>Regole</button></header>
        <NewWorkflowDialog inline onCreated={onCreated} />
        {rulesDialog && <RulesDialog onClose={() => setRulesDialog(false)} />}
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Regia</div>
        <select className="wf-select" value={wf.id} onChange={(e) => { if (confirmDiscard()) { const w = workflows.find((x) => x.id === e.target.value)!; setWf(w); setSaved(JSON.stringify(w)); setSelected(null); setView('editor'); setRun(null); } }}>
          {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <button onClick={newWorkflow}>Nuovo</button>
        <button onClick={save} disabled={!dirty} className={dirty ? 'primary' : ''}>{dirty ? 'Salva' : 'Salvato'}</button>
        <div className="seg">
          <button className={view === 'editor' ? 'on' : ''} onClick={() => setView('editor')}>Editor</button>
          <button className={view === 'run' ? 'on' : ''} disabled={!run && runs.length === 0}
            title={runs.length || run ? "Mostra l'esecuzione (la più recente, se non ne hai aperta una)" : 'Nessuna esecuzione per questo workflow'}
            onClick={() => (run && run.workflowId === wf.id ? setView('run') : runs[0] && openRun(runs[0].id))}>Esecuzione</button>
          <button className={view === 'compare' ? 'on' : ''} disabled={runs.length < 2} onClick={() => setView('compare')}>Confronta</button>
        </div>
        <select className="run-select" value={view === 'run' && run ? run.id : ''} onChange={(e) => e.target.value && openRun(e.target.value)}>
          <option value="">{runs.length ? `Apri un'esecuzione (${runs.length})…` : 'Nessuna esecuzione'}</option>
          {runs.map((r) => <option key={r.id} value={r.id}>{fmtTime(r.startedAt)} · {r.mode} · {r.status.replace('_', ' ')} · {fmtUsd(r.costUsd)}</option>)}
        </select>
        <div className="spacer" />
        <button onClick={() => setRulesDialog(true)} title="Regole generali applicate a ogni fase">Regole</button>
        <span className={`valid ${errCount ? 'bad' : 'ok'}`} title={issues.map((i) => `${i.level}: ${i.message}`).join('\n')}>
          {errCount ? `✕ ${errCount} errori` : '✓ valido'}{warnCount ? ` · ${warnCount} avvisi` : ''}
        </span>
        <button className="primary" disabled={busy || errCount > 0} onClick={() => start('prova')} title="Esegue il workflow con agenti simulati: nessuna chiamata, nessun costo">▶ Avvia prova</button>
        <button className="warn-btn" disabled={busy || errCount > 0 || !env?.realRunsEnabled} onClick={() => { api.env(true).then(setEnv); setRealDialog(true); }}>▶ Esecuzione reale…</button>
      </header>
      {error && <div className="errorbar" onClick={() => setError('')}>✕ {error} <span className="muted">(clic per chiudere)</span></div>}

      <div className={`main view-${view}`}>
        {view === 'editor' && (
          <aside className="palette">
            <h4>Aggiungi fase</h4>
            {(Object.keys(PHASE_PRESETS) as PhaseKind[]).map((k) => <button key={k} onClick={() => addPhase(k)}>+ {KIND_LABEL[k]}</button>)}
            <h4>Fasi pronte</h4>
            {PHASE_SNIPPETS.map((s) => <button key={s.id} title={s.hint} onClick={() => addPhase(s.data.kind, s.data)}>+ {s.label}</button>)}
            <p className="hint">Se una fase è selezionata, la nuova viene collegata dopo di essa.</p>
            <h4>Workflow</h4>
            <button className="danger" onClick={removeWorkflow}>Elimina workflow</button>
            {generalIssues.length > 0 && <h4>Validazione</h4>}
            {generalIssues.map((i, k) => <div key={k} className={`issue ${i.level}`}>{i.level === 'errore' ? '✕' : '!'} {i.message}</div>)}
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
              />
            </ReactFlowProvider>
          </section>
        )}
        {view === 'editor' && (
          <aside className="inspector">
            {selNode
              ? <PhaseInspector cfg={selNode.data} issues={issues.filter((i) => i.nodeId === selNode.id)}
                  onChange={(c) => setWf({ ...wf, nodes: wf.nodes.map((n) => (n.id === selNode.id ? { ...n, data: c } : n)) })}
                  onDelete={() => { setWf({ ...wf, nodes: wf.nodes.filter((n) => n.id !== selNode.id), edges: wf.edges.filter((e) => e.source !== selNode.id && e.target !== selNode.id) }); setSelected(null); }} />
              : <WorkflowSettingsForm wf={wf} onChange={setWf} onShowRules={() => setRulesDialog(true)} />}
          </aside>
        )}
        {view === 'run' && run && (
          <aside className="inspector wide">
            <RunPanel run={run} selectedNode={selected} onSelectNode={setSelected}
              onContinue={run.workflowId === wf.id ? async () => { if (dirty) await save(); setContinueFrom(run.id); } : undefined} />
          </aside>
        )}
        {view === 'compare' && <section className="scroll-page"><Compare workflowId={wf.id} initialB={run?.workflowId === wf.id ? run.id : undefined} /></section>}
      </div>

      {continueFrom && <ContinueDialog runId={continueFrom} workflowId={wf.id} onCancel={() => setContinueFrom(null)} onStarted={(id) => { setContinueFrom(null); openRun(id); }} />}
      {newDialog && <NewWorkflowDialog onCancel={() => setNewDialog(false)} onCreated={onCreated} />}
      {rulesDialog && <RulesDialog projectDir={wf.settings.projectDir} onClose={() => setRulesDialog(false)} />}
      {realDialog && <RealRunDialog env={env} wf={wf} busy={busy} onCancel={() => setRealDialog(false)} onConfirm={() => start('reale')} />}
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
  return (
    <div className="modal-back" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Conferma esecuzione reale">
        <h2>Esecuzione reale</h2>
        <h4>Autenticazione rilevata</h4>
        {!env ? <p>Verifica in corso…</p> : (
          <ul>
            <li>Claude Code: {env.claudeCodeVersion ?? 'non trovato nel PATH (il SDK usa il proprio eseguibile)'} · Agent SDK {env.sdkVersion}</li>
            <li>Login: {a?.loggedIn ? `sì, metodo ${a.authMethod}${a.subscriptionType ? `, piano ${a.subscriptionType}` : ''}` : 'no'}</li>
            <li>Variabile ANTHROPIC_API_KEY: {a?.apiKeyEnv ? 'presente (ha la precedenza sul login)' : 'assente'}</li>
          </ul>
        )}
        {subscription && (
          <div className="note">
            Gli agenti useranno il login claude.ai di Claude Code su questo computer: il consumo viene conteggiato sui limiti del piano {a?.subscriptionType}{' '}
            (e sui crediti extra solo se l'organizzazione li ha attivati), non fatturato a token. I dollari mostrati sono un equivalente calcolato dal SDK a prezzi di listino.
            La documentazione dell'Agent SDK chiede ai prodotti di terze parti di usare chiavi API anziché il login claude.ai: per un uso personale e locale questo
            funziona, ma verifica le regole della tua organizzazione. Per la fatturazione a consumo, avvia Regia con <code>ANTHROPIC_API_KEY</code> impostata.
          </div>
        )}
        {a?.apiKeyEnv && <div className="note">Con la chiave API il consumo è fatturato a token sull'account della chiave. Il costo effettivo si verifica nella Console.</div>}
        <h4>Cosa succederà</h4>
        <ul>
          <li>{agents.length} fasi con agenti; modelli: {[...new Set(agents.map((n) => n.data.model || 'predefinito'))].join(', ')}.</li>
          <li>Cartella di lavoro: <code>{wf.settings.projectDir}</code><FolderStatus path={wf.settings.projectDir} /></li>
          <li>Regole generali: {wf.settings.applyGeneralRules === false ? <strong>non applicate</strong> : <>applicate a ogni fase (regole personali da <code>{env?.globalRulesPath}</code> e regole di Regia)</>}{wf.settings.loadProjectSettings ? '; CLAUDE.md del progetto caricato se presente' : ''}.</li>
          {servers.length > 0 && <li><strong>Comandi locali avviati da Regia:</strong> {servers.map((n) => <code key={n.id} style={{ marginRight: 6 }}>{n.data.command}</code>)} (restano attivi fino alla fine dell'esecuzione).</li>}
          {writers.length > 0 && <li><strong>Possono modificare file o eseguire comandi:</strong> {writers.map((n) => n.data.label).join(', ')}. Gli strumenti non elencati nella fase vengono negati.</li>}
          <li>Limite di spesa stimata per l'esecuzione: {wf.settings.runBudgetUsd ? fmtUsd(wf.settings.runBudgetUsd, 2) : <strong>nessuno</strong>} (applicato tramite <code>maxBudgetUsd</code> del SDK sulla stima, non sulla fatturazione).</li>
        </ul>
        {warn.map((i, k) => <div key={k} className={`issue ${i.level}`}>{i.level === 'errore' ? '✕' : '!'} {i.message}</div>)}
        <label className="check"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> Ho letto e voglio avviare l'esecuzione reale</label>
        <div className="actions">
          <button onClick={onCancel}>Annulla</button>
          <button className="warn-btn" disabled={!ok || busy || !a || (!a.loggedIn && !a.apiKeyEnv) || warn.some((i) => i.level === 'errore')} onClick={onConfirm}>Avvia</button>
        </div>
      </div>
    </div>
  );
}
