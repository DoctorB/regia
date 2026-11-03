import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AttemptAccounting, sumTotals } from '../usage.ts';
import { emptyTotals, type Attempt } from '../../shared/types.ts';

function attempt(): Attempt {
  return {
    id: 'n#1', nodeId: 'n', index: 0, reason: 'iniziale', startedAt: '', status: 'attiva', models: [], usage: emptyTotals(), usageSource: 'nessuno',
    live: { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, steps: 0, duplicatesSkipped: 0, subagentMessages: 0 }, toolCalls: [], subagents: 0,
  };
}
const asst = (id: string, input: number, parent: string | null = null) => ({
  type: 'assistant', parent_tool_use_id: parent, message: { id, model: 'm', usage: { input_tokens: input, output_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 100 } },
});
const mu = (inp: number, out: number, cost: number) => ({ inputTokens: inp, outputTokens: out, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUSD: cost });

test('messaggi con lo stesso id (strumenti in parallelo) contati una volta', () => {
  const a = attempt();
  const acc = new AttemptAccounting(a);
  acc.onAssistant(asst('m1', 50));
  acc.onAssistant(asst('m1', 50));
  acc.onAssistant(asst('m1', 50));
  acc.onAssistant(asst('m2', 30));
  assert.equal(a.live.inputTokens, 80);
  assert.equal(a.live.steps, 2);
  assert.equal(a.live.duplicatesSkipped, 2);
});

test('messaggi dei subagenti esclusi dai contatori live, inclusi via modelUsage', () => {
  const a = attempt();
  const acc = new AttemptAccounting(a);
  acc.onAssistant(asst('m1', 50));
  acc.onAssistant(asst('s1', 999, 'toolu_1'));
  assert.equal(a.live.inputTokens, 50);
  assert.equal(a.live.subagentMessages, 1);
  acc.onResult({ subtype: 'success', num_turns: 2, total_cost_usd: 0.5, modelUsage: { main: mu(100, 40, 0.4), sub: mu(999, 20, 0.1) } });
  assert.equal(a.usage.inputTokens, 1099);
  assert.equal(a.usage.outputTokens, 60);
  assert.equal(a.usage.costUsd, 0.5);
  assert.equal(a.usageSource, 'risultato');
});

test('sessione ripresa: si conta solo la differenza', () => {
  const a = attempt();
  const acc = new AttemptAccounting(a, { costUsd: 0.4, byModel: { main: { ...mu(100, 40, 0.4), costBasis: 'list', costUsd: 0.4 } as any } });
  acc.onResult({ subtype: 'success', total_cost_usd: 0.55, modelUsage: { main: mu(150, 60, 0.55) } });
  assert.equal(a.usageSource, 'delta_ripresa');
  assert.ok(Math.abs((a.usage.costUsd ?? 0) - 0.15) < 1e-9);
  assert.equal(a.usage.inputTokens, 50);
  assert.equal(a.usage.outputTokens, 20);
});

test('ripresa su CLI che non ripristina i totali: nessuna sottrazione', () => {
  const a = attempt();
  const acc = new AttemptAccounting(a, { costUsd: 0.4, byModel: {} });
  acc.onResult({ subtype: 'success', total_cost_usd: 0.1, modelUsage: { main: mu(30, 10, 0.1) } });
  assert.equal(a.usageSource, 'risultato');
  assert.equal(a.usage.costUsd, 0.1);
});

test('result di crash azzerato: ricaduta sui contatori live, costo sconosciuto', () => {
  const a = attempt();
  const acc = new AttemptAccounting(a);
  acc.onAssistant(asst('m1', 70));
  acc.onResult({ subtype: 'error_during_execution', total_cost_usd: 0, modelUsage: {} });
  assert.equal(a.usageSource, 'parziale');
  assert.equal(a.usage.costUsd, null);
  assert.equal(a.usage.inputTokens, 70);
  const s = sumTotals([a.usage, { ...emptyTotals(), costUsd: 1 }]);
  assert.equal(s.unknownCost, true);
  assert.equal(s.costUsd, 1);
});
