import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight, CircleAlert, CircleCheck, FolderGit2, FolderOpen, Loader2, Play, Recycle, ScrollText, ShieldCheck, TriangleAlert, Workflow as WorkflowIcon,
} from 'lucide-react';
import type { AppliedRules, ContinuationPlan, FolderInfo, RulesInfo, RunMode, WorkflowTemplate } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { Field, KindTile, Modal } from '../ui.tsx';
import { PrinciplePicker } from './Principles.tsx';

/** Stato di una cartella di progetto: esistenza, git, modifiche non salvate, CLAUDE.md. */
export function FolderStatus({ path }: { path: string }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<FolderInfo | null>(null);
  useEffect(() => {
    setInfo(null);
    if (!path.trim()) return;
    const t = setTimeout(() => api.folderInfo(path.trim()).then(setInfo).catch(() => setInfo(null)), 350);
    return () => clearTimeout(t);
  }, [path]);
  if (!path.trim()) return <div className="folder-status muted"><FolderOpen />{t('folder.hint')}</div>;
  if (!info) return <div className="folder-status muted"><Loader2 className="spin" />{t('folder.checking')}</div>;
  if (!info.exists) return <div className="folder-status tone-bad"><CircleAlert />{t('folder.notFound')}</div>;
  if (!info.isDirectory) return <div className="folder-status tone-bad"><CircleAlert />{t('folder.isFile')}</div>;
  const g = info.git;
  return (
    <div className="folder-status">
      <div className="tone-good"><CircleCheck />{t('folder.found')}{info.claudeMd ? t('folder.hasClaudeMd') : ''}</div>
      {g?.isRepo ? (
        g.pendingChanges
          ? <div className="tone-warn"><TriangleAlert />{t('folder.gitDirty', { branch: g.branch, count: g.pendingChanges })}</div>
          : <div className="tone-good"><FolderGit2 />{t('folder.gitClean', { branch: g.branch })}</div>
      ) : (
        <div className="tone-warn"><TriangleAlert />{t('folder.notRepo')}</div>
      )}
    </div>
  );
}

function TemplateCard({ tpl, on, onClick }: { tpl?: WorkflowTemplate; on: boolean; onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button role="radio" aria-checked={on} className={`tpl ${on ? 'on' : ''}`} onClick={onClick}>
      <div className="tpl-top">
        <strong>{tpl?.name ?? t('setup.emptyTemplate')}</strong>
        {on && <CircleCheck className="tpl-check" />}
      </div>
      <span className="tpl-desc">{tpl?.description ?? t('setup.emptyTemplateDesc')}</span>
      {tpl && (
        <div className="tpl-flow">
          {tpl.nodes.map((n, i) => (
            <span key={n.id} className="tpl-step"><KindTile kind={n.data.kind} size="sm" />{i < tpl.nodes.length - 1 && <ArrowRight className="tpl-arrow" />}</span>
          ))}
        </div>
      )}
    </button>
  );
}

