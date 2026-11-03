import { Fragment, useState } from 'react';
import { isAgentKind, type Attempt, type Run, type UsageSource } from '../../../shared/types.ts';
import type { Translate } from '../../../shared/i18n.ts';
import { fmtDur, fmtTok, fmtUsd } from '../api.ts';
import { useI18n } from '../i18n.tsx';

// Etichette in locales/<lingua>/run.json (usage.source.<origine>).
const SOURCES: UsageSource[] = ['risultato', 'delta_ripresa', 'parziale', 'riusato', 'nessuno'];
// Etichette in locales/<lingua>/run.json (usage.series.<chiave>).
const SERIES = [
  { key: 'inputTokens', cls: 's1' },
  { key: 'outputTokens', cls: 's2' },
  { key: 'cacheCreationInputTokens', cls: 's3' },
  { key: 'cacheReadInputTokens', cls: 's4' },
] as const;

function billingNote(run: Run, t: Translate): string {
  if (run.mode === 'prova') return t('usage.billing.simulated');
  const src = new Set(Object.values(run.nodes).flatMap((n) => n.attempts.map((a) => a.apiKeySource)).filter(Boolean));
  const base = t('usage.billing.base');
  if (src.has('none')) return `${base} ${t('usage.billing.subscription')}`;
  if (src.has('ANTHROPIC_API_KEY') || src.has('apiKeyHelper') || src.has('/login managed key')) return `${base} ${t('usage.billing.apiKey')}`;
  return base;
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="tile"><div className="tile-label">{label}</div><div className="tile-value mono">{value}</div>{sub && <div className="tile-sub">{sub}</div>}</div>;
}

