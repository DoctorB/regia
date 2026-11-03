import { useEffect, useState } from 'react';
import type { AppliedRules, ContinuationPlan, FolderInfo, RulesInfo, RunMode, WorkflowTemplate } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { KIND_LABEL } from './Canvas.tsx';

/** Stato di una cartella di progetto: esistenza, git, modifiche non salvate, CLAUDE.md. */
export function FolderStatus({ path }: { path: string }) {
  const [info, setInfo] = useState<FolderInfo | null>(null);
  useEffect(() => {
    setInfo(null);
    if (!path.trim()) return;
    const t = setTimeout(() => api.folderInfo(path.trim()).then(setInfo).catch(() => setInfo(null)), 350);
    return () => clearTimeout(t);
  }, [path]);
  if (!path.trim()) return <div className="folder-status muted">Indica il percorso assoluto della cartella del progetto.</div>;
  if (!info) return <div className="folder-status muted">Controllo…</div>;
  if (!info.exists) return <div className="folder-status bad">✕ Cartella non trovata (serve un percorso assoluto esistente).</div>;
  if (!info.isDirectory) return <div className="folder-status bad">✕ Il percorso indica un file, non una cartella.</div>;
  const g = info.git;
  return (
    <div className="folder-status">
      <div className="ok">✓ Cartella trovata{info.claudeMd ? ' · contiene CLAUDE.md' : ''}</div>
      {g?.isRepo ? (
        g.pendingChanges ? (
          <div className="warn">! Repository git ({g.branch}) con {g.pendingChanges} file modificati o non tracciati: fai un commit o uno stash prima di un'esecuzione reale, così potrai annullare le modifiche degli agenti.</div>
        ) : (
          <div className="ok">✓ Repository git ({g.branch}) senza modifiche in sospeso: potrai rivedere tutto con git diff.</div>
        )
      ) : (
        <div className="warn">! Non è un repository git: le modifiche degli agenti non si potranno annullare facilmente. Usa preset in sola lettura o fai una copia.</div>
      )}
    </div>
  );
}

export function NewWorkflowDialog({ onCancel, onCreated, inline = false }: { onCancel?: () => void; onCreated: (id: string) => void; inline?: boolean }) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [tpl, setTpl] = useState<string>('');
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [goal, setGoal] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.templates().then((t) => { setTemplates(t); setTpl(t[0]?.id ?? ''); }); }, []);
  const chosen = templates.find((t) => t.id === tpl);

  async function create() {
    setBusy(true); setErr('');
    try {
      const wf = await api.createWorkflow({ templateId: tpl || undefined, name, projectDir: dir, goal });
      onCreated(wf.id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const body = (
    <div className="newwf">
      <h2>{inline ? 'Crea il tuo primo workflow' : 'Nuovo workflow'}</h2>
      <h4>1. Parti da un preset</h4>
      <div className="tpl-grid" role="radiogroup" aria-label="Preset">
        {templates.map((t) => (
          <button key={t.id} role="radio" aria-checked={tpl === t.id} className={`tpl ${tpl === t.id ? 'on' : ''}`} onClick={() => setTpl(t.id)}>
            <strong>{t.name}</strong>
            <span className="small">{t.description}</span>
            <span className="tpl-phases">{t.nodes.map((n) => n.data.label).join(' → ')}</span>
          </button>
        ))}
        <button role="radio" aria-checked={tpl === ''} className={`tpl ${tpl === '' ? 'on' : ''}`} onClick={() => setTpl('')}>
          <strong>Vuoto</strong>
          <span className="small">Nessuna fase: componi il diagramma da zero.</span>
        </button>
      </div>
      {chosen && (
        <p className="hint">
          Fasi: {chosen.nodes.map((n) => `${n.data.label} (${KIND_LABEL[n.data.kind].toLowerCase()}${n.data.model ? `, ${n.data.model}` : ''})`).join(', ')}.
          {chosen.settings.runBudgetUsd ? ` Limite di spesa iniziale: $${chosen.settings.runBudgetUsd}.` : ''}
        </p>
      )}
      <h4>2. Progetto e obiettivo</h4>
      <div className="form flat">
        <label>Cartella del progetto
          <input id="nw-dir" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="C:\percorso\del\progetto" />
        </label>
        <FolderStatus path={dir} />
        <label>Obiettivo
          <textarea id="nw-goal" rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={chosen?.goalHint ?? 'Cosa devono ottenere gli agenti, e quando il lavoro è finito.'} />
        </label>
        <label>Nome (facoltativo)
          <input id="nw-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={chosen?.name ?? 'Nuovo workflow'} />
        </label>
      </div>
      <p className="hint">Potrai modificare fasi, istruzioni, modelli e limiti nell'editor prima di avviare. Prova sempre prima con "Avvia prova", che non costa nulla.</p>
      {err && <div className="issue errore">{err}</div>}
      <div className="actions end">
        {onCancel && <button onClick={onCancel}>Annulla</button>}
        <button className="primary" disabled={busy} onClick={create}>Crea workflow</button>
      </div>
    </div>
  );
  if (inline) return <section className="scroll-page">{body}</section>;
  return (
    <div className="modal-back" onClick={onCancel}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Nuovo workflow">{body}</div>
    </div>
  );
}

export function RulesDialog({ projectDir, onClose }: { projectDir?: string; onClose: () => void }) {
  const [info, setInfo] = useState<RulesInfo | null>(null);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => { api.rules(projectDir).then((r) => { setInfo(r); setText(r.regia.text); setSaved(r.regia.text); }); }, [projectDir]);
  const save = async () => { const r = await api.saveRules(text); setSaved(r.regia.text); };
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Regole generali">
        <h2>Regole generali</h2>
        <p className="hint">
          Queste regole vengono aggiunte alle istruzioni di <strong>ogni fase</strong> dei workflow che hanno l'opzione "Applica le regole generali" attiva (predefinita),
          e prevalgono sulle istruzioni della fase. Ogni esecuzione salva le regole che ha usato.
        </p>
        {!info ? <p className="muted">Caricamento…</p> : (
          <>
            <h4>Regole personali <span className="muted small mono">{info.global.path}</span></h4>
            {info.global.exists
              ? <pre className="rules-pre">{info.global.text.trim() || '(file vuoto)'}</pre>
              : <p className="muted">File non presente.</p>}
            <p className="hint">Lette a ogni esecuzione e mai modificate da Regia. Per cambiarle modifica il file.</p>

            <h4>Regole di Regia <span className="muted small mono">{info.regia.path}</span></h4>
            <textarea id="rules-regia" rows={7} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="actions">
              <button className={text !== saved ? 'primary' : ''} disabled={text === saved} onClick={save}>{text !== saved ? 'Salva regole' : 'Salvate'}</button>
            </div>

            {info.project && (
              <>
                <h4>CLAUDE.md del progetto <span className="muted small mono">{info.project.path}</span></h4>
                {info.project.exists
                  ? <pre className="rules-pre">{info.project.text.trim() || '(file vuoto)'}</pre>
                  : <p className="muted">Il progetto non ha un CLAUDE.md.</p>}
                <p className="hint">Caricato dalla CLI solo se nel workflow è attiva l'opzione "Carica CLAUDE.md e .claude/settings.json del progetto".</p>
              </>
            )}
          </>
        )}
        <div className="actions end"><button onClick={onClose}>Chiudi</button></div>
      </div>
    </div>
  );
}

