import { FileCode2, Lock, PencilLine, ScrollText, Trash2, TriangleAlert, CircleAlert } from 'lucide-react';
import { KNOWN_TOOLS, WRITE_TOOLS, type PhaseConfig, type PhaseKind, type ValidationIssue, type Workflow } from '../../../shared/types.ts';
import { Field, KIND_META, KindTile, Section, Switch } from '../ui.tsx';
import { FolderStatus } from './Setup.tsx';

const MODELS: { id: string; label: string; cost: string; hint: string }[] = [
  { id: 'haiku', label: 'Haiku', cost: '$', hint: 'Veloce ed economico: test, controlli, compiti semplici' },
  { id: 'sonnet', label: 'Sonnet', cost: '$$', hint: 'Equilibrato: la scelta giusta per la maggior parte delle fasi' },
  { id: 'opus', label: 'Opus', cost: '$$$', hint: 'Il più capace: compiti difficili, ragionamento lungo' },
];

const TOOL_HINT: Record<string, string> = {
  Read: 'Legge file', Glob: 'Cerca file per nome', Grep: 'Cerca testo nei file', Edit: 'Modifica file', Write: 'Crea o sovrascrive file',
  Bash: 'Esegue comandi', NotebookEdit: 'Modifica notebook', WebFetch: 'Scarica pagine web', WebSearch: 'Cerca sul web', Agent: 'Avvia subagenti', TodoWrite: 'Lista di attività',
};

function Num({ value, onChange, step = 1, min = 0, placeholder, id }: { value?: number; onChange: (v?: number) => void; step?: number; min?: number; placeholder?: string; id?: string }) {
  return (
    <input id={id} type="number" step={step} min={min} value={value ?? ''} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
  );
}

function Issues({ issues }: { issues: ValidationIssue[] }) {
  if (!issues.length) return null;
  return (
    <div className="issues">
      {issues.map((i, k) => (
        <div key={k} className={`callout ${i.level === 'errore' ? 'tone-bad' : 'tone-warn'}`}>
          {i.level === 'errore' ? <CircleAlert /> : <TriangleAlert />}<span>{i.message}</span>
        </div>
      ))}
    </div>
  );
}

