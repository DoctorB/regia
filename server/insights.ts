// Suggerimenti di ottimizzazione basati solo su dati misurati dell'esecuzione.
// Non stimano risparmi: indicano dove si concentra la spesa e cosa provare, con il compromesso atteso.
// L'effetto reale si verifica confrontando due esecuzioni.
// I testi sono messaggi localizzabili (chiavi insights.* in locales/<lingua>/workflow.json):
// le varianti (dati simulati, frammenti facoltativi) sono chiavi distinte, così ogni lingua può formularle in modo naturale.
import type { Attempt, Insight, Run, WorkflowNode } from '../shared/types.ts';
import { WRITE_TOOLS, isAgentKind } from '../shared/types.ts';
import { msg, type Msg, type Params } from '../shared/i18n.ts';

const usd = (n: number) => `${n.toFixed(4)} USD`;
/** Numero di token senza separatori: il formato dipende dalla lingua di chi legge. */
const tok = (n: number) => Math.round(n);
const I = (key: string, params?: Params): Msg => msg(`insights.${key}`, params);

function tier(models: string[], configured: string): 'premium' | 'medio' | 'economico' | 'sconosciuto' {
  const all = [...models, configured].join(' ').toLowerCase();
  if (/opus|fable/.test(all)) return 'premium';
  if (/sonnet/.test(all)) return 'medio';
  if (/haiku/.test(all)) return 'economico';
  return 'sconosciuto';
}

interface NodeStats {
  node: WorkflowNode;
  attempts: Attempt[];
  cost: number;
  costKnown: boolean;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  turns: number;
  models: string[];
  repeated: { name: string; count: number }[];
}

function stats(run: Run): NodeStats[] {
  return run.snapshot.nodes.filter((n) => isAgentKind(n.data.kind)).map((node) => {
    const attempts = (run.nodes[node.id]?.attempts ?? []).filter((a) => a.usageSource !== 'riusato');
    const s: NodeStats = { node, attempts, cost: 0, costKnown: true, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, turns: 0, models: [], repeated: [] };
    for (const a of attempts) {
      if (a.usage.costUsd === null) s.costKnown = false; else s.cost += a.usage.costUsd;
      s.input += a.usage.inputTokens; s.output += a.usage.outputTokens;
      s.cacheCreate += a.usage.cacheCreationInputTokens; s.cacheRead += a.usage.cacheReadInputTokens;
      s.turns += a.numTurns ?? 0;
      for (const m of Object.keys(a.usage.byModel).concat(a.models)) if (!s.models.includes(m)) s.models.push(m);
      const counts = new Map<string, { name: string; count: number }>();
      for (const c of a.toolCalls) {
        const e = counts.get(c.key) ?? { name: c.name, count: 0 };
        e.count++;
        counts.set(c.key, e);
      }
      for (const e of counts.values()) if (e.count >= 3) s.repeated.push(e);
    }
    return s;
  });
}