/** Regole fotografate all'avvio di un'esecuzione. */
export function AppliedRulesView({ rules }: { rules?: AppliedRules }) {
  if (!rules) return <p className="muted small">Esecuzione precedente all'introduzione delle regole generali.</p>;
  return (
    <details className="card rules-card">
      <summary>
        <strong>Regole applicate</strong>{' '}
        {rules.applied
          ? <span className="badge st-good">✓ {[rules.global ? 'personali' : null, rules.regia ? 'Regia' : null, rules.projectPath ? 'progetto' : null].filter(Boolean).join(' + ') || 'nessun testo'}</span>
          : <span className="badge st-critical">✕ disattivate{rules.projectPath ? ' (solo CLAUDE.md del progetto)' : ''}</span>}
      </summary>
      {rules.global && <><h4>Personali <span className="muted small mono">{rules.globalPath}</span></h4><pre className="rules-pre">{rules.global}</pre></>}
      {rules.regia && <><h4>Regia</h4><pre className="rules-pre">{rules.regia}</pre></>}
      {rules.projectPath && <p className="small">CLAUDE.md del progetto caricato dalla CLI: <code>{rules.projectPath}</code></p>}
    </details>
  );
}

/** Nuova esecuzione che riprende le fasi già completate e invariate di un'esecuzione precedente. */
export function ContinueDialog({ runId, workflowId, onCancel, onStarted }: { runId: string; workflowId: string; onCancel: () => void; onStarted: (id: string) => void }) {
  const [plan, setPlan] = useState<(ContinuationPlan & { mode: RunMode }) | null>(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.continuation(runId, workflowId).then(setPlan).catch((e) => setErr(e.message)); }, [runId, workflowId]);
  const real = plan?.mode === 'reale';
  async function start() {
    if (!plan) return;
    setBusy(true); setErr('');
    try { const r = await api.startRun(workflowId, plan.mode, real, runId); onStarted(r.id); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="modal-back" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Continua l'esecuzione">
        <h2>Continua dall'esecuzione precedente</h2>
        <p className="hint">Nuova esecuzione {real ? 'reale' : 'di prova'} con il workflow come è salvato ora. Le fasi già completate e invariate vengono riprese con i loro risultati, senza chiamate; le altre vengono eseguite.</p>
        {!plan && !err && <p className="muted">Calcolo…</p>}
        {plan && (
          <>
            <h4>Riprese ({plan.reused.length})</h4>
            {plan.reused.length ? <ul>{plan.reused.map((r) => <li key={r.nodeId}>♻ {r.label}</li>)}</ul> : <p className="muted small">Nessuna: verrà eseguito tutto.</p>}
            <h4>Da eseguire ({plan.toRun.length})</h4>
            {plan.toRun.length ? <ul>{plan.toRun.map((r) => <li key={r.nodeId}>▶ <strong>{r.label}</strong> <span className="muted small">— {r.reason}</span></li>)}</ul> : <p className="muted small">Nessuna: il workflow non è cambiato.</p>}
            <p className="hint">Se respingi una nuova approvazione, la fase di implementazione ripresa riparte dalla sua sessione originale con il tuo commento, e le fasi successive vengono rieseguite.</p>
            {real && (
              <label className="check"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> Avvia le fasi da eseguire con agenti reali (consumo sul tuo piano o sulla chiave API, limite di spesa del workflow)</label>
            )}
          </>
        )}
        {err && <div className="issue errore">{err}</div>}
        <div className="actions end">
          <button onClick={onCancel}>Annulla</button>
          <button className={real ? 'warn-btn' : 'primary'} disabled={!plan || busy || plan.toRun.length === 0 || (real && !ok)} onClick={start}>Avvia</button>
        </div>
      </div>
    </div>
  );
}
