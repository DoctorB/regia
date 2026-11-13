import { useEffect, useState, type ReactNode } from 'react';
import { AppWindow, CircleCheck, Download, FolderPlus, Loader2, Globe, TextSearch, FileCode2, Info, Lock, PencilLine, RefreshCw, RotateCcw, ScrollText, Sparkles, Terminal, Trash2, TriangleAlert, CircleAlert, X } from 'lucide-react';
import { KNOWN_TOOLS, READY_CHECKS, WRITE_TOOLS, type LaunchPlan, type PhaseConfig, type ShowConfig, type PhaseKind, type ScrcpyStatus, type SkillInfo, type ValidationIssue, type Workflow, type WorkflowSettings } from '../../../shared/types.ts';
import { isCustomTools, PERMISSION_LEVELS, permissionLevel, toolsForLevel } from '../../../shared/permissions.ts';
import { phasePreset } from '../../../shared/presets.ts';
import { useI18n } from '../i18n.tsx';
import { Field, KIND_META, KindTile, Section, Switch, kindLabel } from '../ui.tsx';
import { FolderStatus } from './Setup.tsx';
import { StoryField } from './Story.tsx';
import { PrinciplePicker, PrinciplesPreview } from './Principles.tsx';
import { api } from '../api.ts';

const sourcesOf = (s: WorkflowSettings) => ({ project: s.skillSources?.project !== false, personal: s.skillSources?.personal === true });

/** Skill disponibili per le impostazioni del workflow (aggiornate quando cambiano cartella o fonti). */
function useSkills(s: WorkflowSettings) {
  const { project, personal } = sourcesOf(s);
  const [state, set] = useState<{ skills: SkillInfo[]; personalDir: string; loading: boolean }>({ skills: [], personalDir: '', loading: true });
  useEffect(() => {
    let alive = true;
    const h = setTimeout(() => {
      api.skills(s.projectDir, { project, personal })
        .then((r) => { if (alive) set({ ...r, loading: false }); })
        .catch(() => { if (alive) set({ skills: [], personalDir: '', loading: false }); });
    }, 250);
    return () => { alive = false; clearTimeout(h); };
  }, [s.projectDir, project, personal]);
  return state;
}

const skillName = (id: string) => id.replace(/^(progetto|personale):/, '');

