import { useEffect, useState } from 'react';
import {
  ArrowRight, CircleAlert, CircleCheck, FolderGit2, FolderOpen, Loader2, Play, Recycle, ScrollText, ShieldCheck, TriangleAlert, Workflow as WorkflowIcon,
} from 'lucide-react';
import type { AppliedRules, ContinuationPlan, FolderInfo, RulesInfo, RunMode, WorkflowTemplate } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { Field, KindTile, Modal } from '../ui.tsx';

/** Stato di una cartella di progetto: esistenza, git, modifiche non salvate, CLAUDE.md. */
export function FolderStatus({ path }: { path: string }) {
  const [info, setInfo] = useState<FolderInfo | null>(null);
  useEffect(() => {
    setInfo(null);
    if (!path.trim()) return;
    const t = setTimeout(() => api.folderInfo(path.trim()).then(setInfo).catch(() => setInfo(null)), 350);
    return () => clearTimeout(t);
  }, [path]);
  if (!path.trim()) return <div className="folder-status muted"><FolderOpen />Indica il percorso assoluto della cartella del progetto.</div>;
  if (!info) return <div className="folder-status muted"><Loader2 className="spin" />Controllo della cartella…</div>;
  if (!info.exists) return <div className="folder-status tone-bad"><CircleAlert />Cartella non trovata: serve un percorso assoluto esistente.</div>;
  if (!info.isDirectory) return <div className="folder-status tone-bad"><CircleAlert />Il percorso indica un file, non una cartella.</div>;
  const g = info.git;
  return (
    <div className="folder-status">
      <div className="tone-good"><CircleCheck />Cartella trovata{info.claudeMd ? ' · contiene CLAUDE.md' : ''}</div>
      {g?.isRepo ? (
        g.pendingChanges
          ? <div className="tone-warn"><TriangleAlert />Git ({g.branch}): {g.pendingChanges} file modificati. Fai commit o stash prima di un'esecuzione reale, così potrai annullare le modifiche degli agenti.</div>
          : <div className="tone-good"><FolderGit2 />Git ({g.branch}) pulito: potrai rivedere tutto con git diff.</div>
      ) : (
        <div className="tone-warn"><TriangleAlert />Non è un repository git: le modifiche degli agenti non si potranno annullare facilmente.</div>
      )}
    </div>
  );
}

