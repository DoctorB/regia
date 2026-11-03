import { Fragment, useState } from 'react';
import { isAgentKind, type Attempt, type Run, type UsageSource } from '../../../shared/types.ts';
import { fmtDur, fmtTok, fmtUsd } from '../api.ts';

const SOURCE_LABEL: Record<UsageSource, string> = {
  risultato: 'result del SDK',
  delta_ripresa: 'sessione ripresa: solo differenza',
  parziale: 'parziale: nessun result (solo input/cache)',
  riusato: 'riusato: nessuna chiamata',
  nessuno: 'nessun dato',
};
const SERIES = [
  { key: 'inputTokens', label: 'Input', cls: 's1' },
  { key: 'outputTokens', label: 'Output', cls: 's2' },
  { key: 'cacheCreationInputTokens', label: 'Cache scritta', cls: 's3' },
  { key: 'cacheReadInputTokens', label: 'Cache letta', cls: 's4' },
] as const;

function billingNote(run: Run): string {
  if (run.mode === 'prova') return 'Modalità di prova: token e costi sono generati dal simulatore con tariffe fittizie. Servono solo a provare l\'interfaccia.';
  const src = new Set(Object.values(run.nodes).flatMap((n) => n.attempts.map((a) => a.apiKeySource)).filter(Boolean));
  const base = 'I costi sono stime calcolate localmente dal SDK con il listino incluso nella sua versione (campi total_cost_usd e modelUsage): non sono dati di fatturazione.';
  if (src.has('none')) return `${base} Questa esecuzione ha usato un login senza chiave API (es. abbonamento claude.ai): il consumo rientra nei limiti del piano, e nei crediti extra solo se attivi; il valore in dollari è un equivalente a prezzi di listino, non un addebito.`;
  if (src.has('ANTHROPIC_API_KEY') || src.has('apiKeyHelper') || src.has('/login managed key')) return `${base} Con una chiave API il consumo è fatturato a token: il costo effettivo si legge nella Console (Usage/Cost).`;
  return base;
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="tile"><div className="tile-label">{label}</div><div className="tile-value mono">{value}</div>{sub && <div className="tile-sub">{sub}</div>}</div>;
}