function SkillsSection({ cfg, settings, onChange }: { cfg: PhaseConfig; settings: WorkflowSettings; onChange: (v: PhaseConfig['skills']) => void }) {
  const { t } = useI18n();
  const { skills, loading } = useSkills(settings);
  const mode = cfg.skills === 'all' ? 'all' : Array.isArray(cfg.skills) && cfg.skills.length ? 'chosen' : 'none';
  // "Scelte" resta visibile anche prima di spuntare la prima skill.
  const [picking, setPicking] = useState(mode === 'chosen');
  const shown = mode === 'all' ? 'all' : picking || mode === 'chosen' ? 'chosen' : 'none';
  const chosen = Array.isArray(cfg.skills) ? cfg.skills : [];
  const missing = chosen.filter((id) => !skills.some((s) => s.id === id));
  const toggle = (id: string) => onChange(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  const count = mode === 'all' ? skills.length : chosen.length;
  return (
    <Sub title={t('inspector.skills.title')} aside={<span className="muted small">{t('inspector.skills.active', { count })}</span>}>
      <div className="model-picker cols-3" role="radiogroup" aria-label={t('inspector.skills.title')}>
        {(['none', 'all', 'chosen'] as const).map((m) => (
          <button key={m} role="radio" aria-checked={shown === m} className={`model-opt ${shown === m ? 'on' : ''}`}
            onClick={() => { setPicking(m === 'chosen'); onChange(m === 'all' ? 'all' : m === 'none' ? undefined : chosen); }}>
            <span className="model-name">{t(`inspector.skills.mode.${m}`)}</span>
          </button>
        ))}
      </div>
      {loading ? <p className="hint">{t('inspector.skills.loading')}</p>
        : skills.length === 0 ? <p className="hint">{sourcesOf(settings).personal ? t('inspector.skills.emptyAll') : t('inspector.skills.empty')}</p>
        : shown === 'chosen' ? (
          <div className="skill-list">
            {skills.map((s) => (
              <label key={s.id} className={`skill-row ${chosen.includes(s.id) ? 'on' : ''}`} title={s.path}>
                <input type="checkbox" checked={chosen.includes(s.id)} onChange={() => toggle(s.id)} />
                <span className="skill-main">
                  <span className="skill-name"><Sparkles />{s.name}<span className="tag">{t(`inspector.skills.source.${s.source}`)}</span></span>
                  {s.description && <span className="skill-desc">{s.description}</span>}
                </span>
              </label>
            ))}
          </div>
        ) : shown === 'all' ? <p className="hint">{t('inspector.skills.allHint', { names: skills.map((s) => s.name).join(', ') })}</p>
        : <p className="hint">{t('inspector.skills.noneHint')}</p>}
      {!loading && missing.length > 0 && (
        <div className="tool-chips">
          {missing.map((id) => (
            <button key={id} className="tool-chip missing" onClick={() => toggle(id)} title={t('inspector.skills.removeMissing')}>
              <TriangleAlert />{skillName(id)}<X />
            </button>
          ))}
        </div>
      )}
      {shown !== 'none' && <p className="hint">{t('inspector.skills.hint')}</p>}
    </Sub>
  );
}

/** Gruppo di opzioni dentro la sezione Avanzate. */
function Sub({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="adv-sub">
      <div className="adv-sub-head"><h5>{title}</h5>{aside}</div>
      {children}
    </div>
  );
}

function SkillSourcesSection({ settings, onChange }: { settings: WorkflowSettings; onChange: (v: WorkflowSettings['skillSources']) => void }) {
  const { t } = useI18n();
  const src = sourcesOf(settings);
  const { skills, personalDir, loading } = useSkills(settings);
  const by = (source: SkillInfo['source']) => skills.filter((s) => s.source === source).length;
  return (
    <Section title={t('settings.skills.title')} aside={loading ? undefined : <span className="muted small">{t('settings.skills.found', { count: skills.length })}</span>}>
      <Switch checked={src.project} onChange={(v) => onChange({ ...src, project: v })} label={t('settings.skills.project')}
        hint={src.project && !loading ? t('settings.skills.projectHintCount', { count: by('progetto') }) : t('settings.skills.projectHint')} />
      <Switch checked={src.personal} onChange={(v) => onChange({ ...src, personal: v })} label={t('settings.skills.personal')}
        hint={src.personal && !loading ? t('settings.skills.personalHintCount', { count: by('personale'), dir: personalDir }) : t('settings.skills.personalHint')} />
      <p className="hint">{t('settings.skills.hint')}</p>
    </Section>
  );
}


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

/** Fase "mostra" (telefono, browser, desktop): cosa Regia ha rilevato e solo scelte facoltative. */
/** Mirror dello schermo nel collaudo: attivo di serie; se scrcpy manca, Regia lo installa con un clic (Windows, macOS con Homebrew). */
function MirrorRow({ on, onToggle, window: win, onWindow }: { on: boolean; onToggle: (v: boolean) => void; window: boolean; onWindow: (v: boolean) => void }) {
  const { t } = useI18n();
  const [st, setSt] = useState<ScrcpyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (win) api.scrcpy().then(setSt).catch(() => setSt(null)); }, [win]);
  const install = async () => {
    setBusy(true);
    setErr('');
    try { setSt(await api.installScrcpy()); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="mirror-row">
      <Switch checked={on} onChange={onToggle} label={t('inspector.show.mirror.label')} hint={t('inspector.show.mirror.hint')} />
      {on && <Switch checked={win} onChange={onWindow} label={t('inspector.show.mirror.window')} hint={t('inspector.show.mirror.windowHint')} />}
      {on && win && !st && <div className="folder-status muted"><Loader2 className="spin" />{t('inspector.show.mirror.checking')}</div>}
      {on && win && st?.installed && (
        <div className="folder-status"><div className="tone-good"><CircleCheck />{st.source === 'regia' ? t('inspector.show.mirror.foundRegia', { version: st.version ?? '' }) : t('inspector.show.mirror.found')}</div></div>
      )}
      {on && win && st && !st.installed && (
        <div className="callout tone-info mirror-missing">
          <Info />
          <span>{t(`inspector.show.mirror.missing.${st.install ?? 'manual'}`, { version: st.version ?? '' })}</span>
          {st.install !== 'manual' && (
            <button className="btn sm" disabled={busy} onClick={() => void install()}>{busy ? <Loader2 className="spin" /> : <Download />}{t(busy ? 'inspector.show.mirror.installing' : 'inspector.show.mirror.install')}</button>
          )}
        </div>
      )}
      {err && <div className="callout tone-warn"><TriangleAlert /><span>{err}</span></div>}
    </div>
  );
}

