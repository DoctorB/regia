import { useEffect, useState } from 'react';
import { isAgentKind, type Run, type RunSummary } from '../../../shared/types.ts';
import { api, fmtDur, fmtTime, fmtTok, fmtUsd, runDuration } from '../api.ts';
import { STATUS } from './Canvas.tsx';

interface PhaseM { cost: number | null; tokens: number; input: number; output: number; cacheW: number; cacheR: number; durMs: number; turns: number; attempts: number; esito: string; status: string }

function metrics(run: Run, nodeId: string): PhaseM | null {
  const st = run.nodes[nodeId];
  if (!st) return null;
  const a = st.attempts;
  const unknown = a.some((x) => x.usage.costUsd === null);
  const s = (f: (x: (typeof a)[number]) => number) => a.reduce((t, x) => t + f(x), 0);
  return {
    cost: unknown ? null : s((x) => x.usage.costUsd ?? 0),
    input: s((x) => x.usage.inputTokens), output: s((x) => x.usage.outputTokens),
    cacheW: s((x) => x.usage.cacheCreationInputTokens), cacheR: s((x) => x.usage.cacheReadInputTokens),
    tokens: s((x) => x.usage.inputTokens + x.usage.outputTokens + x.usage.cacheCreationInputTokens + x.usage.cacheReadInputTokens),
    durMs: s((x) => x.durationMs ?? 0), turns: s((x) => x.numTurns ?? 0), attempts: a.length,
    esito: a.at(-1)?.declared?.esito ?? (st.status === 'completata' ? 'ok (non dichiarato)' : '—'),
    status: STATUS[st.status].label,
  };
}

function Delta({ a, b, fmt, lowerIsBetter = true }: { a: number | null; b: number | null; fmt: (n: number) => string; lowerIsBetter?: boolean }) {
  if (a === null || b === null) return <span className="muted">n.d.</span>;
  const d = b - a;
  if (Math.abs(d) < 1e-12) return <span className="muted">=</span>;
  const pct = a !== 0 ? ` (${d > 0 ? '+' : ''}${Math.round((d / a) * 100)}%)` : '';
  const better = lowerIsBetter ? d < 0 : d > 0;
  return <span className={better ? 'delta-good' : 'delta-bad'}>{better ? '▼' : '▲'} {d > 0 ? '+' : '−'}{fmt(Math.abs(d))}{pct}</span>;
}

function configDiff(a: Run, b: Run): string[] {
  const out: string[] = [];
  const A = a.snapshot, B = b.snapshot;
  for (const nb of B.nodes) {
    const na = A.nodes.find((n) => n.id === nb.id);
    if (!na) { out.push(`Fase aggiunta: ${nb.data.label}`); continue; }
    const d = nb.data, c = na.data, l = d.label;
    if (c.model !== d.model) out.push(`${l}: modello ${c.model || 'predefinito'} → ${d.model || 'predefinito'}`);
    if (c.instructions !== d.instructions) out.push(`${l}: istruzioni modificate`);
    if (c.role !== d.role) out.push(`${l}: ruolo modificato`);
    if (c.allowedTools.join() !== d.allowedTools.join()) out.push(`${l}: strumenti ${c.allowedTools.join(', ') || '—'} → ${d.allowedTools.join(', ') || '—'}`);
    if (c.contextMode !== d.contextMode) out.push(`${l}: contesto ${c.contextMode} → ${d.contextMode}`);
    if (c.maxTurns !== d.maxTurns) out.push(`${l}: max turni ${c.maxTurns ?? '∞'} → ${d.maxTurns ?? '∞'}`);
    if (c.maxBudgetUsd !== d.maxBudgetUsd) out.push(`${l}: limite fase ${c.maxBudgetUsd ?? '—'} → ${d.maxBudgetUsd ?? '—'}`);
    if (c.reuseResult !== d.reuseResult) out.push(`${l}: riuso ${c.reuseResult ? 'sì' : 'no'} → ${d.reuseResult ? 'sì' : 'no'}`);
  }
  for (const na of A.nodes) if (!B.nodes.some((n) => n.id === na.id)) out.push(`Fase rimossa: ${na.data.label}`);
  if (JSON.stringify(A.edges.map((e) => `${e.source}>${e.target}`).sort()) !== JSON.stringify(B.edges.map((e) => `${e.source}>${e.target}`).sort())) out.push('Collegamenti tra le fasi modificati');
  if (A.settings.goal !== B.settings.goal) out.push('Obiettivo modificato');
  if (A.settings.loadProjectSettings !== B.settings.loadProjectSettings) out.push('Caricamento CLAUDE.md del progetto modificato');
  if (A.settings.runBudgetUsd !== B.settings.runBudgetUsd) out.push(`Limite per esecuzione ${A.settings.runBudgetUsd ?? '—'} → ${B.settings.runBudgetUsd ?? '—'}`);
  return out;
}

