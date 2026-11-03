import { FileCode2, Lock, PencilLine, ScrollText, Trash2, TriangleAlert, CircleAlert } from 'lucide-react';
import { KNOWN_TOOLS, WRITE_TOOLS, type PhaseConfig, type PhaseKind, type ValidationIssue, type Workflow } from '../../../shared/types.ts';
import { useI18n } from '../i18n.tsx';
import { Field, KIND_META, KindTile, Section, Switch, kindLabel } from '../ui.tsx';
import { FolderStatus } from './Setup.tsx';

// Descrizioni in locales/<lingua>/run.json (inspector.models.<id>).
const MODELS: { id: string; label: string; cost: string }[] = [
  { id: 'haiku', label: 'Haiku', cost: '$' },
  { id: 'sonnet', label: 'Sonnet', cost: '$$' },
  { id: 'opus', label: 'Opus', cost: '$$$' },
];

// Descrizioni in locales/<lingua>/run.json (inspector.tools.<nome>).
const TOOL_HINT = new Set(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent', 'TodoWrite']);

function Num({ value, onChange, step = 1, min = 0, placeholder, id }: { value?: number; onChange: (v?: number) => void; step?: number; min?: number; placeholder?: string; id?: string }) {
  return (
    <input id={id} type="number" step={step} min={min} value={value ?? ''} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
  );
}

function Issues({ issues }: { issues: ValidationIssue[] }) {
  const { tm } = useI18n();
  if (!issues.length) return null;
  return (
    <div className="issues">
      {issues.map((i, k) => (
        <div key={k} className={`callout ${i.level === 'errore' ? 'tone-bad' : 'tone-warn'}`}>
          {i.level === 'errore' ? <CircleAlert /> : <TriangleAlert />}<span>{tm(i.msg, i.message)}</span>
        </div>
      ))}
    </div>
  );
}

export function PhaseInspector({ cfg, issues, onChange, onDelete }: { cfg: PhaseConfig; issues: ValidationIssue[]; onChange: (c: PhaseConfig) => void; onDelete: () => void }) {
  const { t } = useI18n();
  const set = <K extends keyof PhaseConfig>(k: K, v: PhaseConfig[K]) => onChange({ ...cfg, [k]: v });
  const human = cfg.kind === 'approvazione';
  const server = cfg.kind === 'server';
  const agent = !human && !server;
  const known = ['', ...MODELS.map((m) => m.id)];
  const custom = Boolean(cfg.model) && !known.includes(cfg.model);
  const modelHint = (id: string) => t(`inspector.models.${id}`);
  const toolHint = (name: string) => (TOOL_HINT.has(name) ? t(`inspector.tools.${name}`) : name);

  return (
    <div className="inspector-inner">
      <div className="insp-head">
        <KindTile kind={cfg.kind} size="lg" />
        <div className="insp-titles">
          <input className="title-input" value={cfg.label} onChange={(e) => set('label', e.target.value)} aria-label={t('inspector.phaseName')} placeholder={t('inspector.phaseName')} />
          <select className="kind-select" value={cfg.kind} onChange={(e) => set('kind', e.target.value as PhaseKind)} aria-label={t('inspector.phaseKind')}>
            {(Object.keys(KIND_META) as PhaseKind[]).map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
          </select>
        </div>
      </div>
      <Issues issues={issues} />

      {server && (
        <Section title={t('inspector.server.title')}>
          <Field label={t('inspector.server.command')}><input id="srv-cmd" className="mono" value={cfg.command ?? ''} onChange={(e) => set('command', e.target.value)} placeholder="npm run dev" /></Field>
          <Field label={t('inspector.server.url')} hint={t('inspector.server.urlHint')}><input id="srv-url" value={cfg.url ?? ''} onChange={(e) => set('url', e.target.value)} placeholder="http://localhost:5173" /></Field>
          <div className="grid2">
            <Field label={t('inspector.server.subdir')}><input id="srv-sub" value={cfg.subdir ?? ''} onChange={(e) => set('subdir', e.target.value)} placeholder={t('inspector.server.subdirPlaceholder')} /></Field>
            <Field label={t('inspector.server.wait')}><Num id="srv-wait" value={cfg.readyTimeoutSec} onChange={(v) => set('readyTimeoutSec', v)} min={5} placeholder="90" /></Field>
          </div>
          <Field label={t('inspector.server.node')} hint={t('inspector.server.nodeHint')}><input id="srv-node" value={cfg.nodeVersion ?? ''} onChange={(e) => set('nodeVersion', e.target.value)} placeholder={t('inspector.server.nodePlaceholder')} /></Field>
          <p className="hint">{t('inspector.server.hint')}</p>
        </Section>
      )}

      {!server && (
        <Section title={human ? t('inspector.task.titleHuman') : t('inspector.task.title')}>
          {agent && <Field label={t('inspector.task.role')}><input value={cfg.role} onChange={(e) => set('role', e.target.value)} placeholder={t('inspector.task.rolePlaceholder')} /></Field>}
          <Field label={human ? t('inspector.task.instructionsHuman') : t('inspector.task.instructions')} hint={agent ? t('inspector.task.instructionsHint') : undefined}>
            <textarea rows={human ? 4 : 7} value={cfg.instructions} onChange={(e) => set('instructions', e.target.value)} />
          </Field>
        </Section>
      )}

      {agent && (
        <>
          <Section title={t('inspector.model.title')}>
            <div className="model-picker" role="radiogroup" aria-label={t('inspector.model.title')}>
              {MODELS.map((m) => (
                <button key={m.id} role="radio" aria-checked={cfg.model === m.id} className={`model-opt ${cfg.model === m.id ? 'on' : ''}`} onClick={() => set('model', m.id)} title={modelHint(m.id)}>
                  <span className="model-name">{m.label}</span><span className="model-cost">{m.cost}</span>
                </button>
              ))}
              <button role="radio" aria-checked={cfg.model === '' || custom} className={`model-opt ${cfg.model === '' || custom ? 'on' : ''}`} onClick={() => set('model', custom ? cfg.model : '')} title={t('inspector.model.otherHint')}>
                <span className="model-name">{t('inspector.model.other')}</span><span className="model-cost">…</span>
              </button>
            </div>
            <p className="hint">{MODELS.some((m) => m.id === cfg.model) ? modelHint(cfg.model) : t('inspector.model.defaultHint')}</p>
            {(cfg.model === '' || custom) && <Field label={t('inspector.model.id')}><input className="mono" value={cfg.model} onChange={(e) => set('model', e.target.value.trim())} placeholder={t('inspector.model.idPlaceholder')} /></Field>}
          </Section>

          <Section title={t('inspector.tools.title')} aside={<span className="muted small">{t('inspector.tools.active', { count: cfg.allowedTools.length })}</span>}>
            <div className="tool-chips">
              {KNOWN_TOOLS.map((tool) => {
                const on = cfg.allowedTools.includes(tool);
                const w = WRITE_TOOLS.includes(tool);
                return (
                  <button key={tool} className={`tool-chip ${on ? 'on' : ''} ${w ? 'write' : ''}`} aria-pressed={on} title={`${toolHint(tool)}${w ? ` — ${t('inspector.tools.canWrite')}` : ''}`}
                    onClick={() => set('allowedTools', on ? cfg.allowedTools.filter((x) => x !== tool) : [...cfg.allowedTools, tool])}>
                    {w ? <PencilLine /> : <Lock />}{tool}
                  </button>
                );
              })}
            </div>
            <p className="hint">{t('inspector.tools.hint')}</p>
          </Section>

          <Section title={t('inspector.limits.title')}>
            <div className="grid2">
              <Field label={t('inspector.limits.maxTurns')}><Num value={cfg.maxTurns} onChange={(v) => set('maxTurns', v)} min={1} placeholder={t('inspector.limits.none')} /></Field>
              <Field label={t('inspector.limits.maxBudget')}><Num value={cfg.maxBudgetUsd} onChange={(v) => set('maxBudgetUsd', v)} step={0.05} placeholder={t('inspector.limits.noneF')} /></Field>
            </div>
          </Section>

          <Section title={t('inspector.context.title')}>
            <Field label={t('inspector.context.label')}>
              <select value={cfg.contextMode} onChange={(e) => set('contextMode', e.target.value as PhaseConfig['contextMode'])}>
                <option value="sintesi">{t('inspector.context.sintesi')}</option>
                <option value="completo">{t('inspector.context.completo')}</option>
                <option value="nessuno">{t('inspector.context.nessuno')}</option>
              </select>
            </Field>
            <Switch checked={cfg.reuseResult} onChange={(v) => set('reuseResult', v)} label={t('inspector.context.reuse')} hint={t('inspector.context.reuseHint')} />
          </Section>
        </>
      )}

      <div className="insp-foot">
        <button className="btn ghost danger" onClick={onDelete}><Trash2 />{t('inspector.deletePhase')}</button>
      </div>
    </div>
  );
}

export function WorkflowSettingsForm({ wf, groups = [], onChange, onShowRules }: { wf: Workflow; groups?: string[]; onChange: (w: Workflow) => void; onShowRules: () => void }) {
  const { t, languages } = useI18n();
  const s = wf.settings;
  const set = <K extends keyof Workflow['settings']>(k: K, v: Workflow['settings'][K]) => onChange({ ...wf, settings: { ...s, [k]: v } });
  const lang = s.language ?? 'it';
  return (
    <div className="inspector-inner">
      <div className="insp-head">
        <span className="kind-tile kt-lg kind-workflow" aria-hidden><FileCode2 /></span>
        <div className="insp-titles">
          <input className="title-input" value={wf.name} onChange={(e) => onChange({ ...wf, name: e.target.value })} aria-label={t('settings.workflowName')} />
          <span className="muted small">{t('settings.subtitle')}</span>
        </div>
      </div>

      <Section title={t('settings.project.title')}>
        <Field label={t('settings.project.dir')}><input value={s.projectDir} onChange={(e) => set('projectDir', e.target.value)} placeholder={t('settings.project.dirPlaceholder')} /></Field>
        <FolderStatus path={s.projectDir} />
        <Field label={t('settings.project.goal')} hint={t('settings.project.goalHint')}>
          <textarea rows={5} value={s.goal} onChange={(e) => set('goal', e.target.value)} />
        </Field>
        <Field label={t('settings.project.description')}><textarea rows={2} value={wf.description} onChange={(e) => onChange({ ...wf, description: e.target.value })} /></Field>
        <Field label={t('manage.group')} hint={t('manage.groupHint')}>
          <input list="settings-groups" value={wf.group ?? ''} onChange={(e) => onChange({ ...wf, group: e.target.value || undefined })} placeholder={t('manage.groupPlaceholder')} />
          <datalist id="settings-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
        </Field>
      </Section>

      <Section title={t('settings.run.title')}>
        <div className="grid2">
          <Field label={t('settings.run.maxBudget')} hint={t('settings.run.maxBudgetHint')}><Num value={s.runBudgetUsd} onChange={(v) => set('runBudgetUsd', v)} step={0.1} placeholder={t('inspector.limits.noneF')} /></Field>
          <Field label={t('settings.run.parallel')}><Num value={s.maxParallel} onChange={(v) => set('maxParallel', v ?? 1)} min={1} /></Field>
        </div>
        <Field label={t('settings.run.agentLanguage')} hint={t('settings.run.agentLanguageHint')}>
          <select value={lang} onChange={(e) => set('language', e.target.value)}>
            {languages.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            {!languages.some((l) => l.code === lang) && <option value={lang}>{lang}</option>}
          </select>
        </Field>
      </Section>

      <Section title={t('settings.rules.title')} aside={<button className="btn sm ghost" onClick={onShowRules}><ScrollText />{t('settings.rules.show')}</button>}>
        <Switch checked={s.applyGeneralRules !== false} onChange={(v) => set('applyGeneralRules', v)} label={t('settings.rules.general')} hint={t('settings.rules.generalHint')} />
        <Switch checked={s.loadProjectSettings} onChange={(v) => set('loadProjectSettings', v)} label={t('settings.rules.projectSettings')} hint={t('settings.rules.projectSettingsHint')} />
      </Section>

      <p className="hint pad">{t('settings.edgesHint')}</p>
    </div>
  );
}