export function computeInsights(run: Run): Insight[] {
  const out: Insight[] = [];
  const all = stats(run);
  const total = all.reduce((x, s) => x + s.cost, 0);
  const share = (s: NodeStats) => (total > 0 ? s.cost / total : 0);
  const pct = (s: NodeStats) => `${Math.round(share(s) * 100)}%`;
  const sev = (s: NodeStats): Insight['severity'] => (share(s) >= 0.35 ? 'alta' : share(s) >= 0.15 ? 'media' : 'info');
  const wf = run.snapshot;
  // Con dati simulati si usa la variante della chiave con il suffisso "Sim".
  const sim = run.mode === 'prova' ? 'Sim' : '';
  const ctxs = all.map((s) => s.input + s.cacheCreate + s.cacheRead).filter((x) => x > 0).sort((a, b) => a - b);
  const medianCtx = ctxs.length ? ctxs[Math.floor(ctxs.length / 2)] : 0;
  const preds = (id: string) => wf.edges.filter((e) => e.target === id).map((e) => e.source);
  const hasWriterAncestor = (id: string): boolean => preds(id).some((p) => {
    const n = wf.nodes.find((x) => x.id === p);
    return Boolean(n && (n.data.allowedTools.some((t) => WRITE_TOOLS.includes(t)) || hasWriterAncestor(p)));
  });
  // Cicli di correzione chiesti in approvazione: costo della fase ripresa + fasi intermedie rieseguite.
  const correctionAttempts = all.flatMap((s) => s.attempts.filter((a) => a.reason === 'dopo_correzione' || a.reason === 'ripresa_con_feedback').map((a) => ({ s, a })));
  const correctionTargets = new Set(correctionAttempts.filter((x) => x.a.reason === 'ripresa_con_feedback').map((x) => x.s.node.id));
  const rounds = Object.values(run.nodes).reduce((x, n) => x + n.feedbackRounds, 0);
  if (rounds > 0 && correctionAttempts.length) {
    const c = correctionAttempts.reduce((x, { a }) => x + (a.usage.costUsd ?? 0), 0);
    const names = [...new Set(correctionAttempts.map(({ s }) => s.node.data.label))];
    out.push({
      id: 'corrections', severity: total > 0 && c / total > 0.25 ? 'alta' : 'media',
      title: I('corrections.title', { count: rounds }),
      evidence: total > 0
        ? I(`corrections.evidenceShare${sim}`, { cost: usd(c), pct: `${Math.round((c / total) * 100)}%`, phases: names.join(', ') })
        : I(`corrections.evidence${sim}`, { cost: usd(c), phases: names.join(', ') }),
      suggestion: I('corrections.suggestion'),
      tradeoff: I('corrections.tradeoff'),
    });
  }

  // Fase più costosa
  const top = [...all].sort((a, b) => b.cost - a.cost)[0];
  if (top && total > 0 && share(top) >= 0.4 && all.length > 1) {
    out.push({
      id: `top-${top.node.id}`, severity: 'alta', nodeId: top.node.id,
      title: I('top.title', { phase: top.node.data.label, pct: pct(top) }),
      evidence: I(`top.evidence${sim}`, { cost: usd(top.cost), total: usd(total), context: tok(top.input + top.cacheCreate + top.cacheRead), output: tok(top.output) }),
      suggestion: I('top.suggestion'),
      tradeoff: I('top.tradeoff'),
    });
  }

  for (const s of all) {
    const d = s.node.data;
    const t = tier(s.models, d.model);
    const readOnly = !d.allowedTools.some((x) => WRITE_TOOLS.includes(x));
    const simpleKind = d.kind === 'test' || d.kind === 'revisione' || (d.kind === 'analisi' && readOnly);

    if (simpleKind && (t === 'premium' || t === 'medio') && share(s) >= 0.1) {
      const target = t === 'premium' ? 'sonnet' : 'haiku';
      out.push({
        id: `model-${s.node.id}`, severity: sev(s), nodeId: s.node.id,
        title: I('model.title', { phase: d.label, model: target }),
        // Variante per tipo di fase (test, revisione, analisi), con "Ro" se senza strumenti di scrittura.
        evidence: I(`model.evidence.${d.kind}${readOnly ? 'Ro' : ''}${sim}`, { models: s.models.join(', ') || d.model, cost: usd(s.cost), pct: pct(s) }),
        suggestion: I('model.suggestion', { model: target }),
        tradeoff: d.kind === 'test'
          ? I('model.tradeoff.test')
          : d.kind === 'revisione'
            ? I('model.tradeoff.revisione')
            : I('model.tradeoff.analisi'),
      });
    }

    // Ogni sessione parte con un prompt di sistema corposo (in cache), quindi un rapporto input/output alto è normale:
    // si segnala solo una fase che usa molto più contesto delle altre, o che riceve il testo completo delle precedenti.
    const ctxTokens = s.input + s.cacheCreate + s.cacheRead;
    const relHigh = all.length > 1 && medianCtx > 0 && ctxTokens >= 2 * medianCtx;
    const fullCtx = d.contextMode === 'completo' && wf.edges.some((e) => e.target === s.node.id);
    if (ctxTokens > 40000 && s.output > 0 && (relHigh || fullCtx)) {
      // Frammenti facoltativi del suggerimento: modalità "completo" e impostazioni del progetto caricate.
      const sugg = `${d.contextMode === 'completo' ? 'full' : 'base'}${wf.settings.loadProjectSettings ? 'ProjectSettings' : ''}`;
      out.push({
        id: `ctx-${s.node.id}`, severity: sev(s), nodeId: s.node.id,
        title: relHigh ? I('ctx.title.relHigh', { phase: d.label }) : I('ctx.title.fullCtx', { phase: d.label }),
        evidence: relHigh
          ? I(`ctx.evidence.ratio${sim}`, { context: tok(ctxTokens), ratio: (ctxTokens / medianCtx).toFixed(1), output: tok(s.output) })
          : I(`ctx.evidence.base${sim}`, { context: tok(ctxTokens), output: tok(s.output) }),
        suggestion: I(`ctx.suggestion.${sugg}`),
        tradeoff: I('ctx.tradeoff'),
      });
    }

    if (s.repeated.length) {
      out.push({
        id: `rep-${s.node.id}`, severity: 'media', nodeId: s.node.id,
        title: I('rep.title', { phase: d.label }),
        evidence: I('rep.evidence', { count: s.repeated.length, calls: s.repeated.map((r) => `${r.name} ×${r.count}`).join('; ') }),
        suggestion: I('rep.suggestion'),
        tradeoff: I('rep.tradeoff'),
      });
    }

    if (d.maxTurns && s.attempts.some((a) => (a.numTurns ?? 0) >= d.maxTurns! * 0.8)) {
      out.push({
        id: `turns-${s.node.id}`, severity: 'media', nodeId: s.node.id,
        title: I('turns.title', { phase: d.label }),
        evidence: I('turns.evidence', { used: s.attempts.map((a) => a.numTurns ?? '?').join(', '), max: d.maxTurns }),
        suggestion: I('turns.suggestion'),
        tradeoff: I('turns.tradeoff'),
      });
    }

    // Tentativi dovuti a errori o blocchi della fase stessa (le correzioni da approvazione sono conteggiate a parte).
    const retries = s.attempts.filter((a) => a.reason === 'riprova' || (a.reason === 'ripresa_con_feedback' && !correctionTargets.has(s.node.id)));
    if (retries.length) {
      const retryCost = retries.reduce((x, a) => x + (a.usage.costUsd ?? 0), 0);
      const failures = s.attempts.filter((a) => a.status === 'errore').map((a) => a.error ?? a.resultSubtype ?? 'errore');
      out.push({
        id: `retry-${s.node.id}`, severity: retryCost > 0 && total > 0 && retryCost / total > 0.15 ? 'alta' : 'media', nodeId: s.node.id,
        title: I('retry.title', { phase: d.label, count: retries.length }),
        evidence: failures.length
          ? I(`retry.evidenceCauses${sim}`, { cost: usd(retryCost), causes: failures.slice(0, 3).join('; ') })
          : I(`retry.evidence${sim}`, { cost: usd(retryCost) }),
        suggestion: I('retry.suggestion'),
        tradeoff: I('retry.tradeoff'),
      });
    }

    if (readOnly && !d.reuseResult && share(s) >= 0.1 && !hasWriterAncestor(s.node.id)) {
      out.push({
        id: `reuse-${s.node.id}`, severity: 'info', nodeId: s.node.id,
        title: I('reuse.title', { phase: d.label }),
        evidence: I(`reuse.evidence${sim}`, { cost: usd(s.cost) }),
        suggestion: I('reuse.suggestion'),
        tradeoff: I('reuse.tradeoff'),
      });
    }
  }

  // Passaggi potenzialmente ridondanti: due fasi in sola lettura in sequenza diretta.
  for (const e of wf.edges) {
    const a = wf.nodes.find((n) => n.id === e.source);
    const b = wf.nodes.find((n) => n.id === e.target);
    if (!a || !b || !isAgentKind(a.data.kind) || !isAgentKind(b.data.kind)) continue;
    const ro = (n: WorkflowNode) => !n.data.allowedTools.some((x) => WRITE_TOOLS.includes(x));
    const onlyPred = wf.edges.filter((x) => x.target === b.id).length === 1;
    if (ro(a) && ro(b) && onlyPred && a.data.model === b.data.model) {
      out.push({
        id: `merge-${a.id}-${b.id}`, severity: 'info', nodeId: b.id,
        title: I('merge.title', { first: a.data.label, second: b.data.label }),
        evidence: I('merge.evidence'),
        suggestion: I('merge.suggestion'),
        tradeoff: I('merge.tradeoff'),
      });
    }
  }

  const cc = all.reduce((x, s) => x + s.cacheCreate, 0);
  const cr = all.reduce((x, s) => x + s.cacheRead, 0);
  if (cc > 20000 && cr < cc) {
    out.push({
      id: 'cache', severity: 'info',
      title: I('cache.title'),
      evidence: I(`cache.evidence${sim}`, { written: tok(cc), read: tok(cr) }),
      suggestion: I('cache.suggestion'),
      tradeoff: I('cache.tradeoff'),
    });
  }

  if (run.budgetUsd === undefined && run.mode === 'reale' && total > 0) {
    out.push({
      id: 'budget', severity: 'media',
      title: I('budget.title'),
      evidence: I('budget.evidence', { cost: usd(total) }),
      suggestion: I('budget.suggestion', { suggested: usd(Math.max(0.05, total * 1.5)) }),
      tradeoff: I('budget.tradeoff'),
    });
  }

  const order = { alta: 0, media: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}
