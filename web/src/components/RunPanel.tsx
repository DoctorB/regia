import { useEffect, useMemo, useRef, useState } from 'react';
import { isAgentKind, type EventKind, type HumanAction, type Insight, type Run } from '../../../shared/types.ts';
import { api, fmtDur, fmtUsd, runDuration } from '../api.ts';
import { SERVICE_LABEL, STATUS } from './Canvas.tsx';
import { UsageView } from './UsageView.tsx';
import { AppliedRulesView } from './Setup.tsx';

const RUN_STATUS: Record<Run['status'], string> = {
  in_corso: 'In corso', attesa_intervento: 'In attesa di un tuo intervento', completata: 'Completata', fallita: 'Fallita', annullata: 'Annullata', interrotta: 'Interrotta',
};
const ACTION_LABEL: Record<HumanAction, string> = {
  approva: 'Approva', respingi: 'Respingi con commento', riprova: 'Riprova da capo', riprendi: 'Riprendi la sessione', salta: 'Salta la fase', annulla: 'Annulla esecuzione',
  installa_node: 'Installa Node e riprova', installa_dipendenze: 'Installa le dipendenze e riprova',
};
const ACTION_HELP: Partial<Record<HumanAction, string>> = {
  riprova: 'Nuova sessione con le stesse istruzioni.',
  riprendi: 'Continua la stessa sessione dell\'agente con il tuo messaggio (mantiene il contesto).',
  salta: 'Le fasi successive partono senza il risultato di questa.',
  installa_node: 'Scarica la versione di Node indicata sopra con il gestore di versioni installato; la versione di sistema non cambia.',
  installa_dipendenze: 'Esegue il comando di installazione indicato sopra nella cartella del progetto.',
  respingi: 'La fase che ha prodotto il lavoro riprende la sua sessione con il tuo commento; le fasi intermedie vengono rieseguite.',
};
const KIND_LABEL: Record<EventKind, string> = {
  run: 'Esecuzione', fase: 'Fase', testo: 'Testo', decisione: 'Decisione', strumento: 'Strumento', esito_strumento: 'Esito strumento',
  subagente: 'Subagente', consumi: 'Consumi', risultato: 'Risultato', errore: 'Errore', intervento: 'Intervento', limite: 'Limite', servizio: 'Server',
};

type Tab = 'stato' | 'eventi' | 'decisioni' | 'consumi' | 'ottimizza';

