import { FolderStatus } from './Setup.tsx';
import { KNOWN_TOOLS, WRITE_TOOLS, type PhaseConfig, type PhaseKind, type ValidationIssue, type Workflow } from '../../../shared/types.ts';
import { KIND_LABEL } from './Canvas.tsx';

const MODELS = ['', 'haiku', 'sonnet', 'opus'];

function Num({ value, onChange, step = 1, min = 0, placeholder }: { value?: number; onChange: (v?: number) => void; step?: number; min?: number; placeholder?: string }) {
  return (
    <input type="number" step={step} min={min} value={value ?? ''} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
  );
}

export function PhaseInspector({ cfg, issues, onChange, onDelete }: { cfg: PhaseConfig; issues: ValidationIssue[]; onChange: (c: PhaseConfig) => void; onDelete: () => void }) {
  const set = <K extends keyof PhaseConfig>(k: K, v: PhaseConfig[K]) => onChange({ ...cfg, [k]: v });
  const human = cfg.kind === 'approvazione';
  const server = cfg.kind === 'server';
  const customModel = cfg.model && !MODELS.includes(cfg.model);
  return (
    <div className="form">
      <h3>Fase</h3>
      {issues.map((i, k) => <div key={k} className={`issue ${i.level}`}>{i.level === 'errore' ? '✕' : '!'} {i.message}</div>)}
      <label>Nome<input value={cfg.label} onChange={(e) => set('label', e.target.value)} /></label>
      <label>Tipo
        <select value={cfg.kind} onChange={(e) => set('kind', e.target.value as PhaseKind)}>
          {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </label>
      {server && (
        <>
          <label>Comando da avviare
            <input id="srv-cmd" className="mono" value={cfg.command ?? ''} onChange={(e) => set('command', e.target.value)} placeholder="npm run dev" />
          </label>
          <label>URL da aprire (facoltativo)
            <input id="srv-url" value={cfg.url ?? ''} onChange={(e) => set('url', e.target.value)} placeholder="vuoto = primo indirizzo locale stampato dal server" />
          </label>
          <div className="row2">
            <label>Sottocartella (facoltativa)<input id="srv-sub" value={cfg.subdir ?? ''} onChange={(e) => set('subdir', e.target.value)} placeholder="es. web" /></label>
            <label>Attesa avvio (s)<Num value={cfg.readyTimeoutSec} onChange={(v) => set('readyTimeoutSec', v)} min={5} placeholder="90" /></label>
          </div>
          <label>Versione di Node (facoltativa)
            <input id="srv-node" value={cfg.nodeVersion ?? ''} onChange={(e) => set('nodeVersion', e.target.value)} placeholder="automatica da .nvmrc / engines (es. 24)" />
          </label>
          <p className="hint">Prima dell'avvio Regia sceglie la versione di Node richiesta dal progetto tra quelle installate (nvm, fnm, volta, sistema) e installa le dipendenze se mancano; se la versione giusta non c'è, propone di installarla. Regia esegue il comando nella cartella del progetto, aspetta che l'indirizzo risponda e tiene il server attivo fino alla fine dell'esecuzione: dal pannello puoi aprirlo, fermarlo o riavviarlo. Dopo una correzione richiesta in approvazione viene riavviato. In modalità di prova è simulato. Nessun costo: non usa agenti.</p>
        </>
      )}
      {!human && !server && <label>Ruolo dell'agente<input value={cfg.role} onChange={(e) => set('role', e.target.value)} placeholder="Es. Revisore attento alla sicurezza" /></label>}
      {!server && (
        <label>{human ? 'Cosa deve verificare la persona' : 'Istruzioni'}
          <textarea rows={6} value={cfg.instructions} onChange={(e) => set('instructions', e.target.value)} />
        </label>
      )}
      {!human && !server && (
        <>
          <label>Modello
            <select value={customModel ? '__custom' : cfg.model} onChange={(e) => set('model', e.target.value === '__custom' ? 'claude-' : e.target.value)}>
              <option value="">Predefinito della CLI</option>
              <option value="haiku">haiku — più economico</option>
              <option value="sonnet">sonnet — equilibrato</option>
              <option value="opus">opus — più capace e costoso</option>
              <option value="__custom">Id completo…</option>
            </select>
          </label>
          {customModel && <label>Id del modello<input value={cfg.model} onChange={(e) => set('model', e.target.value.trim())} /></label>}
          <fieldset>
            <legend>Strumenti consentiti</legend>
            <div className="tools">
              {KNOWN_TOOLS.map((t) => (
                <label key={t} className={`tool ${WRITE_TOOLS.includes(t) ? 'write' : ''}`}>
                  <input type="checkbox" checked={cfg.allowedTools.includes(t)}
                    onChange={(e) => set('allowedTools', e.target.checked ? [...cfg.allowedTools, t] : cfg.allowedTools.filter((x) => x !== t))} />
                  {t}
                </label>
              ))}
            </div>
            <p className="hint">Gli strumenti non selezionati non sono disponibili per l'agente. In rosso quelli che modificano file o eseguono comandi. "Agent" permette di avviare subagenti.</p>
          </fieldset>
          <div className="row2">
            <label>Max turni<Num value={cfg.maxTurns} onChange={(v) => set('maxTurns', v)} min={1} placeholder="nessun limite" /></label>
            <label>Limite fase (USD)<Num value={cfg.maxBudgetUsd} onChange={(v) => set('maxBudgetUsd', v)} step={0.05} placeholder="nessuno" /></label>
          </div>
          <label>Contesto dalle fasi precedenti
            <select value={cfg.contextMode} onChange={(e) => set('contextMode', e.target.value as PhaseConfig['contextMode'])}>
              <option value="sintesi">Sintesi dichiarata (consigliato)</option>
              <option value="completo">Testo finale completo</option>
              <option value="nessuno">Nessuno</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={cfg.reuseResult} onChange={(e) => set('reuseResult', e.target.checked)} />
            Riusa il risultato se istruzioni, input e file del progetto non sono cambiati
          </label>
        </>
      )}
      <button className="danger" onClick={onDelete}>Elimina fase</button>
    </div>
  );
}

export function WorkflowSettingsForm({ wf, onChange, onShowRules }: { wf: Workflow; onChange: (w: Workflow) => void; onShowRules: () => void }) {
  const s = wf.settings;
  const set = <K extends keyof Workflow['settings']>(k: K, v: Workflow['settings'][K]) => onChange({ ...wf, settings: { ...s, [k]: v } });
  return (
    <div className="form">
      <h3>Impostazioni workflow</h3>
      <label>Nome<input value={wf.name} onChange={(e) => onChange({ ...wf, name: e.target.value })} /></label>
      <label>Descrizione<textarea rows={2} value={wf.description} onChange={(e) => onChange({ ...wf, description: e.target.value })} /></label>
      <label>Cartella del progetto (percorso assoluto)
        <input value={s.projectDir} onChange={(e) => set('projectDir', e.target.value)} placeholder="C:\percorso\progetto" />
      </label>
      <FolderStatus path={s.projectDir} />
      <label>Obiettivo (incluso nel prompt di ogni fase)<textarea rows={4} value={s.goal} onChange={(e) => set('goal', e.target.value)} /></label>
      <div className="row2">
        <label>Limite di spesa per esecuzione (USD)
          <Num value={s.runBudgetUsd} onChange={(v) => set('runBudgetUsd', v)} step={0.1} placeholder="nessuno" />
        </label>
        <label>Fasi in parallelo<Num value={s.maxParallel} onChange={(v) => set('maxParallel', v ?? 1)} min={1} /></label>
      </div>
      <label className="check">
        <input type="checkbox" checked={s.loadProjectSettings} onChange={(e) => set('loadProjectSettings', e.target.checked)} />
        Carica CLAUDE.md e .claude/settings.json del progetto
      </label>
      <label className="check">
        <input type="checkbox" checked={s.applyGeneralRules !== false} onChange={(e) => set('applyGeneralRules', e.target.checked)} />
        Applica le regole generali a ogni fase
      </label>
      <button className="link" onClick={onShowRules}>Vedi e modifica le regole generali</button>
      <p className="hint">
        Il limite di spesa si applica alla stima calcolata dal SDK: la parte rimanente viene passata a ogni fase come <code>maxBudgetUsd</code>.
        Hook, plugin e impostazioni personali di ~/.claude non vengono caricati; le tue regole personali (CLAUDE.md) sì, tramite le regole generali.
      </p>
      <p className="hint">Seleziona una fase per configurarla. Collega le fasi trascinando dal punto destro di una fase al punto sinistro della successiva; seleziona un collegamento e premi Canc per rimuoverlo.</p>
    </div>
  );
}