/** uat: nel collaudo il rilevamento è lo stesso, ma non si può trasformare in una fase Avvio app. */
function ShowSection({ cfg, settings, onChange, uat = false }: { cfg: PhaseConfig; settings: WorkflowSettings; onChange: (c: PhaseConfig) => void; uat?: boolean }) {
  const { t, tm } = useI18n();
  const s = cfg.show!;
  const [plan, setPlan] = useState<LaunchPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const h = setTimeout(() => {
      api.launchPlan(settings.projectDir, cfg.subdir ?? '', cfg.url ?? '', { target: s.target, platform: s.platform, device: s.device, build: s.build, browser: s.browser, existing: s.existing, noCompanion: s.noCompanion })
        .then((p) => { if (alive) setPlan(p); })
        .catch(() => { if (alive) setPlan(null); })
        .finally(() => { if (alive) setLoading(false); });
    }, 300);
    return () => { alive = false; clearTimeout(h); };
  }, [settings.projectDir, cfg.subdir, cfg.url, s.target, s.platform, s.device, s.build, s.browser, s.existing, s.noCompanion, tick]);

  const setS = (patch: Partial<ShowConfig>) => {
    const next: ShowConfig = { ...s, ...patch };
    for (const k of Object.keys(next) as (keyof ShowConfig)[]) if (k !== 'target' && !next[k]) delete next[k];
    onChange({ ...cfg, show: next });
  };
  // Via di fuga: diventa una normale fase Avvio app con il comando rilevato, modificabile a mano.
  const toCustom = () => {
    const { show, ...rest } = cfg;
    void show;
    const base = cfg.subdir?.trim().replace(/[\\/]+$/, '') ?? '';
    const dir = plan?.dir ? (base ? `${base}/${plan.dir}` : plan.dir) : base;
    onChange({
      ...rest, command: plan?.command ?? '', readyCheck: plan?.check ?? 'url', readyPattern: plan?.readyPattern?.replace(/^\/(.*)\/$/, '$1') || undefined,
      url: cfg.url || (plan?.url?.startsWith('http') ? plan.url : ''), subdir: dir, readyTimeoutSec: cfg.readyTimeoutSec ?? SHOW_WAIT[s.target],
    });
  };
  const platformName = (p: string) => (p === 'ios' ? 'iOS' : 'Android');
  const devices = plan?.devices ?? [];
  const buildDefault = plan?.build && !s.build ? t(`inspector.show.build.${plan.build}`) : '';
  const deviceText = (d: { name: string; platform: string; emulator: boolean }) =>
    `${d.name} · ${platformName(d.platform)}${d.emulator ? ` · ${t('inspector.show.emulator')}` : ''}`;
  const pending = loading ? '…' : '—';

  return (
    <Section title={t(`inspector.show.title.${s.target}`)} aside={<button className="btn sm ghost" onClick={() => setTick((x) => x + 1)} disabled={loading}><RefreshCw className={loading ? 'spin' : ''} />{t('inspector.show.refresh')}</button>}>
      <dl className="kv show-kv">
        {!(s.target === 'browser' && s.existing) && <><dt>{t('inspector.show.project')}</dt><dd>{plan?.project ? `${plan.project}${plan.dir ? ` · ${plan.dir}` : ''}` : pending}</dd></>}
        {s.target === 'dispositivo' && <><dt>{t('inspector.show.device')}</dt><dd>{plan?.device ? deviceText(plan.device) : pending}</dd></>}
        {plan?.command && <><dt>{t('inspector.show.command')}</dt><dd><code className="show-cmd">{plan.command}</code></dd></>}
        {s.target === 'browser' && plan?.url && <><dt>{t('inspector.show.address')}</dt><dd><code className="show-cmd">{plan.url}</code></dd></>}
        {plan?.companion && <><dt>{t('inspector.show.backend')}</dt><dd>{plan.companion.project} · {plan.companion.dir}{plan.companion.enabled ? <> <code className="show-cmd">{plan.companion.command}</code></> : ` · ${t('inspector.show.backendOff')}`}</dd></>}
      </dl>
      {!loading && plan?.problem && <div className="callout tone-warn"><TriangleAlert /><span>{tm(plan.problem)}</span></div>}
      {!loading && plan?.notes.map((n, i) => <div key={i} className="callout tone-info"><Info /><span>{tm(n)}</span></div>)}

      {s.target === 'dispositivo' && (
        <>
          <Field label={t('inspector.show.deviceChoice')}>
            <select value={s.device ?? ''} onChange={(e) => setS({ device: e.target.value || undefined })}>
              <option value="">{t('inspector.show.autoDevice')}</option>
              {devices.map((d) => <option key={d.id} value={d.id}>{deviceText(d)}</option>)}
              {s.device && !devices.some((d) => d.id === s.device) && <option value={s.device}>{s.device} ({t('inspector.show.notConnected')})</option>}
            </select>
          </Field>
          <div className="grid2">
            {(plan?.platforms?.length ?? 0) > 1 || s.platform ? (
              <Field label={t('inspector.show.platform')}>
                <select value={s.platform ?? ''} onChange={(e) => setS({ platform: (e.target.value || undefined) as ShowConfig['platform'], device: undefined })}>
                  <option value="">{t('inspector.show.auto')}</option>
                  <option value="android">Android</option>
                  <option value="ios">iOS</option>
                </select>
              </Field>
            ) : null}
            <Field label={t('inspector.show.buildLabel')}>
              <select value={s.build ?? ''} onChange={(e) => setS({ build: (e.target.value || undefined) as ShowConfig['build'] })}>
                <option value="">{buildDefault ? `${t('inspector.show.auto')} (${buildDefault})` : t('inspector.show.auto')}</option>
                <option value="debug">{t('inspector.show.build.debug')}</option>
                <option value="release">{t('inspector.show.build.release')}</option>
              </select>
            </Field>
          </div>
          {uat && <MirrorRow on={!s.noMirror} onToggle={(v) => setS({ noMirror: !v || undefined })} window={Boolean(s.mirrorWindow)} onWindow={(v) => setS({ mirrorWindow: v || undefined })} />}
        </>
      )}

      {s.target === 'browser' && (
        <>
          <Field label={t('inspector.show.what')}>
            <select value={s.existing ? 'existing' : ''} onChange={(e) => setS({ existing: e.target.value === 'existing' || undefined })}>
              <option value="">{t('inspector.show.whatProject')}</option>
              <option value="existing">{t('inspector.show.whatExisting')}</option>
            </select>
          </Field>
          {!s.existing && plan?.companion && (
            <Switch checked={!s.noCompanion} onChange={(v) => setS({ noCompanion: !v || undefined })} label={t('inspector.show.startBackend', { project: plan.companion.project, dir: plan.companion.dir })} hint={t('inspector.show.startBackendHint')} />
          )}
          <Field label={t('inspector.show.browser')}>
            <select value={s.browser ?? ''} onChange={(e) => setS({ browser: (e.target.value || undefined) as ShowConfig['browser'] })}>
              <option value="">{t('inspector.show.browserDefault')}</option>
              <option value="chrome">Chrome</option>
              <option value="edge">Edge</option>
              <option value="firefox">Firefox</option>
              <option value="safari">Safari</option>
            </select>
          </Field>
          <Field label={t('inspector.show.address')} hint={s.existing ? undefined : t('inspector.show.addressHint')}>
            <input value={cfg.url ?? ''} onChange={(e) => onChange({ ...cfg, url: e.target.value })} placeholder={s.existing ? 'http://localhost/miosito' : t('inspector.show.auto').toLowerCase()} />
          </Field>
        </>
      )}

      {!(s.target === 'browser' && s.existing) && (
        <details className="principles-preview">
          <summary>{t('inspector.show.more')}</summary>
          <div className="grid2">
            <Field label={t('inspector.server.subdir')}><input value={cfg.subdir ?? ''} onChange={(e) => onChange({ ...cfg, subdir: e.target.value })} placeholder={t('inspector.show.auto').toLowerCase()} /></Field>
            <Field label={t('inspector.server.wait')}><Num value={cfg.readyTimeoutSec} onChange={(v) => onChange({ ...cfg, readyTimeoutSec: v })} min={5} placeholder={String(SHOW_WAIT[s.target])} /></Field>
          </div>
          {!uat && <button className="btn sm ghost" onClick={toCustom}><Terminal />{t('inspector.show.custom')}</button>}
        </details>
      )}
      <p className="hint">{uat ? t('inspector.show.hint.uat') : t(`inspector.show.hint.${s.target}`)}</p>
    </Section>
  );
}