export function RunPanel({ run, selectedNode, onSelectNode, onContinue }: { run: Run; selectedNode: string | null; onSelectNode: (id: string | null) => void; onContinue?: () => void }) {
  const [tab, setTab] = useState<Tab>('stato');
  const pending = Object.values(run.nodes).filter((n) => n.pendingActions?.length);
  useEffect(() => { if (pending.length) setTab('stato'); }, [pending.length]);
  const label = (id?: string) => run.snapshot.nodes.find((n) => n.id === id)?.data.label ?? id ?? '';
  const live = run.status === 'in_corso' || run.status === 'attesa_intervento';
  const [, force] = useState(0);
  useEffect(() => { if (!live) return; const t = setInterval(() => force((x) => x + 1), 1000); return () => clearInterval(t); }, [live]);

  return (
    <div className="runpanel">
      <div className="run-head">
        <div>
          <div className={`run-status rs-${run.status}`}>{RUN_STATUS[run.status]}</div>
          <div className="muted small">
            {run.mode === 'prova' ? 'Modalità di prova — dati simulati, nessun costo' : 'Esecuzione reale'} · {fmtDur(runDuration(run))}
            {run.continuedFrom && <> · continua da {run.continuedFrom}</>}
          </div>
        </div>
        <div className="run-cost">
          <div className="mono big">{fmtUsd(run.totals.costUsd)}</div>
          <div className="muted small">{run.mode === 'prova' ? 'costo simulato' : 'stima del SDK'}{run.budgetUsd ? ` / limite ${fmtUsd(run.budgetUsd, 2)}` : ''}</div>
        </div>
        {live && <button className="danger small-btn" onClick={() => api.cancel(run.id)}>Annulla</button>}
        {!live && onContinue && <button className="small-btn" onClick={onContinue} title="Nuova esecuzione con il workflow attuale: le fasi già completate e invariate vengono riprese senza rieseguirle">Continua…</button>}
      </div>
      <div className="tabs" role="tablist">
        {([['stato', `Stato${pending.length ? ` (${pending.length})` : ''}`], ['eventi', 'Eventi'], ['decisioni', 'Decisioni'], ['consumi', 'Consumi'], ['ottimizza', 'Ottimizzazioni']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      <div className="tab-body">
        {tab === 'stato' && <StatusTab run={run} label={label} onSelectNode={onSelectNode} />}
        {tab === 'eventi' && <EventsTab run={run} label={label} selectedNode={selectedNode} onSelectNode={onSelectNode} />}
        {tab === 'decisioni' && <DecisionsTab run={run} label={label} selectedNode={selectedNode} />}
        {tab === 'consumi' && <UsageView run={run} />}
        {tab === 'ottimizza' && <InsightsTab run={run} label={label} />}
      </div>
    </div>
  );
}

function StatusTab({ run, label, onSelectNode }: { run: Run; label: (id?: string) => string; onSelectNode: (id: string) => void }) {
  return (
    <div>
      {Object.values(run.nodes).filter((n) => n.pendingActions?.length).map((n) => <InterventionCard key={n.nodeId} run={run} nodeId={n.nodeId} label={label(n.nodeId)} />)}
      {Object.values(run.nodes)
        .filter((n) => n.service && !n.pendingActions?.length)
        // Già mostrato dentro la richiesta di approvazione che lo segue.
        .filter((n) => !run.snapshot.edges.some((e) => e.source === n.nodeId && run.nodes[e.target]?.pendingActions?.includes('approva')))
        .map((n) => <ServiceCard key={n.nodeId} run={run} nodeId={n.nodeId} />)}
      {run.notes.map((n, i) => <div key={i} className="issue avviso">! {n}</div>)}
      <AppliedRulesView rules={run.rules} />
      {run.rateLimit && (
        <div className="issue info">Limiti dell'abbonamento: stato {run.rateLimit.status}{run.rateLimit.type ? ` (${run.rateLimit.type})` : ''}{run.rateLimit.utilization !== undefined ? `, utilizzo ${Math.round(run.rateLimit.utilization * 100)}%` : ''}.</div>
      )}
      <table className="tbl">
        <thead><tr><th>Fase</th><th>Stato</th><th>Tentativi</th><th className="num">Costo</th></tr></thead>
        <tbody>
          {run.snapshot.nodes.map((n) => {
            const s = run.nodes[n.id];
            const st = STATUS[s.status];
            return (
              <tr key={n.id} className="clickable" onClick={() => onSelectNode(n.id)}>
                <td>{n.data.label}{s.activity && <div className="muted small ellipsis">{s.activity}</div>}</td>
                <td><span className={`badge ${st.cls}`}><span aria-hidden>{st.icon}</span> {st.label}</span></td>
                <td>{s.attempts.length || '—'}</td>
                <td className="num mono">{!isAgentKind(n.data.kind) ? '—' : fmtUsd(s.attempts.reduce((x, a) => x + (a.usage.costUsd ?? 0), 0))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function InterventionCard({ run, nodeId, label }: { run: Run; nodeId: string; label: string }) {
  const n = run.nodes[nodeId];
  const [fb, setFb] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const isApproval = run.snapshot.nodes.find((x) => x.id === nodeId)?.data.kind === 'approvazione';
  const preds = run.snapshot.edges.filter((e) => e.target === nodeId).map((e) => run.nodes[e.source]);
  const act = async (a: HumanAction) => {
    if (a === 'annulla' && !confirm('Annullare l\'esecuzione?')) return;
    setBusy(true); setErr('');
    try { await api.action(run.id, nodeId, a, fb); setFb(''); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="card intervention">
      <div className="card-title">✋ {label}</div>
      {n.pendingReason && <p className="small pre">{n.pendingReason}</p>}
      {isApproval && preds.map((p) => {
        const last = p.attempts.at(-1);
        if (p.service) return <ServiceCard key={p.nodeId} run={run} nodeId={p.nodeId} />;
        return (
          <div key={p.nodeId} className="pred-summary">
            <strong>{run.snapshot.nodes.find((x) => x.id === p.nodeId)?.data.label}</strong>
            {last?.declared && <span className={`badge ${last.declared.esito === 'ok' ? 'st-good' : 'st-critical'}`}>esito {last.declared.esito}</span>}
            <p className="small pre">{p.output ?? '(nessun risultato)'}</p>
          </div>
        );
      })}
      {(n.pendingActions?.includes('respingi') || n.pendingActions?.includes('riprendi')) && (
        <textarea rows={3} placeholder={isApproval ? 'Commento (obbligatorio per respingere)' : 'Messaggio per l\'agente (per "Riprendi")'} value={fb} onChange={(e) => setFb(e.target.value)} />
      )}
      <div className="actions">
        {n.pendingActions!.map((a) => (
          <button key={a} disabled={busy} className={a === 'approva' ? 'primary' : a === 'annulla' ? 'danger' : ''} title={ACTION_HELP[a]} onClick={() => act(a)}>{ACTION_LABEL[a]}</button>
        ))}
      </div>
      {err && <div className="issue errore">{err}</div>}
    </div>
  );
}

/** Server locale avviato da Regia: link, stato, azioni e ultime righe di log. */
function ServiceCard({ run, nodeId }: { run: Run; nodeId: string }) {
  const n = run.nodes[nodeId];
  const svc = n.service!;
  const label = run.snapshot.nodes.find((x) => x.id === nodeId)?.data.label ?? nodeId;
  const [err, setErr] = useState('');
  const live = run.status === 'in_corso' || run.status === 'attesa_intervento';
  const up = svc.status === 'attivo' || svc.status === 'simulato';
  const act = async (a: 'ferma' | 'riavvia') => {
    setErr('');
    try { await api.serviceAction(run.id, nodeId, a); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className={`card service svc-${svc.status}`}>
      <div className="card-title">🌐 {label} <span className="badge">{SERVICE_LABEL[svc.status]}</span></div>
      {up && svc.url && <div className="svc-url"><a href={svc.url} target="_blank" rel="noreferrer">{svc.url}</a> <span className="muted small">si apre in una nuova scheda</span></div>}
      <div className="muted small mono">{svc.command}{svc.pid ? ` · PID ${svc.pid}` : ''}{svc.exitCode !== undefined && svc.exitCode !== null ? ` · uscita ${svc.exitCode}` : ''}</div>
      {live && (
        <div className="actions">
          {up && <button onClick={() => act('ferma')}>Ferma</button>}
          {svc.status !== 'avvio' && <button onClick={() => act('riavvia')}>{up ? 'Riavvia' : 'Avvia di nuovo'}</button>}
        </div>
      )}
      {!live && <p className="muted small">Fermato a fine esecuzione.</p>}
      {svc.log.length > 0 && (
        <details className="svc-log">
          <summary className="small">Output ({svc.log.length} righe)</summary>
          <pre>{svc.log.slice(-60).join('\n')}</pre>
        </details>
      )}
      {err && <div className="issue errore">{err}</div>}
    </div>
  );
}

function EventsTab({ run, label, selectedNode, onSelectNode }: { run: Run; label: (id?: string) => string; selectedNode: string | null; onSelectNode: (id: string | null) => void }) {
  const [hidden, setHidden] = useState<Set<EventKind>>(new Set(['esito_strumento']));
  const [showSub, setShowSub] = useState(true);
  const [follow, setFollow] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const events = useMemo(() => run.events.filter((e) => !hidden.has(e.kind) && (!selectedNode || e.nodeId === selectedNode) && (showSub || !e.subagent)), [run.events, hidden, selectedNode, showSub]);
  useEffect(() => { if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [events.length, follow]);
  const kinds = Object.keys(KIND_LABEL) as EventKind[];
  return (
    <div className="events-wrap">
      <div className="filters">
        {selectedNode && <button className="chip-btn on" onClick={() => onSelectNode(null)}>Fase: {label(selectedNode)} ✕</button>}
        {kinds.map((k) => (
          <button key={k} className={`chip-btn ${hidden.has(k) ? '' : 'on'}`} onClick={() => { const h = new Set(hidden); if (h.has(k)) h.delete(k); else h.add(k); setHidden(h); }}>{KIND_LABEL[k]}</button>
        ))}
        <label className="check small"><input type="checkbox" checked={showSub} onChange={(e) => setShowSub(e.target.checked)} /> subagenti</label>
        <label className="check small"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> segui</label>
      </div>
      <div className="events" ref={ref}>
        {events.length === 0 && <p className="muted">Nessun evento.</p>}
        {events.map((e) => (
          <div key={e.seq} className={`ev ev-${e.kind}`}>
            <span className="ev-time mono">{new Date(e.ts).toLocaleTimeString('it-IT')}</span>
            <span className="ev-kind">{KIND_LABEL[e.kind]}{e.subagent ? ' · sub' : ''}</span>
            {e.nodeId && <span className="ev-node">{label(e.nodeId)}</span>}
            <span className="ev-text pre">{e.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DecisionsTab({ run, label, selectedNode }: { run: Run; label: (id?: string) => string; selectedNode: string | null }) {
  const decisions = run.events.filter((e) => e.kind === 'decisione' && (!selectedNode || e.nodeId === selectedNode));
  return (
    <div>
      <p className="hint">
        <strong>Dichiarate</strong>: spiegazioni brevi che l'agente scrive esplicitamente (righe "DECISIONE:" e blocco di esito finale).
        <strong> Osservate</strong>: dedotte da azioni visibili (file modificati, comandi eseguiti, subagenti avviati, strumenti negati).
        Il ragionamento interno del modello non è accessibile e non viene mostrato.
      </p>
      {decisions.length === 0 && <p className="muted">Nessuna decisione registrata{selectedNode ? ' per questa fase' : ''}.</p>}
      <ul className="decisions">
        {decisions.map((d) => (
          <li key={d.seq}>
            <span className={`badge ${d.source === 'dichiarata' ? 'src-decl' : 'src-obs'}`}>{d.source}</span>
            <span className="muted small">{label(d.nodeId)}</span>
            <div>{d.text}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function InsightsTab({ run, label }: { run: Run; label: (id?: string) => string }) {
  const [items, setItems] = useState<Insight[] | null>(null);
  const done = !['in_corso', 'attesa_intervento'].includes(run.status);
  useEffect(() => { api.insights(run.id).then(setItems).catch(() => setItems([])); }, [run.id, done, run.totals.costUsd]);
  if (!items) return <p className="muted">Calcolo…</p>;
  return (
    <div>
      <p className="hint">
        Suggerimenti ricavati solo dai consumi misurati in questa esecuzione{run.mode === 'prova' ? ' (qui simulati)' : ''}. Non stimano risparmi:
        per sapere se una modifica funziona, applicala, riesegui e usa <strong>Confronta</strong>.
      </p>
      {!done && <p className="muted small">L'esecuzione è ancora in corso: i suggerimenti si aggiornano a ogni fase completata.</p>}
      {items.length === 0 && <p className="muted">Nessun suggerimento: niente di anomalo nei dati raccolti.</p>}
      {items.map((i) => (
        <div key={i.id} className={`card insight sev-${i.severity}`}>
          <div className="card-title"><span className="badge">{i.severity === 'alta' ? '▲ priorità alta' : i.severity === 'media' ? '● media' : 'ℹ info'}</span> {i.title}</div>
          {i.nodeId && <div className="muted small">Fase: {label(i.nodeId)}</div>}
          <dl>
            <dt>Dati</dt><dd>{i.evidence}</dd>
            <dt>Cosa provare</dt><dd>{i.suggestion}</dd>
            <dt>Compromesso</dt><dd>{i.tradeoff}</dd>
          </dl>
        </div>
      ))}
    </div>
  );
}