export function UsageView({ run }: { run: Run }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const tot = run.totals;
  const sourceLabel = (s: UsageSource) => (SOURCES.includes(s) ? t(`usage.source.${s}`) : s);
  const seriesLabel = (k: (typeof SERIES)[number]['key']) => t(`usage.series.${k}`);
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
      <div className="note">{billingNote(run, t)}</div>
      <div className="tiles">
        <Tile label={run.mode === 'prova' ? t('usage.tiles.costSimulated') : t('usage.tiles.costEstimated')} value={fmtUsd(tot.costUsd)} sub={run.budgetUsd ? t('usage.tiles.limit', { budget: fmtUsd(run.budgetUsd, 2) }) : t('usage.tiles.noLimit')} />
        <Tile label={t('usage.tiles.input')} value={fmtTok(tot.inputTokens)} />
        <Tile label={t('usage.tiles.output')} value={fmtTok(tot.outputTokens)} />
        <Tile label={t('usage.series.cacheCreationInputTokens')} value={fmtTok(tot.cacheCreationInputTokens)} />
        <Tile label={t('usage.series.cacheReadInputTokens')} value={fmtTok(tot.cacheReadInputTokens)} />
      </div>
      <p className="hint">
        {t('usage.hint.totalsBefore')} <code>modelUsage</code> {t('usage.hint.totalsAfter', { count: subagents })}
        {' '}{t('usage.hint.duplicatesBefore')} <code>message.id</code> {t('usage.hint.duplicatesAfter', { count: dupSkipped })}
        {' '}{t('usage.hint.resumed')}
      </p>

      <h4>{t('usage.costByPhase')}</h4>
      <div className="bars" role="img" aria-label={t('usage.costByPhase')}>
        {phases.map((p) => (
          <div key={p.node.id} className="bar-row" title={`${p.node.data.label}: ${fmtUsd(p.cost)}${p.unknown ? ` ${t('usage.partial')}` : ''}`}>
            <span className="bar-label ellipsis">{p.node.data.label}</span>
            <span className="bar-track"><span className="bar s1" style={{ width: `${(p.cost / maxCost) * 100}%` }} /></span>
            <span className="bar-val mono">{fmtUsd(p.cost)}{p.unknown ? '*' : ''}</span>
          </div>
        ))}
      </div>

      <h4>{t('usage.tokensByPhase')}</h4>
      <div className="legend">{SERIES.map((s) => <span key={s.key}><i className={`sw ${s.cls}`} />{seriesLabel(s.key)}</span>)}</div>
      <div className="bars">
        {phases.map((p) => {
          const total = SERIES.reduce((s, x) => s + p[x.key], 0);
          return (
            <div key={p.node.id} className="bar-row">
              <span className="bar-label ellipsis">{p.node.data.label}</span>
              <span className="bar-track bar-stack" style={{ width: `${(total / maxTok) * 100}%` }}>
                {SERIES.map((s) => p[s.key] > 0 && (
                  <span key={s.key} className={`bar-seg ${s.cls}`} style={{ flexGrow: p[s.key] }} title={`${p.node.data.label} · ${seriesLabel(s.key)}: ${fmtTok(p[s.key])}`} />
                ))}
              </span>
              <span className="bar-val mono">{fmtTok(total)}</span>
            </div>
          );
        })}
      </div>

      <h4>{t('usage.detail')}</h4>
      <div className="tbl-scroll">
        <table className="tbl">
          <thead><tr><th>{t('usage.col.phase')}</th><th className="num">{t('usage.col.input')}</th><th className="num">{t('usage.col.output')}</th><th className="num">{t('usage.col.cacheW')}</th><th className="num">{t('usage.col.cacheR')}</th><th className="num">{t('usage.col.cost')}</th><th className="num">{t('usage.col.turns')}</th><th className="num">{t('usage.col.duration')}</th></tr></thead>
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
                      <strong>#{a.index + 1}</strong> {t(`usage.reason.${a.reason}`)} · {t(`usage.attemptStatus.${a.status}`)} · {t('usage.attempt.data', { source: sourceLabel(a.usageSource) })}
                      {a.models.length > 0 && <> · {t('usage.attempt.models', { models: a.models.join(', ') })}</>}
                      {a.subagents > 0 && <> · {t('usage.attempt.subagents', { count: a.subagents })}</>}
                      {a.live.duplicatesSkipped > 0 && <> · {t('usage.attempt.duplicates', { count: a.live.duplicatesSkipped })}</>}
                      {a.resultSubtype && <> · result: {a.resultSubtype}</>}
                      {a.reusedFrom && <> · {t('usage.attempt.reusedFrom', { id: a.reusedFrom.runId })}</>}
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
      {phases.some((p) => p.unknown) && <p className="hint">{t('usage.unknownCost')}</p>}

      <h4>{t('usage.byAgent')}</h4>
      <table className="tbl">
        <thead><tr><th>{t('usage.col.agent')}</th><th>{t('usage.col.phases')}</th><th className="num">{t('usage.col.tokens')}</th><th className="num">{t('usage.col.cost')}</th></tr></thead>
        <tbody>{[...agents].map(([k, v]) => <tr key={k}><td>{k}</td><td className="small">{v.phases.join(', ')}</td><td className="num mono">{fmtTok(v.tokens)}</td><td className="num mono">{fmtUsd(v.cost)}</td></tr>)}</tbody>
      </table>

      <h4>{t('usage.byModel')}</h4>
      <table className="tbl">
        <thead><tr><th>{t('usage.col.model')}</th><th className="num">{t('usage.col.input')}</th><th className="num">{t('usage.col.output')}</th><th className="num">{t('usage.col.cacheW')}</th><th className="num">{t('usage.col.cacheR')}</th><th className="num">{t('usage.col.cost')}</th><th>{t('usage.col.basis')}</th></tr></thead>
        <tbody>
          {Object.entries(tot.byModel).map(([m, u]) => (
            <tr key={m}><td className="mono small">{m}</td><td className="num mono">{fmtTok(u.inputTokens)}</td><td className="num mono">{fmtTok(u.outputTokens)}</td><td className="num mono">{fmtTok(u.cacheCreationInputTokens)}</td><td className="num mono">{fmtTok(u.cacheReadInputTokens)}</td><td className="num mono">{fmtUsd(u.costUsd)}</td><td className="small">{u.costBasis ? t(`usage.basisValue.${u.costBasis}`) : ''}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="hint">{t('usage.basis.title')} <strong>{t('usage.basisValue.list')}</strong> {t('usage.basis.list')} <strong>{t('usage.basisValue.managed')}</strong> {t('usage.basis.managed')} <strong>{t('usage.basisValue.unknown')}</strong> {t('usage.basis.unknown')} <strong>{t('usage.basisValue.simulato')}</strong> {t('usage.basis.simulated')}</p>
    </div>
  );
}