export function UsageView({ run }: { run: Run }) {
  const [open, setOpen] = useState<string | null>(null);
  const t = run.totals;
  const phases = run.snapshot.nodes.filter((n) => isAgentKind(n.data.kind)).map((n) => {
    const atts = run.nodes[n.id]?.attempts ?? [];
    const sum = (f: (a: Attempt) => number) => atts.reduce((s, a) => s + f(a), 0);
    return {
      node: n, atts,
      cost: sum((a) => a.usage.costUsd ?? 0),
      unknown: atts.some((a) => a.usage.costUsd === null),
      inputTokens: sum((a) => a.usage.inputTokens), outputTokens: sum((a) => a.usage.outputTokens),
      cacheCreationInputTokens: sum((a) => a.usage.cacheCreationInputTokens), cacheReadInputTokens: sum((a) => a.usage.cacheReadInputTokens),
      turns: sum((a) => a.numTurns ?? 0), dur: sum((a) => a.durationMs ?? 0),
    };
  });
  const maxCost = Math.max(...phases.map((p) => p.cost), 1e-9);
  const maxTok = Math.max(...phases.map((p) => SERIES.reduce((s, x) => s + p[x.key], 0)), 1);
  const agents = new Map<string, { cost: number; tokens: number; phases: string[] }>();
  for (const p of phases) {
    const k = p.node.data.role || p.node.data.label;
    const e = agents.get(k) ?? { cost: 0, tokens: 0, phases: [] };
    e.cost += p.cost; e.tokens += SERIES.reduce((s, x) => s + p[x.key], 0); e.phases.push(p.node.data.label);
    agents.set(k, e);
  }
  const allAtts = phases.flatMap((p) => p.atts);
  const dupSkipped = allAtts.reduce((s, a) => s + a.live.duplicatesSkipped, 0);
  const subagents = allAtts.reduce((s, a) => s + a.subagents, 0);

  return (
    <div className="usage">
      <div className="note">{billingNote(run)}</div>
      <div className="tiles">
        <Tile label={run.mode === 'prova' ? 'Costo simulato' : 'Costo stimato (SDK)'} value={fmtUsd(t.costUsd)} sub={run.budgetUsd ? `limite ${fmtUsd(run.budgetUsd, 2)}` : 'nessun limite'} />
        <Tile label="Token di input" value={fmtTok(t.inputTokens)} />
        <Tile label="Token di output" value={fmtTok(t.outputTokens)} />
        <Tile label="Cache scritta" value={fmtTok(t.cacheCreationInputTokens)} />
        <Tile label="Cache letta" value={fmtTok(t.cacheReadInputTokens)} />
      </div>
      <p className="hint">
        Totali dal campo <code>modelUsage</code> del result di ogni fase (include i subagenti: {subagents} avviati).
        Messaggi duplicati ignorati (stesso <code>message.id</code> per strumenti in parallelo): {dupSkipped}.
        Per le sessioni riprese viene registrata solo la differenza rispetto ai totali già contati.
      </p>

      <h4>Costo per fase</h4>
      <div className="bars" role="img" aria-label="Costo per fase">
        {phases.map((p) => (
          <div key={p.node.id} className="bar-row" title={`${p.node.data.label}: ${fmtUsd(p.cost)}${p.unknown ? ' (parziale)' : ''}`}>
            <span className="bar-label ellipsis">{p.node.data.label}</span>
            <span className="bar-track"><span className="bar s1" style={{ width: `${(p.cost / maxCost) * 100}%` }} /></span>
            <span className="bar-val mono">{fmtUsd(p.cost)}{p.unknown ? '*' : ''}</span>
          </div>
        ))}
      </div>

      <h4>Composizione dei token per fase</h4>
      <div className="legend">{SERIES.map((s) => <span key={s.key}><i className={`sw ${s.cls}`} />{s.label}</span>)}</div>
      <div className="bars">
        {phases.map((p) => {
          const tot = SERIES.reduce((s, x) => s + p[x.key], 0);
          return (
            <div key={p.node.id} className="bar-row">
              <span className="bar-label ellipsis">{p.node.data.label}</span>
              <span className="bar-track stack" style={{ width: `${(tot / maxTok) * 100}%` }}>
                {SERIES.map((s) => p[s.key] > 0 && (
                  <span key={s.key} className={`seg ${s.cls}`} style={{ flexGrow: p[s.key] }} title={`${p.node.data.label} · ${s.label}: ${fmtTok(p[s.key])}`} />
                ))}
              </span>
              <span className="bar-val mono">{fmtTok(tot)}</span>
            </div>
          );
        })}
      </div>

      <h4>Dettaglio per fase e tentativo</h4>
      <div className="tbl-scroll">
        <table className="tbl">
          <thead><tr><th>Fase</th><th className="num">Input</th><th className="num">Output</th><th className="num">Cache W</th><th className="num">Cache R</th><th className="num">Costo</th><th className="num">Turni</th><th className="num">Durata</th></tr></thead>
          <tbody>
            {phases.map((p) => (
              <Fragment key={p.node.id}>
                <tr className="clickable" onClick={() => setOpen(open === p.node.id ? null : p.node.id)}>
                  <td>{open === p.node.id ? '▾' : '▸'} {p.node.data.label} <span className="muted small">({p.atts.length})</span></td>
                  <td className="num mono">{fmtTok(p.inputTokens)}</td><td className="num mono">{fmtTok(p.outputTokens)}</td>
                  <td className="num mono">{fmtTok(p.cacheCreationInputTokens)}</td><td className="num mono">{fmtTok(p.cacheReadInputTokens)}</td>
                  <td className="num mono">{fmtUsd(p.cost)}{p.unknown ? '*' : ''}</td><td className="num">{p.turns || '—'}</td><td className="num">{fmtDur(p.dur || undefined)}</td>
                </tr>
                {open === p.node.id && p.atts.map((a) => (
                  <tr key={a.id} className="sub-row">
                    <td colSpan={8}>
                      <strong>#{a.index + 1}</strong> {a.reason.replace(/_/g, ' ')} · {a.status} · dati: {SOURCE_LABEL[a.usageSource]}
                      {a.models.length > 0 && <> · modelli: {a.models.join(', ')}</>}
                      {a.subagents > 0 && <> · subagenti: {a.subagents}</>}
                      {a.live.duplicatesSkipped > 0 && <> · duplicati ignorati: {a.live.duplicatesSkipped}</>}
                      {a.resultSubtype && <> · result: {a.resultSubtype}</>}
                      {a.reusedFrom && <> · riusato da {a.reusedFrom.runId}</>}
                      <div className="mono small">in {fmtTok(a.usage.inputTokens)} · out {fmtTok(a.usage.outputTokens)} · cache W {fmtTok(a.usage.cacheCreationInputTokens)} · cache R {fmtTok(a.usage.cacheReadInputTokens)} · {fmtUsd(a.usage.costUsd)} · API {fmtDur(a.durationApiMs)}</div>
                      {a.error && <div className="issue errore">{a.error}</div>}
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {phases.some((p) => p.unknown) && <p className="hint">* Almeno un tentativo si è interrotto senza result: il suo costo non è noto e non è incluso.</p>}

      <h4>Per agente (ruolo)</h4>
      <table className="tbl">
        <thead><tr><th>Agente</th><th>Fasi</th><th className="num">Token</th><th className="num">Costo</th></tr></thead>
        <tbody>{[...agents].map(([k, v]) => <tr key={k}><td>{k}</td><td className="small">{v.phases.join(', ')}</td><td className="num mono">{fmtTok(v.tokens)}</td><td className="num mono">{fmtUsd(v.cost)}</td></tr>)}</tbody>
      </table>

      <h4>Per modello</h4>
      <table className="tbl">
        <thead><tr><th>Modello</th><th className="num">Input</th><th className="num">Output</th><th className="num">Cache W</th><th className="num">Cache R</th><th className="num">Costo</th><th>Listino</th></tr></thead>
        <tbody>
          {Object.entries(t.byModel).map(([m, u]) => (
            <tr key={m}><td className="mono small">{m}</td><td className="num mono">{fmtTok(u.inputTokens)}</td><td className="num mono">{fmtTok(u.outputTokens)}</td><td className="num mono">{fmtTok(u.cacheCreationInputTokens)}</td><td className="num mono">{fmtTok(u.cacheReadInputTokens)}</td><td className="num mono">{fmtUsd(u.costUsd)}</td><td className="small">{u.costBasis}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="hint">Listino: <code>list</code> = prezzi inclusi nel SDK, <code>managed</code> = tabella prezzi dell'organizzazione, <code>unknown</code> = modello non riconosciuto (stima approssimativa), <code>simulato</code> = modalità di prova.</p>
    </div>
  );
}