function TemplateCard({ t, on, onClick }: { t?: WorkflowTemplate; on: boolean; onClick: () => void }) {
  return (
    <button role="radio" aria-checked={on} className={`tpl ${on ? 'on' : ''}`} onClick={onClick}>
      <div className="tpl-top">
        <strong>{t?.name ?? 'Vuoto'}</strong>
        {on && <CircleCheck className="tpl-check" />}
      </div>
      <span className="tpl-desc">{t?.description ?? 'Nessuna fase: componi il diagramma da zero.'}</span>
      {t && (
        <div className="tpl-flow">
          {t.nodes.map((n, i) => (
            <span key={n.id} className="tpl-step"><KindTile kind={n.data.kind} size="sm" />{i < t.nodes.length - 1 && <ArrowRight className="tpl-arrow" />}</span>
          ))}
        </div>
      )}
    </button>
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

  const form = (
    <div className="newwf">
      <div className="step"><span className="step-n">1</span><h3>Scegli da dove partire</h3></div>
      <div className="tpl-grid" role="radiogroup" aria-label="Preset">
        {templates.map((t) => <TemplateCard key={t.id} t={t} on={tpl === t.id} onClick={() => setTpl(t.id)} />)}
        <TemplateCard on={tpl === ''} onClick={() => setTpl('')} />
      </div>
      <div className="step"><span className="step-n">2</span><h3>Progetto e obiettivo</h3></div>
      <div className="newwf-fields">
        <Field label="Cartella del progetto"><input id="nw-dir" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="C:\percorso\del\progetto" /></Field>
        <FolderStatus path={dir} />
        <Field label="Obiettivo" hint="Cosa va fatto e quando il lavoro è finito: più è preciso, meno passaggi servono.">
          <textarea id="nw-goal" rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={chosen?.goalHint ?? 'Cosa devono ottenere gli agenti.'} />
        </Field>
        <Field label="Nome"><input id="nw-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={chosen?.name ?? 'Nuovo workflow'} /></Field>
      </div>
      {err && <div className="callout tone-bad"><CircleAlert /><span>{err}</span></div>}
    </div>
  );
  const actions = (
    <>
      <span className="muted small grow">Potrai modificare tutto nell'editor. Prova sempre prima con "Prova": è gratis.</span>
      {onCancel && <button className="btn ghost" onClick={onCancel}>Annulla</button>}
      <button className="btn primary" disabled={busy} onClick={create}>Crea workflow<ArrowRight /></button>
    </>
  );

  if (inline) {
    return (
      <section className="welcome">
        <div className="welcome-inner">
          <div className="welcome-hero">
            <span className="brand-mark lg" aria-hidden><WorkflowIcon /></span>
            <div>
              <h1>Benvenuto in Regia</h1>
              <p>Disegna il percorso, lascia lavorare gli agenti, intervieni quando serve. Crea il tuo primo workflow partendo da un preset.</p>
            </div>
          </div>
          <div className="card pad-lg">{form}<div className="form-actions">{actions}</div></div>
        </div>
      </section>
    );
  }
  return <Modal title="Nuovo workflow" icon={<span className="kind-tile kind-workflow"><WorkflowIcon /></span>} onClose={onCancel ?? (() => undefined)} footer={actions} wide>{form}</Modal>;
}

export function RulesDialog({ projectDir, onClose }: { projectDir?: string; onClose: () => void }) {
  const [info, setInfo] = useState<RulesInfo | null>(null);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => { api.rules(projectDir).then((r) => { setInfo(r); setText(r.regia.text); setSaved(r.regia.text); }); }, [projectDir]);
  const save = async () => { const r = await api.saveRules(text); setSaved(r.regia.text); };
  return (
    <Modal title="Regole generali" icon={<span className="kind-tile kind-workflow"><ShieldCheck /></span>} onClose={onClose} wide
      footer={<><span className="muted small grow">Ogni esecuzione salva le regole che ha usato.</span><button className="btn ghost" onClick={onClose}>Chiudi</button></>}>
      <p className="lead">Aggiunte alle istruzioni di <strong>ogni fase</strong> nei workflow con "Applica le regole generali" attivo. Prevalgono sulle istruzioni della fase.</p>
      {!info ? <p className="muted">Caricamento…</p> : (
        <div className="rules">
          <div className="rule-block">
            <div className="rule-head"><strong>Regole personali</strong><code>{info.global.path}</code><span className="tag">sola lettura</span></div>
            {info.global.exists ? <pre className="code-block">{info.global.text.trim() || '(file vuoto)'}</pre> : <p className="muted">File non presente.</p>}
          </div>
          <div className="rule-block">
            <div className="rule-head"><strong>Regole di Regia</strong><code>{info.regia.path}</code></div>
            <textarea id="rules-regia" className="mono" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="row-end"><button className={`btn sm ${text !== saved ? 'primary' : 'ghost'}`} disabled={text === saved} onClick={save}>{text !== saved ? 'Salva regole' : 'Salvate'}</button></div>
          </div>
          {info.project && (
            <div className="rule-block">
              <div className="rule-head"><strong>CLAUDE.md del progetto</strong><code>{info.project.path}</code><span className="tag">se attivo nel workflow</span></div>
              {info.project.exists ? <pre className="code-block">{info.project.text.trim() || '(file vuoto)'}</pre> : <p className="muted">Il progetto non ha un CLAUDE.md.</p>}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Regole fotografate all'avvio di un'esecuzione. */
export function AppliedRulesView({ rules }: { rules?: AppliedRules }) {
  if (!rules) return null;
  const parts = [rules.global ? 'personali' : null, rules.regia ? 'Regia' : null, rules.projectPath ? 'progetto' : null].filter(Boolean).join(' + ');
  return (
    <details className="disclosure">
      <summary>
        <ScrollText /><span>Regole applicate</span>
        <span className={`pill ${rules.applied ? 'tone-good' : 'tone-bad'}`}>{rules.applied ? parts || 'nessun testo' : 'disattivate'}</span>
      </summary>
      <div className="disclosure-body">
        {rules.global && <><div className="rule-head"><strong>Personali</strong><code>{rules.globalPath}</code></div><pre className="code-block">{rules.global}</pre></>}
        {rules.regia && <><div className="rule-head"><strong>Regia</strong></div><pre className="code-block">{rules.regia}</pre></>}
        {rules.projectPath && <p className="small">CLAUDE.md del progetto caricato dalla CLI: <code>{rules.projectPath}</code></p>}
      </div>
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
    <Modal title="Continua dall'esecuzione" icon={<span className="kind-tile kind-workflow"><Recycle /></span>} onClose={onCancel}
      footer={<>
        {real && plan && <label className="check grow"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />Avvia con agenti reali</label>}
        {!real && <span className="grow" />}
        <button className="btn ghost" onClick={onCancel}>Annulla</button>
        <button className={`btn ${real ? 'warn' : 'primary'}`} disabled={!plan || busy || plan.toRun.length === 0 || (real && !ok)} onClick={start}><Play />Avvia</button>
      </>}>
      <p className="lead">Nuova esecuzione {real ? 'reale' : 'di prova'} con il workflow salvato. Le fasi già completate e invariate vengono riprese senza rifarle.</p>
      {!plan && !err && <p className="muted">Calcolo…</p>}
      {plan && (
        <div className="plan">
          <div className="plan-col">
            <h4><Recycle />Riprese <span className="count">{plan.reused.length}</span></h4>
            {plan.reused.length ? <ul>{plan.reused.map((r) => <li key={r.nodeId}>{r.label}</li>)}</ul> : <p className="muted small">Nessuna: verrà eseguito tutto.</p>}
          </div>
          <div className="plan-col run">
            <h4><Play />Da eseguire <span className="count">{plan.toRun.length}</span></h4>
            {plan.toRun.length ? <ul>{plan.toRun.map((r) => <li key={r.nodeId}><strong>{r.label}</strong><small>{r.reason}</small></li>)}</ul> : <p className="muted small">Nessuna: il workflow non è cambiato.</p>}
          </div>
        </div>
      )}
      <p className="hint">Se respingi una nuova approvazione, l'implementazione ripresa riparte dalla sua sessione originale con il tuo commento.</p>
      {err && <div className="callout tone-bad"><CircleAlert /><span>{err}</span></div>}
    </Modal>
  );
}