const SHOW_WAIT: Record<ShowConfig['target'], number> = { dispositivo: 1200, browser: 180, desktop: 600 };

export function PhaseInspector({ cfg, settings, issues, onChange, onDelete }: { cfg: PhaseConfig; settings: WorkflowSettings; issues: ValidationIssue[]; onChange: (c: PhaseConfig) => void; onDelete: () => void }) {
  const { t } = useI18n();
  const set = <K extends keyof PhaseConfig>(k: K, v: PhaseConfig[K]) => onChange({ ...cfg, [k]: v });
  const human = cfg.kind === 'approvazione';
  const server = cfg.kind === 'server';
  const agent = !human && !server;
  const check = cfg.readyCheck ?? 'url';
  const known = ['', ...MODELS.map((m) => m.id)];
  const custom = Boolean(cfg.model) && !known.includes(cfg.model);
  const modelHint = (id: string) => t(`inspector.models.${id}`);
  const toolHint = (name: string) => (TOOL_HINT.has(name) ? t(`inspector.tools.${name}`) : name);
  const level = permissionLevel(cfg.allowedTools);
  const customTools = isCustomTools(cfg.allowedTools);
  const [advOpen, setAdvOpen] = useState(false);
  // Valori consigliati per il tipo di fase: il riepilogo di Avanzate elenca solo ciò che se ne discosta.
  const base = phasePreset(cfg.kind, t);
  const sameTools = base.allowedTools.length === cfg.allowedTools.length && base.allowedTools.every((x) => cfg.allowedTools.includes(x));
  const skillCount = cfg.skills === 'all' ? -1 : Array.isArray(cfg.skills) ? cfg.skills.length : 0;
  const advDiffs = [
    !sameTools && t('inspector.advanced.diff.tools', { count: cfg.allowedTools.length }),
    skillCount === -1 ? t('inspector.advanced.diff.skillsAll') : skillCount > 0 && t('inspector.advanced.diff.skills', { count: skillCount }),
    cfg.maxTurns !== base.maxTurns && (cfg.maxTurns ? t('inspector.advanced.diff.turns', { count: cfg.maxTurns }) : t('inspector.advanced.diff.noTurns')),
    cfg.contextMode !== base.contextMode && t(`inspector.advanced.diff.context.${cfg.contextMode}`),
    cfg.reuseResult !== base.reuseResult && t(cfg.reuseResult ? 'inspector.advanced.diff.reuseOn' : 'inspector.advanced.diff.reuseOff'),
  ].filter((x): x is string => Boolean(x));

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

      {server && cfg.show && <ShowSection cfg={cfg} settings={settings} onChange={onChange} />}
      {cfg.kind === 'collaudo' && <ShowSection cfg={cfg.show ? cfg : { ...cfg, show: { target: 'dispositivo' } }} settings={settings} onChange={onChange} uat />}

      {server && !cfg.show && (
        <Section title={t('inspector.server.title')}>
          <Field label={t('inspector.server.readyCheck')}>
            <div className="ready-picker" role="radiogroup" aria-label={t('inspector.server.readyCheck')}>
              {READY_CHECKS.map((c) => (
                <button key={c} role="radio" aria-checked={check === c} className={`ready-opt ${check === c ? 'on' : ''}`} onClick={() => set('readyCheck', c)}>
                  <span className="ready-icon">{c === 'url' ? <Globe /> : c === 'output' ? <TextSearch /> : c === 'process' ? <AppWindow /> : <CircleCheck />}</span>
                  <span className="ready-text"><strong>{t(`inspector.server.ready.${c}.label`)}</strong><small>{t(`inspector.server.ready.${c}.hint`)}</small></span>
                </button>
              ))}
            </div>
          </Field>
          <Field label={t('inspector.server.command')} hint={check === 'url' ? `${t('inspector.server.commandHint')} ${t('inspector.server.commandHintUrl')}` : t('inspector.server.commandHint')}>
            <input id="srv-cmd" className="mono" value={cfg.command ?? ''} onChange={(e) => set('command', e.target.value)} placeholder={check === 'process' ? 'dotnet run' : check === 'output' ? 'flutter run' : check === 'exit' ? 'msbuild /t:Build' : t('inspector.server.commandPlaceholderUrl')} />
          </Field>
          {check === 'output' && (
            <Field label={t('inspector.server.pattern')} hint={t('inspector.server.patternHint')}>
              <input id="srv-pattern" className="mono" value={cfg.readyPattern ?? ''} onChange={(e) => set('readyPattern', e.target.value)} placeholder="Flutter run key commands" />
            </Field>
          )}
          <Field label={t('inspector.server.url')} hint={check === 'url' ? t('inspector.server.urlHint') : t('inspector.server.urlHintOther')}>
            <input id="srv-url" value={cfg.url ?? ''} onChange={(e) => set('url', e.target.value)} placeholder={check === 'url' ? 'http://localhost:5173' : ''} />
          </Field>
          <div className="grid2">
            <Field label={t('inspector.server.subdir')}><input id="srv-sub" value={cfg.subdir ?? ''} onChange={(e) => set('subdir', e.target.value)} placeholder={t('inspector.server.subdirPlaceholder')} /></Field>
            <Field label={t('inspector.server.wait')}><Num id="srv-wait" value={cfg.readyTimeoutSec} onChange={(v) => set('readyTimeoutSec', v)} min={5} placeholder={check === 'exit' ? '600' : '90'} /></Field>
          </div>
          {Boolean(cfg.command?.trim()) && (
            <Field label={t('inspector.server.node')} hint={t('inspector.server.nodeHint')}><input id="srv-node" value={cfg.nodeVersion ?? ''} onChange={(e) => set('nodeVersion', e.target.value)} placeholder={t('inspector.server.nodePlaceholder')} /></Field>
          )}
          <p className="hint">{t('inspector.server.hint')}</p>
        </Section>
      )}

      {!server && (
        <Section title={human ? t('inspector.task.titleHuman') : t('inspector.task.title')}>
          {agent && <Field label={t('inspector.task.role')}><input value={cfg.role} onChange={(e) => set('role', e.target.value)} placeholder={t('inspector.task.rolePlaceholder')} /></Field>}
          <Field label={human ? t('inspector.task.instructionsHuman') : t('inspector.task.instructions')} hint={agent ? t('inspector.task.instructionsHint') : undefined}>
            <textarea rows={human ? 4 : 7} value={cfg.instructions} onChange={(e) => set('instructions', e.target.value)} />
          </Field>
          <PrinciplesPreview value={settings.principles} kind={cfg.kind} />
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

          {cfg.kind === 'collaudo' ? (
            <Section title={t('inspector.permissions.title')}>
              <p className="hint">{t('inspector.permissions.collaudo')}</p>
            </Section>
          ) : (
          <Section title={t('inspector.permissions.title')}>
            <div className="model-picker perm-picker" role="radiogroup" aria-label={t('inspector.permissions.title')}>
              {PERMISSION_LEVELS.map((lv) => (
                <button key={lv} role="radio" aria-checked={level === lv} className={`model-opt ${level === lv ? 'on' : ''}`}
                  onClick={() => set('allowedTools', toolsForLevel(cfg.allowedTools, lv))}>
                  <span className="model-name">{t(`inspector.permissions.${lv}`)}</span>
                </button>
              ))}
            </div>
            <p className="hint">{t(`inspector.permissions.hint.${level}`)}{customTools ? ` ${t('inspector.permissions.custom')}` : ''}</p>
          </Section>
          )}

          {/* Opzioni tecniche: chiuse, con il riepilogo di ciò che non è al valore consigliato per il tipo di fase. */}
          <details className="section advanced-section" open={advOpen} onToggle={(e) => setAdvOpen((e.target as HTMLDetailsElement).open)}>
            <summary className="section-head">
              <h4>{t('inspector.advanced.title')}</h4>
              <span className="muted small adv-summary">{advDiffs.length ? advDiffs.join(' · ') : t('inspector.advanced.defaults')}</span>
            </summary>
            <div className="section-body">
            <Sub title={t('inspector.tools.title')} aside={<span className="muted small">{t('inspector.tools.active', { count: cfg.allowedTools.length })}</span>}>
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
            </Sub>

            <SkillsSection cfg={cfg} settings={settings} onChange={(v) => set('skills', v)} />

            <Sub title={t('inspector.limits.title')}>
              <div className="grid2">
                <Field label={t('inspector.limits.maxTurns')}><Num value={cfg.maxTurns} onChange={(v) => set('maxTurns', v)} min={1} placeholder={t('inspector.limits.none')} /></Field>
              </div>
            </Sub>

            <Sub title={t('inspector.context.title')}>
              <Field label={t('inspector.context.label')}>
                <select value={cfg.contextMode} onChange={(e) => set('contextMode', e.target.value as PhaseConfig['contextMode'])}>
                  <option value="sintesi">{t('inspector.context.sintesi')}</option>
                  <option value="completo">{t('inspector.context.completo')}</option>
                  <option value="nessuno">{t('inspector.context.nessuno')}</option>
                </select>
              </Field>
              <Switch checked={cfg.reuseResult} onChange={(v) => set('reuseResult', v)} label={t('inspector.context.reuse')} hint={t('inspector.context.reuseHint')} />
            </Sub>
            {advDiffs.length > 0 && (
              <button className="btn sm ghost adv-reset" onClick={() => onChange({ ...cfg, allowedTools: base.allowedTools, skills: base.skills, maxTurns: base.maxTurns, contextMode: base.contextMode, reuseResult: base.reuseResult })}>
                <RotateCcw />{t('inspector.advanced.reset')}
              </button>
            )}
            </div>
          </details>
        </>
      )}

      <div className="insp-foot">
        <button className="btn ghost danger" onClick={onDelete}><Trash2 />{t('inspector.deletePhase')}</button>
      </div>
    </div>
  );
}

