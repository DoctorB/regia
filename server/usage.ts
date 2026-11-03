// Contabilità dei consumi. Regole (dalla documentazione del Claude Agent SDK, "Track cost and usage"):
// - I messaggi assistant con lo stesso message.id (chiamate di strumenti in parallelo) riportano la
//   stessa usage: si contano una volta sola.
// - output_tokens sui messaggi assistant è un segnaposto: l'output reale si legge dal result.
// - result.usage copre solo il ciclo principale; result.modelUsage e total_cost_usd includono i subagenti.
//   Per i totali si usa modelUsage.
// - Una chiamata che riprende una sessione (resume) riporta anche la spesa precedente della sessione:
//   si registra solo la differenza rispetto ai totali già contati per quella sessione.
// - Un result di crash può avere valori azzerati: in quel caso si ricade sui contatori live (solo input/cache).
// - Tutti i costi sono stime calcolate dal SDK, non dati di fatturazione.
import type { Attempt, ModelUsageEntry, UsageTotals } from '../shared/types.ts';
import { emptyTotals } from '../shared/types.ts';

export interface SessionSnapshot { costUsd: number; byModel: Record<string, ModelUsageEntry> }

type AnyMsg = Record<string, any>;

export function totalsFromModelUsage(modelUsage: Record<string, AnyMsg> | undefined, totalCost: number | undefined, costBasisOverride?: string): UsageTotals {
  const t = emptyTotals();
  let sumCost = 0;
  for (const [model, u] of Object.entries(modelUsage ?? {})) {
    const e: ModelUsageEntry = {
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cacheCreationInputTokens: u.cacheCreationInputTokens ?? 0,
      cacheReadInputTokens: u.cacheReadInputTokens ?? 0,
      costUsd: u.costUSD ?? 0,
      costBasis: costBasisOverride ?? u.costBasis ?? 'list',
    };
    t.byModel[model] = e;
    addEntry(t, e);
    sumCost += e.costUsd;
  }
  t.costUsd = typeof totalCost === 'number' ? totalCost : sumCost;
  return t;
}

function addEntry(t: UsageTotals, e: ModelUsageEntry) {
  t.inputTokens += e.inputTokens;
  t.outputTokens += e.outputTokens;
  t.cacheCreationInputTokens += e.cacheCreationInputTokens;
  t.cacheReadInputTokens += e.cacheReadInputTokens;
}

/** cur - prev per modello, con limite a zero. */
export function subtractTotals(cur: UsageTotals, prev: SessionSnapshot): UsageTotals {
  const out = emptyTotals();
  for (const [model, e] of Object.entries(cur.byModel)) {
    const p = prev.byModel[model];
    const d: ModelUsageEntry = {
      inputTokens: Math.max(0, e.inputTokens - (p?.inputTokens ?? 0)),
      outputTokens: Math.max(0, e.outputTokens - (p?.outputTokens ?? 0)),
      cacheCreationInputTokens: Math.max(0, e.cacheCreationInputTokens - (p?.cacheCreationInputTokens ?? 0)),
      cacheReadInputTokens: Math.max(0, e.cacheReadInputTokens - (p?.cacheReadInputTokens ?? 0)),
      costUsd: Math.max(0, e.costUsd - (p?.costUsd ?? 0)),
      costBasis: e.costBasis,
    };
    if (d.inputTokens + d.outputTokens + d.cacheCreationInputTokens + d.cacheReadInputTokens > 0 || d.costUsd > 0) {
      out.byModel[model] = d;
      addEntry(out, d);
    }
  }
  out.costUsd = Math.max(0, (cur.costUsd ?? 0) - prev.costUsd);
  return out;
}