export function Compare({ workflowId, initialB }: { workflowId: string; initialB?: string }) {
  const [list, setList] = useState<RunSummary[]>([]);
  const [ids, setIds] = useState<[string, string]>(['', '']);
  const [runs, setRuns] = useState<[Run | null, Run | null]>([null, null]);
  useEffect(() => {
    api.runs(workflowId).then((l) => {
      setList(l);
      const b = initialB ?? l[0]?.id ?? '';
      const a = l.find((r) => r.id !== b)?.id ?? '';
      setIds([a, b]);
    });
  }, [workflowId, initialB]);
  useEffect(() => {
    Promise.all(ids.map((id) => (id ? api.run(id) : Promise.resolve(null)))).then((r) => setRuns([r[0], r[1]]));
  }, [ids]);
  const [A, B] = runs;
  const label = (r: RunSummary) => `${fmtTime(r.startedAt)} · ${r.mode} · ${STATUS_RUN[r.status]} · ${fmtUsd(r.costUsd)}`;

  return (
    <div className="compare">
      <h2>Confronta due esecuzioni</h2>
      {list.length < 2 && <p className="muted">Servono almeno due esecuzioni di questo workflow.</p>}
      <div className="row2">
        {(['A (prima)', 'B (dopo)'] as const).map((l, i) => (
          <label key={l}>{l}
            <select value={ids[i]} onChange={(e) => setIds(i === 0 ? [e.target.value, ids[1]] : [ids[0], e.target.value])}>
              <option value="">—</option>
              {list.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
            </select>
          </label>
        ))}
      </div>
      {A && B && (
        <>
          {A.mode !== B.mode && <div className="issue errore">✕ Le due esecuzioni hanno modalità diverse ({A.mode} / {B.mode}): i dati simulati non sono confrontabili con quelli reali.</div>}
          <div className="note">
            Le differenze sono misurate, non stimate. Una sola coppia di esecuzioni non basta a dimostrare un effetto: gli agenti non sono deterministici, quindi tempi e token variano anche
            a parità di configurazione. Ripeti il confronto più volte prima di trarre conclusioni, e guarda sempre insieme consumi ed esiti.
          </div>

          <h3>Totali</h3>
          <table className="tbl">
            <thead><tr><th></th><th className="num">A</th><th className="num">B</th><th className="num">Differenza B − A</th></tr></thead>
            <tbody>
              <tr><td>Costo {A.mode === 'prova' ? 'simulato' : 'stimato (SDK)'}</td><td className="num mono">{fmtUsd(A.totals.costUsd)}</td><td className="num mono">{fmtUsd(B.totals.costUsd)}</td><td className="num"><Delta a={A.totals.costUsd} b={B.totals.costUsd} fmt={(n) => fmtUsd(n)} /></td></tr>
              {([['Input', 'inputTokens'], ['Output', 'outputTokens'], ['Cache scritta', 'cacheCreationInputTokens'], ['Cache letta', 'cacheReadInputTokens']] as const).map(([l, k]) => (
                <tr key={k}><td>{l}</td><td className="num mono">{fmtTok(A.totals[k])}</td><td className="num mono">{fmtTok(B.totals[k])}</td><td className="num"><Delta a={A.totals[k]} b={B.totals[k]} fmt={fmtTok} /></td></tr>
              ))}
              <tr><td>Durata totale (incluse attese umane)</td><td className="num">{fmtDur(runDuration(A))}</td><td className="num">{fmtDur(runDuration(B))}</td><td className="num"><Delta a={runDuration(A)} b={runDuration(B)} fmt={fmtDur} /></td></tr>
              <tr><td>Esito finale</td><td className="num">{STATUS_RUN[A.status]}</td><td className="num">{STATUS_RUN[B.status]}</td><td className="num">{A.status === B.status ? <span className="muted">=</span> : <span className={B.status === 'completata' ? 'delta-good' : 'delta-bad'}>cambiato</span>}</td></tr>
            </tbody>
          </table>

          <h3>Per fase</h3>
          <div className="tbl-scroll">
            <table className="tbl">
              <thead><tr><th>Fase</th><th>Esito A → B</th><th className="num">Costo A</th><th className="num">Costo B</th><th className="num">Δ costo</th><th className="num">Δ token</th><th className="num">Δ durata agente</th><th className="num">Tentativi</th></tr></thead>
              <tbody>
                {B.snapshot.nodes.map((n) => {
                  const a = metrics(A, n.id), b = metrics(B, n.id);
                  if (!isAgentKind(n.data.kind)) {
                    return <tr key={n.id}><td>{n.data.label}</td><td colSpan={7}>{a?.status ?? '—'} → {b?.status ?? '—'} · cicli di correzione: {A.nodes[n.id]?.feedbackRounds ?? 0} → {B.nodes[n.id]?.feedbackRounds ?? 0}</td></tr>;
                  }
                  const worse = a && b && a.esito.startsWith('ok') && !b.esito.startsWith('ok');
                  return (
                    <tr key={n.id}>
                      <td>{n.data.label}</td>
                      <td className={worse ? 'delta-bad' : ''}>{a?.esito ?? '—'} → {b?.esito ?? '—'}</td>
                      <td className="num mono">{fmtUsd(a?.cost)}</td><td className="num mono">{fmtUsd(b?.cost)}</td>
                      <td className="num">{a && b ? <Delta a={a.cost} b={b.cost} fmt={(x) => fmtUsd(x)} /> : '—'}</td>
                      <td className="num">{a && b ? <Delta a={a.tokens} b={b.tokens} fmt={fmtTok} /> : '—'}</td>
                      <td className="num">{a && b ? <Delta a={a.durMs} b={b.durMs} fmt={fmtDur} /> : '—'}</td>
                      <td className="num">{a?.attempts ?? '—'} → {b?.attempts ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <h3>Cosa è cambiato nella configurazione</h3>
          {(() => { const d = configDiff(A, B); return d.length ? <ul>{d.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="muted">Nessuna differenza di configurazione: le variazioni dipendono dalla variabilità degli agenti o dal contenuto del progetto.</p>; })()}

          <h3>Segnali di qualità</h3>
          <ul>
            <li>Esito finale: A {STATUS_RUN[A.status]}, B {STATUS_RUN[B.status]}.</li>
            <li>Fasi con esito dichiarato diverso da "ok": A {countKo(A)}, B {countKo(B)}.</li>
            <li>Cicli di correzione richiesti in approvazione: A {sumRounds(A)}, B {sumRounds(B)}.</li>
            <li>Tentativi aggiuntivi (errori o blocchi): A {extra(A)}, B {extra(B)}.</li>
          </ul>
          <p className="hint">Una riduzione dei consumi ha senso solo se questi segnali non peggiorano. Controlla anche il contenuto: apri le due esecuzioni e leggi sintesi e decisioni delle fasi chiave.</p>
        </>
      )}
    </div>
  );
}

const STATUS_RUN: Record<Run['status'], string> = { in_corso: 'in corso', attesa_intervento: 'in attesa', completata: 'completata', fallita: 'fallita', annullata: 'annullata', interrotta: 'interrotta' };
const countKo = (r: Run) => Object.values(r.nodes).filter((n) => { const d = n.attempts.at(-1)?.declared; return d && d.esito !== 'ok'; }).length;
const sumRounds = (r: Run) => Object.values(r.nodes).reduce((s, n) => s + n.feedbackRounds, 0);
const extra = (r: Run) => Object.values(r.nodes).reduce((s, n) => s + n.attempts.filter((a) => a.reason !== 'iniziale' && a.reason !== 'riuso').length, 0);
