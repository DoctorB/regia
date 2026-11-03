import { useEffect, useState } from 'react';
import { isAgentKind, type Run, type RunSummary } from '../../../shared/types.ts';
import { api, fmtDur, fmtTime, fmtTok, fmtUsd, runDuration } from '../api.ts';
import { t, useI18n } from '../i18n.tsx';
import { statusLabel } from '../ui.tsx';

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
    esito: a.at(-1)?.declared?.esito ?? (st.status === 'completata' ? t('compare.okUndeclared') : '—'),
    status: statusLabel(st.status),
  };
}

function Delta({ a, b, fmt, lowerIsBetter = true }: { a: number | null; b: number | null; fmt: (n: number) => string; lowerIsBetter?: boolean }) {
  const { t } = useI18n();
  if (a === null || b === null) return <span className="muted">{t('compare.na')}</span>;
  const d = b - a;
  if (Math.abs(d) < 1e-12 || fmt(Math.abs(d)) === fmt(0)) return <span className="muted">=</span>;
  const pct = a !== 0 ? ` (${d > 0 ? '+' : ''}${Math.round((d / a) * 100)}%)` : '';
  const better = lowerIsBetter ? d < 0 : d > 0;
  return <span className={better ? 'delta-good' : 'delta-bad'}>{better ? '▼' : '▲'} {d > 0 ? '+' : '−'}{fmt(Math.abs(d))}{pct}</span>;
}

function configDiff(a: Run, b: Run): string[] {
  const out: string[] = [];
  const A = a.snapshot, B = b.snapshot;
  const def = t('compare.diff.default');
  const yesNo = (v: boolean) => (v ? t('compare.diff.yes') : t('compare.diff.no'));
  for (const nb of B.nodes) {
    const na = A.nodes.find((n) => n.id === nb.id);
    if (!na) { out.push(t('compare.diff.phaseAdded', { label: nb.data.label })); continue; }
    const d = nb.data, c = na.data, l = d.label;
    if (c.model !== d.model) out.push(t('compare.diff.model', { label: l, from: c.model || def, to: d.model || def }));
    if (c.instructions !== d.instructions) out.push(t('compare.diff.instructions', { label: l }));
    if (c.role !== d.role) out.push(t('compare.diff.role', { label: l }));
    const sk = (x: typeof c) => (x.skills === 'all' ? t('compare.diff.skillsAll') : x.skills?.length ? x.skills.map((id) => id.replace(/^(progetto|personale):/, '')).join(', ') : '—');
    if (sk(c) !== sk(d)) out.push(t('compare.diff.skills', { label: l, from: sk(c), to: sk(d) }));
    if (c.allowedTools.join() !== d.allowedTools.join()) out.push(t('compare.diff.tools', { label: l, from: c.allowedTools.join(', ') || '—', to: d.allowedTools.join(', ') || '—' }));
    if (c.contextMode !== d.contextMode) out.push(t('compare.diff.context', { label: l, from: c.contextMode, to: d.contextMode }));
    if (c.maxTurns !== d.maxTurns) out.push(t('compare.diff.maxTurns', { label: l, from: c.maxTurns ?? '∞', to: d.maxTurns ?? '∞' }));
    if (c.maxBudgetUsd !== d.maxBudgetUsd) out.push(t('compare.diff.phaseBudget', { label: l, from: c.maxBudgetUsd ?? '—', to: d.maxBudgetUsd ?? '—' }));
    if (c.reuseResult !== d.reuseResult) out.push(t('compare.diff.reuse', { label: l, from: yesNo(c.reuseResult), to: yesNo(d.reuseResult) }));
  }
  for (const na of A.nodes) if (!B.nodes.some((n) => n.id === na.id)) out.push(t('compare.diff.phaseRemoved', { label: na.data.label }));
  if (JSON.stringify(A.edges.map((e) => `${e.source}>${e.target}`).sort()) !== JSON.stringify(B.edges.map((e) => `${e.source}>${e.target}`).sort())) out.push(t('compare.diff.edges'));
  if (A.settings.goal !== B.settings.goal) out.push(t('compare.diff.goal'));
  if (A.settings.loadProjectSettings !== B.settings.loadProjectSettings) out.push(t('compare.diff.projectSettings'));
  if (A.settings.runBudgetUsd !== B.settings.runBudgetUsd) out.push(t('compare.diff.runBudget', { from: A.settings.runBudgetUsd ?? '—', to: B.settings.runBudgetUsd ?? '—' }));
  return out;
}