export function NewWorkflowDialog({ onCancel, onCreated, inline = false, groups = [] }: { onCancel?: () => void; onCreated: (id: string) => void; inline?: boolean; groups?: string[] }) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [tpl, setTpl] = useState<string>('');
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [goal, setGoal] = useState('');
  const [principles, setPrinciples] = useState<string[] | undefined>();
  // Gruppo: di base il nome della cartella del progetto, finché non lo cambi a mano.
  const [group, setGroup] = useState('');
  const [groupTouched, setGroupTouched] = useState(false);
  useEffect(() => {
    if (groupTouched) return;
    setGroup(dir.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '');
  }, [dir, groupTouched]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const { t, lang } = useI18n();
  const picked = useRef(false);
  // Preset nella lingua corrente: si ricaricano quando cambia la lingua, mantenendo la scelta già fatta.
  useEffect(() => {
    api.templates(lang).then((list) => {
      setTemplates(list);
      const keep = picked.current;
      setTpl((cur) => (keep && (cur === '' || list.some((x) => x.id === cur)) ? cur : list[0]?.id ?? ''));
      picked.current = true;
    });
  }, [lang]);
  const chosen = templates.find((x) => x.id === tpl);

  async function create() {
    setBusy(true); setErr('');
    try {
      const wf = await api.createWorkflow({ templateId: tpl || undefined, name, projectDir: dir, goal, language: lang, group, principles });
      onCreated(wf.id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const form = (
    <div className="newwf">
      <div className="step"><span className="step-n">1</span><h3>{t('setup.step1')}</h3></div>
      <div className="tpl-grid" role="radiogroup" aria-label={t('setup.presets')}>
        {templates.map((x) => <TemplateCard key={x.id} tpl={x} on={tpl === x.id} onClick={() => setTpl(x.id)} />)}
        <TemplateCard on={tpl === ''} onClick={() => setTpl('')} />
      </div>
      <div className="step"><span className="step-n">2</span><h3>{t('setup.step2')}</h3></div>
      <div className="newwf-fields">
        <Field label={t('setup.projectDir')}><input id="nw-dir" value={dir} onChange={(e) => setDir(e.target.value)} placeholder={t('setup.projectDirPlaceholder')} /></Field>
        <FolderStatus path={dir} />
        <Field label={t('setup.goal')} hint={t('setup.goalHint')}>
          <textarea id="nw-goal" rows={4} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={chosen?.goalHint ?? t('setup.goalPlaceholder')} />
        </Field>
        <div className="grid2">
          <Field label={t('setup.name')}><input id="nw-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={chosen?.name ?? t('setup.namePlaceholder')} /></Field>
          <Field label={t('manage.group')} hint={t('manage.groupHintNew')}>
            <input id="nw-group" list="nw-groups" value={group} onChange={(e) => { setGroup(e.target.value); setGroupTouched(true); }} placeholder={t('manage.groupPlaceholder')} />
            <datalist id="nw-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
          </Field>
        </div>
        <div className="field" role="group" aria-label={t('principles.title')}>
          <span className="field-label">{t('principles.title')}</span>
          <PrinciplePicker value={principles} onChange={setPrinciples} />
          <span className="field-hint">{t('principles.hint')}</span>
        </div>
      </div>
      {err && <div className="callout tone-bad"><CircleAlert /><span>{err}</span></div>}
    </div>
  );
  const actions = (
    <>
      <span className="muted small grow">{t('setup.footnote')}</span>
      {onCancel && <button className="btn ghost" onClick={onCancel}>{t('common.cancel')}</button>}
      <button className="btn primary" disabled={busy} onClick={create}>{t('setup.create')}<ArrowRight /></button>
    </>
  );

  if (inline) {
    return (
      <section className="welcome">
        <div className="welcome-inner">
          <div className="welcome-hero">
            <span className="brand-mark lg" aria-hidden><WorkflowIcon /></span>
            <div>
              <h1>{t('welcome.title')}</h1>
              <p>{t('welcome.text')}</p>
            </div>
          </div>
          <div className="card pad-lg">{form}<div className="form-actions">{actions}</div></div>
        </div>
      </section>
    );
  }
  return <Modal title={t('setup.title')} icon={<span className="kind-tile kind-workflow"><WorkflowIcon /></span>} onClose={onCancel ?? (() => undefined)} footer={actions} wide>{form}</Modal>;
}

export function RulesDialog({ projectDir, onClose }: { projectDir?: string; onClose: () => void }) {
  const [info, setInfo] = useState<RulesInfo | null>(null);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const { t } = useI18n();
  useEffect(() => { api.rules(projectDir).then((r) => { setInfo(r); setText(r.regia.text); setSaved(r.regia.text); }); }, [projectDir]);
  const save = async () => { const r = await api.saveRules(text); setSaved(r.regia.text); };
  return (
    <Modal title={t('rules.title')} icon={<span className="kind-tile kind-workflow"><ShieldCheck /></span>} onClose={onClose} wide
      footer={<><span className="muted small grow">{t('rules.footnote')}</span><button className="btn ghost" onClick={onClose}>{t('common.close')}</button></>}>
      <p className="lead">{t('rules.leadBefore')}<strong>{t('rules.leadStrong')}</strong>{t('rules.leadAfter')}</p>
      {!info ? <p className="muted">{t('common.loading')}</p> : (
        <div className="rules">
          <div className="rule-block">
            <div className="rule-head"><strong>{t('rules.personal')}</strong><code>{info.global.path}</code><span className="tag">{t('rules.readOnly')}</span></div>
            {info.global.exists ? <pre className="code-block">{info.global.text.trim() || t('rules.emptyFile')}</pre> : <p className="muted">{t('rules.fileMissing')}</p>}
          </div>
          <div className="rule-block">
            <div className="rule-head"><strong>{t('rules.regia')}</strong><code>{info.regia.path}</code></div>
            <textarea id="rules-regia" className="mono" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="row-end"><button className={`btn sm ${text !== saved ? 'primary' : 'ghost'}`} disabled={text === saved} onClick={save}>{text !== saved ? t('rules.save') : t('rules.saved')}</button></div>
          </div>
          {info.project && (
            <div className="rule-block">
              <div className="rule-head"><strong>{t('rules.projectClaudeMd')}</strong><code>{info.project.path}</code><span className="tag">{t('rules.ifEnabled')}</span></div>
              {info.project.exists ? <pre className="code-block">{info.project.text.trim() || t('rules.emptyFile')}</pre> : <p className="muted">{t('rules.noProjectClaudeMd')}</p>}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Regole fotografate all'avvio di un'esecuzione. */
export function AppliedRulesView({ rules }: { rules?: AppliedRules }) {
  const { t } = useI18n();
  if (!rules) return null;
  const parts = [rules.global ? t('rules.partPersonal') : null, rules.regia ? 'Regia' : null, rules.projectPath ? t('rules.partProject') : null].filter(Boolean).join(' + ');
  return (
    <details className="disclosure">
      <summary>
        <ScrollText /><span>{t('rules.applied')}</span>
        <span className={`pill ${rules.applied ? 'tone-good' : 'tone-bad'}`}>{rules.applied ? parts || t('rules.noText') : t('rules.disabled')}</span>
      </summary>
      <div className="disclosure-body">
        {rules.global && <><div className="rule-head"><strong>{t('rules.personalShort')}</strong><code>{rules.globalPath}</code></div><pre className="code-block">{rules.global}</pre></>}
        {rules.regia && <><div className="rule-head"><strong>Regia</strong></div><pre className="code-block">{rules.regia}</pre></>}
        {rules.projectPath && <p className="small">{t('rules.projectLoaded')} <code>{rules.projectPath}</code></p>}
      </div>
    </details>
  );
}

/** Nuova esecuzione che riprende le fasi già completate e invariate di un'esecuzione precedente. */
export function ContinueDialog({ runId, workflowId, onCancel, onStarted }: { runId: string; workflowId: string; onCancel: () => void; onStarted: (id: string) => void }) {
  const { t, tm } = useI18n();
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
    <Modal title={t('continue.title')} icon={<span className="kind-tile kind-workflow"><Recycle /></span>} onClose={onCancel}
      footer={<>
        {real && plan && <label className="check grow"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />{t('continue.realConfirm')}</label>}
        {!real && <span className="grow" />}
        <button className="btn ghost" onClick={onCancel}>{t('common.cancel')}</button>
        <button className={`btn ${real ? 'warn' : 'primary'}`} disabled={!plan || busy || plan.toRun.length === 0 || (real && !ok)} onClick={start}><Play />{t('common.start')}</button>
      </>}>
      <p className="lead">{real ? t('continue.leadReal') : t('continue.leadTest')}</p>
      {!plan && !err && <p className="muted">{t('continue.computing')}</p>}
      {plan && (
        <div className="plan">
          <div className="plan-col">
            <h4><Recycle />{t('continue.reused')} <span className="count">{plan.reused.length}</span></h4>
            {plan.reused.length ? <ul>{plan.reused.map((r) => <li key={r.nodeId}>{r.label}</li>)}</ul> : <p className="muted small">{t('continue.noneReused')}</p>}
          </div>
          <div className="plan-col run">
            <h4><Play />{t('continue.toRun')} <span className="count">{plan.toRun.length}</span></h4>
            {plan.toRun.length ? <ul>{plan.toRun.map((r) => <li key={r.nodeId}><strong>{r.label}</strong><small>{tm(r.reasonMsg, r.reason)}</small></li>)}</ul> : <p className="muted small">{t('continue.noneToRun')}</p>}
          </div>
        </div>
      )}
      <p className="hint">{t('continue.hint')}</p>
      {err && <div className="callout tone-bad"><CircleAlert /><span>{err}</span></div>}
    </Modal>
  );
}