export function PhaseInspector({ cfg, issues, onChange, onDelete }: { cfg: PhaseConfig; issues: ValidationIssue[]; onChange: (c: PhaseConfig) => void; onDelete: () => void }) {
  const set = <K extends keyof PhaseConfig>(k: K, v: PhaseConfig[K]) => onChange({ ...cfg, [k]: v });
  const human = cfg.kind === 'approvazione';
  const server = cfg.kind === 'server';
  const agent = !human && !server;
  const known = ['', ...MODELS.map((m) => m.id)];
  const custom = Boolean(cfg.model) && !known.includes(cfg.model);

  return (
    <div className="inspector-inner">
      <div className="insp-head">
        <KindTile kind={cfg.kind} size="lg" />
        <div className="insp-titles">
          <input className="title-input" value={cfg.label} onChange={(e) => set('label', e.target.value)} aria-label="Nome della fase" placeholder="Nome della fase" />
          <select className="kind-select" value={cfg.kind} onChange={(e) => set('kind', e.target.value as PhaseKind)} aria-label="Tipo di fase">
            {Object.entries(KIND_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
          </select>
        </div>
      </div>
      <Issues issues={issues} />

      {server && (
        <Section title="Server">
          <Field label="Comando da avviare"><input id="srv-cmd" className="mono" value={cfg.command ?? ''} onChange={(e) => set('command', e.target.value)} placeholder="npm run dev" /></Field>
          <Field label="Indirizzo da aprire" hint="Vuoto: il primo indirizzo locale stampato dal server."><input id="srv-url" value={cfg.url ?? ''} onChange={(e) => set('url', e.target.value)} placeholder="http://localhost:5173" /></Field>
          <div className="grid2">
            <Field label="Sottocartella"><input id="srv-sub" value={cfg.subdir ?? ''} onChange={(e) => set('subdir', e.target.value)} placeholder="es. web" /></Field>
            <Field label="Attesa avvio (s)"><Num id="srv-wait" value={cfg.readyTimeoutSec} onChange={(v) => set('readyTimeoutSec', v)} min={5} placeholder="90" /></Field>
          </div>
          <Field label="Versione di Node" hint="Vuoto: automatica da .nvmrc o engines del progetto."><input id="srv-node" value={cfg.nodeVersion ?? ''} onChange={(e) => set('nodeVersion', e.target.value)} placeholder="automatica" /></Field>
          <p className="hint">Regia sceglie la versione di Node giusta tra quelle installate, installa le dipendenze se mancano e tiene il server attivo fino alla fine dell'esecuzione. Nessun costo: non usa agenti.</p>
        </Section>
      )}

      {!server && (
        <Section title={human ? 'Cosa verificare' : 'Compito'}>
          {agent && <Field label="Ruolo"><input value={cfg.role} onChange={(e) => set('role', e.target.value)} placeholder="Es. Revisore attento alla sicurezza" /></Field>}
          <Field label={human ? 'Indicazioni per chi approva' : 'Istruzioni'} hint={agent ? 'Indica file e cartelle da guardare: meno contesto, meno costi.' : undefined}>
            <textarea rows={human ? 4 : 7} value={cfg.instructions} onChange={(e) => set('instructions', e.target.value)} />
          </Field>
        </Section>
      )}

      {agent && (
        <>
          <Section title="Modello">
            <div className="model-picker" role="radiogroup" aria-label="Modello">
              {MODELS.map((m) => (
                <button key={m.id} role="radio" aria-checked={cfg.model === m.id} className={`model-opt ${cfg.model === m.id ? 'on' : ''}`} onClick={() => set('model', m.id)} title={m.hint}>
                  <span className="model-name">{m.label}</span><span className="model-cost">{m.cost}</span>
                </button>
              ))}
              <button role="radio" aria-checked={cfg.model === '' || custom} className={`model-opt ${cfg.model === '' || custom ? 'on' : ''}`} onClick={() => set('model', custom ? cfg.model : '')} title="Modello predefinito della CLI, oppure un id completo">
                <span className="model-name">Altro</span><span className="model-cost">…</span>
              </button>
            </div>
            <p className="hint">{MODELS.find((m) => m.id === cfg.model)?.hint ?? 'Vuoto usa il modello predefinito di Claude Code; puoi anche indicare un id completo.'}</p>
            {(cfg.model === '' || custom) && <Field label="Id del modello (facoltativo)"><input className="mono" value={cfg.model} onChange={(e) => set('model', e.target.value.trim())} placeholder="predefinito" /></Field>}
          </Section>

          <Section title="Strumenti" aside={<span className="muted small">{cfg.allowedTools.length} attivi</span>}>
            <div className="tool-chips">
              {KNOWN_TOOLS.map((t) => {
                const on = cfg.allowedTools.includes(t);
                const w = WRITE_TOOLS.includes(t);
                return (
                  <button key={t} className={`tool-chip ${on ? 'on' : ''} ${w ? 'write' : ''}`} aria-pressed={on} title={`${TOOL_HINT[t] ?? t}${w ? ' — può modificare il progetto' : ''}`}
                    onClick={() => set('allowedTools', on ? cfg.allowedTools.filter((x) => x !== t) : [...cfg.allowedTools, t])}>
                    {w ? <PencilLine /> : <Lock />}{t}
                  </button>
                );
              })}
            </div>
            <p className="hint">Gli strumenti spenti non sono disponibili. Quelli con la matita possono modificare file o eseguire comandi.</p>
          </Section>

          <Section title="Limiti">
            <div className="grid2">
              <Field label="Turni massimi"><Num value={cfg.maxTurns} onChange={(v) => set('maxTurns', v)} min={1} placeholder="nessuno" /></Field>
              <Field label="Spesa massima ($)"><Num value={cfg.maxBudgetUsd} onChange={(v) => set('maxBudgetUsd', v)} step={0.05} placeholder="nessuna" /></Field>
            </div>
          </Section>

          <Section title="Contesto e riuso">
            <Field label="Cosa riceve dalle fasi precedenti">
              <select value={cfg.contextMode} onChange={(e) => set('contextMode', e.target.value as PhaseConfig['contextMode'])}>
                <option value="sintesi">La sintesi dichiarata (consigliato)</option>
                <option value="completo">Il testo finale completo</option>
                <option value="nessuno">Niente</option>
              </select>
            </Field>
            <Switch checked={cfg.reuseResult} onChange={(v) => set('reuseResult', v)} label="Riusa il risultato" hint="Se istruzioni, input e file del progetto non sono cambiati, non rifà la fase." />
          </Section>
        </>
      )}

      <div className="insp-foot">
        <button className="btn ghost danger" onClick={onDelete}><Trash2 />Elimina fase</button>
      </div>
    </div>
  );
}

export function WorkflowSettingsForm({ wf, onChange, onShowRules }: { wf: Workflow; onChange: (w: Workflow) => void; onShowRules: () => void }) {
  const s = wf.settings;
  const set = <K extends keyof Workflow['settings']>(k: K, v: Workflow['settings'][K]) => onChange({ ...wf, settings: { ...s, [k]: v } });
  return (
    <div className="inspector-inner">
      <div className="insp-head">
        <span className="kind-tile kt-lg kind-workflow" aria-hidden><FileCode2 /></span>
        <div className="insp-titles">
          <input className="title-input" value={wf.name} onChange={(e) => onChange({ ...wf, name: e.target.value })} aria-label="Nome del workflow" />
          <span className="muted small">Impostazioni del workflow · seleziona una fase per configurarla</span>
        </div>
      </div>

      <Section title="Progetto">
        <Field label="Cartella del progetto"><input value={s.projectDir} onChange={(e) => set('projectDir', e.target.value)} placeholder="C:\percorso\progetto" /></Field>
        <FolderStatus path={s.projectDir} />
        <Field label="Obiettivo" hint="Incluso nelle istruzioni di ogni fase. Scrivi anche quando il lavoro è finito.">
          <textarea rows={5} value={s.goal} onChange={(e) => set('goal', e.target.value)} />
        </Field>
        <Field label="Descrizione"><textarea rows={2} value={wf.description} onChange={(e) => onChange({ ...wf, description: e.target.value })} /></Field>
      </Section>

      <Section title="Esecuzione">
        <div className="grid2">
          <Field label="Spesa massima ($)" hint="Stima del SDK, per esecuzione."><Num value={s.runBudgetUsd} onChange={(v) => set('runBudgetUsd', v)} step={0.1} placeholder="nessuna" /></Field>
          <Field label="Fasi in parallelo"><Num value={s.maxParallel} onChange={(v) => set('maxParallel', v ?? 1)} min={1} /></Field>
        </div>
      </Section>

      <Section title="Regole e contesto" aside={<button className="btn sm ghost" onClick={onShowRules}><ScrollText />Vedi regole</button>}>
        <Switch checked={s.applyGeneralRules !== false} onChange={(v) => set('applyGeneralRules', v)} label="Applica le regole generali" hint="Le tue regole personali e quelle di Regia, in ogni fase." />
        <Switch checked={s.loadProjectSettings} onChange={(v) => set('loadProjectSettings', v)} label="Carica il CLAUDE.md del progetto" hint="E il file .claude/settings.json, se presente." />
      </Section>

      <p className="hint pad">Collega le fasi trascinando dal punto in basso di una al punto in alto della successiva. Seleziona un collegamento e premi Canc per rimuoverlo.</p>
    </div>
  );
}