export function Compare({ workflowId, initialB }: { workflowId: string; initialB?: string }) {
  const { t } = useI18n();
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
  const mode = (m: Run['mode']) => t(`compare.mode.${m}`);
  const label = (r: RunSummary) => `${fmtTime(r.startedAt)} · ${mode(r.mode)} · ${statusRun(r.status)} · ${fmtUsd(r.costUsd)}`;

  return (
    <div className="compare">
      <h2>{t('compare.title')}</h2>
      {list.length < 2 && <p className="muted">{t('compare.needTwo')}</p>}
      <div className="row2">
        {([t('compare.pickA'), t('compare.pickB')] as const).map((l, i) => (
          <label key={i}>{l}
            <select value={ids[i]} onChange={(e) => setIds(i === 0 ? [e.target.value, ids[1]] : [ids[0], e.target.value])}>
              <option value="">—</option>
              {list.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
            </select>
          </label>
        ))}
      </div>
      {A && B && (
        <>
          {A.mode !== B.mode && <div className="issue errore">✕ {t('compare.modeMismatch', { a: mode(A.mode), b: mode(B.mode) })}</div>}
          <div className="note">
            {t('compare.note')}
          </div>

          <h3>{t('compare.totals')}</h3>
          <table className="tbl">
            <thead><tr><th></th><th className="num">A</th><th className="num">B</th><th className="num">{t('compare.col.diff')}</th></tr></thead>
            <tbody>
              <tr><td>{A.mode === 'prova' ? t('compare.row.costSimulated') : t('compare.row.costEstimated')}</td><td className="num mono">{fmtUsd(A.totals.costUsd)}</td><td className="num mono">{fmtUsd(B.totals.costUsd)}</td><td className="num"><Delta a={A.totals.costUsd} b={B.totals.costUsd} fmt={(n) => fmtUsd(n)} /></td></tr>
              {([[t('usage.series.inputTokens'), 'inputTokens'], [t('usage.series.outputTokens'), 'outputTokens'], [t('usage.series.cacheCreationInputTokens'), 'cacheCreationInputTokens'], [t('usage.series.cacheReadInputTokens'), 'cacheReadInputTokens']] as const).map(([l, k]) => (
                <tr key={k}><td>{l}</td><td className="num mono">{fmtTok(A.totals[k])}</td><td className="num mono">{fmtTok(B.totals[k])}</td><td className="num"><Delta a={A.totals[k]} b={B.totals[k]} fmt={fmtTok} /></td></tr>
              ))}
              <tr><td>{t('compare.row.duration')}</td><td className="num">{fmtDur(runDuration(A))}</td><td className="num">{fmtDur(runDuration(B))}</td><td className="num"><Delta a={runDuration(A)} b={runDuration(B)} fmt={fmtDur} /></td></tr>
              <tr><td>{t('compare.row.outcome')}</td><td className="num">{statusRun(A.status)}</td><td className="num">{statusRun(B.status)}</td><td className="num">{A.status === B.status ? <span className="muted">=</span> : <span className={B.status === 'completata' ? 'delta-good' : 'delta-bad'}>{t('compare.changed')}</span>}</td></tr>
            </tbody>
          </table>

          <h3>{t('compare.byPhase')}</h3>
          <div className="tbl-scroll">
            <table className="tbl">
              <thead><tr><th>{t('compare.col.phase')}</th><th>{t('compare.col.outcome')}</th><th className="num">{t('compare.col.costA')}</th><th className="num">{t('compare.col.costB')}</th><th className="num">{t('compare.col.deltaCost')}</th><th className="num">{t('compare.col.deltaTokens')}</th><th className="num">{t('compare.col.deltaDuration')}</th><th className="num">{t('compare.col.attempts')}</th></tr></thead>
              <tbody>
                {B.snapshot.nodes.map((n) => {
                  const a = metrics(A, n.id), b = metrics(B, n.id);
                  if (!isAgentKind(n.data.kind)) {
                    return <tr key={n.id}><td>{n.data.label}</td><td colSpan={7}>{a?.status ?? '—'} → {b?.status ?? '—'} · {t('compare.feedbackRounds', { a: A.nodes[n.id]?.feedbackRounds ?? 0, b: B.nodes[n.id]?.feedbackRounds ?? 0 })}</td></tr>;
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

          <h3>{t('compare.configTitle')}</h3>
          {(() => { const d = configDiff(A, B); return d.length ? <ul>{d.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="muted">{t('compare.noConfigDiff')}</p>; })()}

          <h3>{t('compare.quality.title')}</h3>
          <ul>
            <li>{t('compare.quality.outcome', { a: statusRun(A.status), b: statusRun(B.status) })}</li>
            <li>{t('compare.quality.notOk', { a: countKo(A), b: countKo(B) })}</li>
            <li>{t('compare.quality.rounds', { a: sumRounds(A), b: sumRounds(B) })}</li>
            <li>{t('compare.quality.extra', { a: extra(A), b: extra(B) })}</li>
          </ul>
          <p className="hint">{t('compare.quality.hint')}</p>
        </>
      )}
    </div>
  );
}

// Stato dell'esecuzione in minuscolo, per le frasi (locales/<lingua>/run.json, compare.status.<stato>).
const statusRun = (s: Run['status']) => t(`compare.status.${s}`);
const countKo = (r: Run) => Object.values(r.nodes).filter((n) => { const d = n.attempts.at(-1)?.declared; return d && d.esito !== 'ok'; }).length;
const sumRounds = (r: Run) => Object.values(r.nodes).reduce((s, n) => s + n.feedbackRounds, 0);
const extra = (r: Run) => Object.values(r.nodes).reduce((s, n) => s + n.attempts.filter((a) => a.reason !== 'iniziale' && a.reason !== 'riuso').length, 0);
