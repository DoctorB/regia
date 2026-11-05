// Resoconto di un'esecuzione in Markdown: da incollare in una pull request o da archiviare.
// Usato dall'interfaccia con la lingua scelta; non dipende dal server.
import { render, type Translate } from './i18n.ts';
import { layoutGraph } from './layout.ts';
import type { Run, RunEvent } from './types.ts';

const FILE_TOOL = /^(?:Edit|Write|NotebookEdit) (.+)$/;
const HUMAN_ACTION = /^events\.humanAction(Feedback)?$/;

const fmtDuration = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const fmtUsd = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `$${n.toFixed(4)}`);
/** Testo su una riga, senza caratteri che rompono le tabelle Markdown. */
const cell = (s: string) => s.replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();
/** Testo su più righe come citazione Markdown. */
const quote = (s: string) => s.trim().split(/\r?\n/).map((l) => `> ${l}`.trimEnd()).join('\n');

/**
 * compact: versione per gli agenti (esecuzione di riferimento): solo obiettivo, risultati, decisioni,
 * file modificati e interventi, senza intestazione, costi, tempi e modelli.
 */
export function runReport(run: Run, t: Translate, locale: string, opts: { compact?: boolean } = {}): string {
  const compact = Boolean(opts.compact);
  const date = (iso?: string) => (iso ? new Date(iso).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'medium' }) : '—');
  const num = (n: number) => n.toLocaleString(locale);
  const label = (id?: string) => run.snapshot.nodes.find((n) => n.id === id)?.data.label ?? id ?? '';
  const text = (e: RunEvent) => render(t, e.msg, e.text);
  const end = run.endedAt ? Date.parse(run.endedAt) : Date.now();
  const tokens = run.totals.inputTokens + run.totals.outputTokens + run.totals.cacheCreationInputTokens + run.totals.cacheReadInputTokens;
  const settings = run.snapshot.settings;

  const out: string[] = [];
  if (!compact) out.push(`# ${t('report.title', { name: run.workflowName })}`, '');

  const rows: [string, string][] = [
    [t('report.fields.run'), `\`${run.id}\` · ${t(`run.mode.${run.mode}`)}`],
    [t('report.fields.status'), t(`runStatus.${run.status}`)],
    [t('report.fields.started'), date(run.startedAt)],
    [t('report.fields.ended'), run.endedAt ? date(run.endedAt) : t('report.inProgress')],
    [t('report.fields.duration'), fmtDuration(end - Date.parse(run.startedAt))],
    [t('report.fields.project'), settings.projectDir ? `\`${settings.projectDir}\`` : '—'],
    [run.mode === 'prova' ? t('run.metrics.costSimulated') : t('run.metrics.costEstimated'),
      run.budgetUsd ? `${fmtUsd(run.totals.costUsd)} (${t('run.metrics.limit', { budget: `$${run.budgetUsd.toFixed(2)}` })})` : fmtUsd(run.totals.costUsd)],
    [t('run.metrics.tokens'), num(tokens)],
  ];
  if (run.continuedFrom) rows.push([t('report.fields.continuedFrom'), `\`${run.continuedFrom}\``]);
  if (run.reference) rows.push([t('report.fields.reference'), `${run.reference.workflowName} · \`${run.reference.runId}\``]);
  if (!compact) out.push(`| | |`, `|---|---|`, ...rows.map(([k, v]) => `| ${cell(k)} | ${cell(v)} |`), '');

  if (settings.goal?.trim()) out.push(`## ${t('report.goal')}`, '', settings.goal.trim(), '');

  // Fasi nell'ordine del diagramma, dall'alto in basso.
  const pos = layoutGraph(run.snapshot.nodes, run.snapshot.edges);
  const ordered = [...run.snapshot.nodes].sort((a, b) => pos[a.id].y - pos[b.id].y || pos[a.id].x - pos[b.id].x);
  out.push(`## ${t('report.phases')}`, '');
  ordered.forEach((n, i) => {
    const st = run.nodes[n.id];
    const status = st?.status ?? 'in_attesa';
    out.push(`### ${i + 1}. ${n.data.label}`, '');
    const all = st?.attempts ?? [];
    // I tentativi riusati non sono stati eseguiti qui: si indica da dove vengono, senza durata né costo.
    const attempts = all.filter((a) => a.reason !== 'riuso');
    const reused = all.find((a) => a.reusedFrom)?.reusedFrom;
    const facts = [`${t(`kinds.${n.data.kind}.label`)}`, t(`status.${status}`)];
    if (reused) facts.push(t('report.reusedFrom', { id: `\`${reused.runId}\`` }));
    if (attempts.length && !compact) {
      const ms = attempts.reduce((s, a) => s + (a.durationMs ?? (a.endedAt ? Date.parse(a.endedAt) - Date.parse(a.startedAt) : 0)), 0);
      const costs = attempts.map((a) => a.usage.costUsd);
      const cost = costs.some((c) => c === null) ? null : costs.reduce((s: number, c) => s + (c ?? 0), 0);
      const models = [...new Set(attempts.flatMap((a) => a.models))];
      facts.push(t('run.attempts', { count: attempts.length }), fmtDuration(ms), fmtUsd(cost));
      if (models.length) facts.push(models.join(', '));
    }
    out.push(facts.join(' · '), '');

    const declared = [...all].reverse().find((a) => a.declared)?.declared;
    // Il motivo dell'intervento conta solo se la fase è ancora ferma in attesa della persona.
    const waiting = Boolean(st?.pendingActions?.length);
    const result = declared?.sintesi || st?.output || (waiting ? render(t, st?.pendingMsg, st?.pendingReason ?? '') : '');
    if (result?.trim()) out.push(`**${t('report.result')}**`, '', quote(result), '');

    const events = run.events.filter((e) => e.nodeId === n.id);
    const decisions = events.filter((e) => e.kind === 'decisione' && e.source === 'dichiarata').map(text);
    if (decisions.length) out.push(`**${t('report.decisions')}**`, '', ...decisions.map((d) => `- ${cell(d)}`), '');

    const files = [...new Set(events.filter((e) => e.kind === 'strumento').map((e) => FILE_TOOL.exec(e.text)?.[1]).filter((f): f is string => Boolean(f)))];
    if (files.length) out.push(`**${t('report.files')}**`, '', ...files.map((f) => `- \`${f}\``), '');
  });

  const human = run.events.filter((e) => e.kind === 'intervento' && e.msg && HUMAN_ACTION.test(e.msg.key));
  out.push(`## ${t('report.interventions')}`, '');
  if (!human.length) out.push(t('report.noInterventions'), '');
  for (const e of human) {
    const p = e.msg!.params ?? {};
    const action = t(`actions.${p.action}.label`);
    const fb = p.feedback ? ` — "${cell(String(p.feedback))}"` : '';
    out.push(`- ${date(e.ts)} · **${cell(label(e.nodeId))}**: ${action}${fb}`);
  }
  out.push('');

  if (compact) return out.join('\n').trim();
  if (run.notes.length) out.push(`## ${t('report.notes')}`, '', ...run.notes.map((x) => `- ${cell(x)}`), '');

  out.push('---', '', `_${t('report.footer', { date: date(new Date().toISOString()) })}_`, '');
  return out.join('\n');
}