export function sumTotals(list: UsageTotals[]): UsageTotals & { unknownCost: boolean } {
  const t = emptyTotals() as UsageTotals & { unknownCost: boolean };
  t.unknownCost = false;
  let cost = 0;
  for (const u of list) {
    for (const [model, e] of Object.entries(u.byModel)) {
      const m = (t.byModel[model] ??= { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUsd: 0, costBasis: e.costBasis });
      m.inputTokens += e.inputTokens;
      m.outputTokens += e.outputTokens;
      m.cacheCreationInputTokens += e.cacheCreationInputTokens;
      m.cacheReadInputTokens += e.cacheReadInputTokens;
      m.costUsd += e.costUsd;
    }
    t.inputTokens += u.inputTokens;
    t.outputTokens += u.outputTokens;
    t.cacheCreationInputTokens += u.cacheCreationInputTokens;
    t.cacheReadInputTokens += u.cacheReadInputTokens;
    if (u.costUsd === null) t.unknownCost = true;
    else cost += u.costUsd;
  }
  t.costUsd = cost;
  return t;
}

export class AttemptAccounting {
  private seen = new Set<string>();
  private seenSub = new Set<string>();
  constructor(private attempt: Attempt, private baseline?: SessionSnapshot, private costBasisOverride?: string) {}

  /** Restituisce true se il messaggio è un duplicato (stesso message.id già contato). */
  onAssistant(msg: AnyMsg): boolean {
    const id: string | undefined = msg.message?.id;
    const usage = msg.message?.usage;
    const live = this.attempt.live;
    if (msg.parent_tool_use_id) {
      // Messaggi dei subagenti: non sommati ai contatori live (sono già inclusi in modelUsage a fine fase).
      if (id && !this.seenSub.has(id)) {
        this.seenSub.add(id);
        live.subagentMessages++;
      }
      return false;
    }
    if (!id) return false;
    if (this.seen.has(id)) {
      live.duplicatesSkipped++;
      return true;
    }
    this.seen.add(id);
    live.steps++;
    if (usage) {
      live.inputTokens += usage.input_tokens ?? 0;
      live.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0;
      live.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0;
    }
    if (msg.message?.model && !this.attempt.models.includes(msg.message.model)) this.attempt.models.push(msg.message.model);
    return false;
  }

  /** Applica il messaggio result. Restituisce lo snapshot cumulativo della sessione (per future riprese). */
  onResult(msg: AnyMsg): SessionSnapshot | null {
    const a = this.attempt;
    a.numTurns = msg.num_turns;
    a.durationMs = msg.duration_ms;
    a.durationApiMs = msg.duration_api_ms;
    a.resultSubtype = msg.subtype;
    const cur = totalsFromModelUsage(msg.modelUsage, msg.total_cost_usd, this.costBasisOverride);
    for (const m of Object.keys(cur.byModel)) if (!a.models.includes(m)) a.models.push(m);
    const zeroed = Object.keys(msg.modelUsage ?? {}).length === 0 && !msg.total_cost_usd;
    if (zeroed) {
      this.applyPartial();
      return null;
    }
    const snapshot: SessionSnapshot = { costUsd: cur.costUsd ?? 0, byModel: cur.byModel };
    if (this.baseline && (cur.costUsd ?? 0) + 1e-9 >= this.baseline.costUsd) {
      a.usage = subtractTotals(cur, this.baseline);
      a.usageSource = 'delta_ripresa';
    } else {
      // Nessuna ripresa, oppure la CLI non ha ripristinato i totali precedenti (versioni < 2.1.277):
      // in quel caso il result copre già solo questa chiamata.
      a.usage = cur;
      a.usageSource = 'risultato';
    }
    return snapshot;
  }

  /** Nessun result utilizzabile: solo input e cache del ciclo principale, costo sconosciuto. */
  applyPartial() {
    const a = this.attempt;
    a.usage = {
      inputTokens: a.live.inputTokens,
      outputTokens: 0,
      cacheCreationInputTokens: a.live.cacheCreationInputTokens,
      cacheReadInputTokens: a.live.cacheReadInputTokens,
      costUsd: null,
      byModel: {},
    };
    a.usageSource = a.live.steps > 0 ? 'parziale' : 'nessuno';
    if (a.live.steps === 0) a.usage.costUsd = 0;
  }
}