/** Cartelle in cui le fasi possono lavorare oltre a quella del progetto. */
function ExtraDirs({ dirs, onChange }: { dirs: string[]; onChange: (v: string[]) => void }) {
  const { t } = useI18n();
  const setAt = (i: number, v: string) => onChange(dirs.map((d, j) => (j === i ? v : d)));
  return (
    <Field label={t('settings.project.extraDirs')} hint={t('settings.project.extraDirsHint')}>
      <div className="extra-dirs">
        {dirs.map((d, i) => (
          <div key={i} className="extra-dir">
            <div className="extra-dir-row">
              <input value={d} onChange={(e) => setAt(i, e.target.value)} placeholder={t('settings.project.extraDirPlaceholder')} aria-label={t('settings.project.extraDirs')} />
              <button className="icon-btn ghost" onClick={() => onChange(dirs.filter((_, j) => j !== i))} title={t('settings.project.extraDirRemove')} aria-label={t('settings.project.extraDirRemove')}><X /></button>
            </div>
            {d.trim() && <FolderStatus path={d} compact />}
          </div>
        ))}
        <button className="btn sm ghost" onClick={() => onChange([...dirs, ''])}><FolderPlus />{t('settings.project.extraDirAdd')}</button>
      </div>
    </Field>
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
        <ExtraDirs dirs={s.extraDirs ?? []} onChange={(v) => set('extraDirs', v.length ? v : undefined)} />
        <Field label={t('settings.project.goal')} hint={t('settings.project.goalHint')}>
          <textarea id="wf-goal" rows={5} value={s.goal} onChange={(e) => set('goal', e.target.value)} />
        </Field>
        <StoryField value={s.story ?? ''} onChange={(v) => set('story', v.trim() ? v : undefined)} />
        <Field label={t('settings.project.description')}><textarea rows={2} value={wf.description} onChange={(e) => onChange({ ...wf, description: e.target.value })} /></Field>
        <Field label={t('manage.group')} hint={t('manage.groupHint')}>
          <input list="settings-groups" value={wf.group ?? ''} onChange={(e) => onChange({ ...wf, group: e.target.value || undefined })} placeholder={t('manage.groupPlaceholder')} />
          <datalist id="settings-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
        </Field>
      </Section>

      <Section title={t('settings.run.title')}>
        <div className="grid2">
          <Field label={t('settings.run.parallel')}><Num value={s.maxParallel} onChange={(v) => set('maxParallel', v ?? 1)} min={1} /></Field>
        </div>
        <Switch checked={Boolean(s.referenceRun)} onChange={(v) => set('referenceRun', v || undefined)} label={t('settings.run.reference')} hint={t('settings.run.referenceHint')} />
        <Field label={t('settings.run.agentLanguage')} hint={t('settings.run.agentLanguageHint')}>
          <select value={lang} onChange={(e) => set('language', e.target.value)}>
            {languages.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
            {!languages.some((l) => l.code === lang) && <option value={lang}>{lang}</option>}
          </select>
        </Field>
      </Section>

      <Section title={t('principles.title')}>
        <p className="hint">{t('principles.hint')}</p>
        <PrinciplePicker value={s.principles} onChange={(v) => set('principles', v)} />
      </Section>

      <Section title={t('settings.rules.title')} aside={<button className="btn sm ghost" onClick={onShowRules}><ScrollText />{t('settings.rules.show')}</button>}>
        <Switch checked={s.applyGeneralRules !== false} onChange={(v) => set('applyGeneralRules', v)} label={t('settings.rules.general')} hint={t('settings.rules.generalHint')} />
        <Switch checked={s.loadProjectSettings} onChange={(v) => set('loadProjectSettings', v)} label={t('settings.rules.projectSettings')} hint={t('settings.rules.projectSettingsHint')} />
      </Section>

      <SkillSourcesSection settings={s} onChange={(v) => set('skillSources', v)} />

      <p className="hint pad">{t('settings.edgesHint')}</p>
    </div>
  );
}
