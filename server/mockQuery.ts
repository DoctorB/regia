// Modalità di prova: genera un flusso di messaggi con la stessa forma di quelli del Claude Agent SDK,
// senza chiamate di rete né costi. Le tariffe usate qui sono FITTIZIE e servono solo a far funzionare
// i grafici: non rappresentano prezzi reali.
import { randomUUID } from 'node:crypto';
import type { Translate } from '../shared/i18n.ts';
import type { PhaseConfig } from '../shared/types.ts';
import { serverT } from './i18n.ts';

const FAKE_RATES: Record<string, [number, number, number, number]> = {
  // USD per milione di token: input, output, scrittura cache, lettura cache (valori fittizi)
  haiku: [1, 5, 1.25, 0.1],
  sonnet: [3, 15, 3.75, 0.3],
  opus: [5, 25, 6.25, 0.5],
};

function tier(model: string) {
  const m = model.toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('opus') || m.includes('fable')) return 'opus';
  return 'sonnet';
}

interface MU { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; webSearchRequests: number; costUSD: number; contextWindow: number; maxOutputTokens: number; costBasis: string }

function emptyMU(): MU {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 200000, maxOutputTokens: 32000, costBasis: 'simulato' };
}

const sessions = new Map<string, Record<string, MU>>();
/** Solo per i test: totali cumulativi per sessione simulata. */
export const mockSessionTotals = (id: string) => Object.values(sessions.get(id) ?? {}).reduce((s, u) => s + u.costUSD, 0);

export interface MockOptions {
  phase: PhaseConfig;
  attemptIndex: number;
  resume?: string;
  maxBudgetUsd?: number;
  signal: AbortSignal;
  stepMs?: number;
  /** Lingua del workflow: i testi simulati dell'agente la seguono. */
  lang?: string;
}

type Step =
  | { kind: 'text'; text: string }
  | { kind: 'tools'; calls: { name: string; input: Record<string, unknown>; result: string }[] }
  | { kind: 'subagent'; description: string; calls: number };

function script(p: PhaseConfig, resumed: boolean, t: Translate): Step[] {
  if (resumed) {
    return [
      { kind: 'text', text: t('mock.decisions.feedback') },
      { kind: 'tools', calls: [{ name: 'Read', input: { file_path: 'src/modulo.js' }, result: t('mock.fileContent') }] },
      { kind: 'tools', calls: [{ name: 'Edit', input: { file_path: 'src/modulo.js' }, result: t('mock.fileUpdated') }] },
    ];
  }
  switch (p.kind) {
    case 'analisi':
      return [
        { kind: 'text', text: t('mock.decisions.analysisStart') },
        { kind: 'tools', calls: [
          { name: 'Glob', input: { pattern: '**/*.js' }, result: 'src/modulo.js\ntest/modulo.test.js' },
          { name: 'Grep', input: { pattern: 'TODO' }, result: 'src/modulo.js:12' },
        ] },
        ...(p.allowedTools.includes('Agent') ? [{ kind: 'subagent' as const, description: t('mock.subagentTask'), calls: 2 }] : []),
        { kind: 'tools', calls: [{ name: 'Read', input: { file_path: 'src/modulo.js' }, result: '…' }] },
        { kind: 'text', text: t('mock.decisions.analysisEnd') },
      ];
    case 'implementazione':
      return [
        { kind: 'text', text: t('mock.decisions.implStart') },
        { kind: 'tools', calls: [{ name: 'Read', input: { file_path: 'src/modulo.js' }, result: '…' }] },
        { kind: 'tools', calls: [{ name: 'Read', input: { file_path: 'src/modulo.js' }, result: '…' }] },
        { kind: 'tools', calls: [{ name: 'Edit', input: { file_path: 'src/modulo.js' }, result: 'ok' }] },
        { kind: 'tools', calls: [{ name: 'Read', input: { file_path: 'src/modulo.js' }, result: '…' }] },
        { kind: 'tools', calls: [{ name: 'Bash', input: { command: 'npm test' }, result: '# pass 5\n# fail 0' }] },
        { kind: 'text', text: t('mock.decisions.implEnd') },
      ];
    case 'test':
      return [
        { kind: 'tools', calls: [{ name: 'Bash', input: { command: 'npm test' }, result: '# pass 5\n# fail 0' }] },
        { kind: 'text', text: t('mock.decisions.test') },
      ];
    case 'revisione':
      return [
        { kind: 'tools', calls: [
          { name: 'Read', input: { file_path: 'src/modulo.js' }, result: '…' },
          { name: 'Read', input: { file_path: 'test/modulo.test.js' }, result: '…' },
        ] },
        { kind: 'text', text: t('mock.decisions.review') },
      ];
    default:
      return [
        { kind: 'tools', calls: [{ name: p.allowedTools[0] ?? 'Read', input: { file_path: 'README.md' }, result: '…' }] },
        { kind: 'text', text: t('mock.decisions.generic') },
      ];
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Annullato'));
    const onAbort = () => { clearTimeout(t); reject(new Error('Annullato')); };
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function* mockQuery(o: MockOptions): AsyncGenerator<Record<string, any>> {
  const p = o.phase;
  const t = serverT(o.lang ?? 'it');
  const alias = tier(p.model || 'sonnet');
  const model = `sim-${alias}`;
  const subModel = 'sim-haiku';
  const sessionId = o.resume ?? randomUUID();
  const prev = o.resume ? sessions.get(o.resume) : undefined;
  const mu: Record<string, MU> = {};
  const stepMs = o.stepMs ?? Number(process.env.REGIA_MOCK_SPEED ?? 600);
  const resumed = Boolean(o.resume);
  const failFirst = p.instructions.includes('[simula-errore]') && o.attemptIndex === 0;
  const blockFirst = p.instructions.includes('[simula-blocco]') && o.attemptIndex === 0;
  const budgetHit = p.instructions.includes('[simula-budget]') && o.attemptIndex === 0;
  // Le fasi di implementazione hanno un contesto più ampio, così da produrre dati interessanti.
  const ctxBase = p.kind === 'implementazione' ? 26000 : p.kind === 'analisi' ? 14000 : 9000;
  let mainOutput = 0;
  let mainInput = 0, mainCC = 0, mainCR = 0;
  let turns = 0;
  const started = Date.now();

  const charge = (m: string, inp: number, out: number, cc: number, cr: number) => {
    const r = FAKE_RATES[tier(m)];
    const u = (mu[m] ??= emptyMU());
    u.inputTokens += inp; u.outputTokens += out; u.cacheCreationInputTokens += cc; u.cacheReadInputTokens += cr;
    u.costUSD += (inp * r[0] + out * r[1] + cc * r[2] + cr * r[3]) / 1e6;
  };
  const spent = () => Object.values(mu).reduce((s, u) => s + u.costUSD, 0);
  const cumulative = () => {
    const out: Record<string, MU> = {};
    for (const src of [prev ?? {}, mu]) for (const [k, v] of Object.entries(src)) {
      const t = (out[k] ??= emptyMU());
      t.inputTokens += v.inputTokens; t.outputTokens += v.outputTokens; t.cacheCreationInputTokens += v.cacheCreationInputTokens; t.cacheReadInputTokens += v.cacheReadInputTokens; t.costUSD += v.costUSD;
    }
    return out;
  };
  const result = (subtype: string, text: string, isError = false) => {
    const total = cumulative();
    sessions.set(sessionId, total);
    return {
      type: 'result', subtype, is_error: isError, result: text, num_turns: turns, session_id: sessionId,
      duration_ms: Date.now() - started, duration_api_ms: Math.round((Date.now() - started) * 0.8),
      total_cost_usd: Object.values(total).reduce((s, u) => s + u.costUSD, 0),
      usage: { input_tokens: mainInput, output_tokens: mainOutput, cache_creation_input_tokens: mainCC, cache_read_input_tokens: mainCR },
      modelUsage: total, permission_denials: [], errors: isError ? [text] : [], uuid: randomUUID(),
    };
  };

  yield { type: 'system', subtype: 'init', apiKeySource: 'none', model, session_id: sessionId, tools: p.allowedTools, cwd: '(simulato)', permissionMode: 'dontAsk' };
  await sleep(stepMs / 2, o.signal);

  const steps = script(p, resumed, t);
  let ctx = ctxBase + (prev ? 6000 : 0);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    await sleep(stepMs, o.signal);
    turns++;
    const msgId = `msg_sim_${randomUUID().slice(0, 12)}`;
    // Il primo passo crea la cache, i successivi la leggono.
    const usage = { input_tokens: 40 + i * 15, output_tokens: 1, cache_creation_input_tokens: i === 0 ? ctx : 900, cache_read_input_tokens: i === 0 ? 0 : ctx };
    const out = s.kind === 'text' ? 120 : 80;
    mainInput += usage.input_tokens; mainCC += usage.cache_creation_input_tokens; mainCR += usage.cache_read_input_tokens; mainOutput += out;
    charge(model, usage.input_tokens, out, usage.cache_creation_input_tokens, usage.cache_read_input_tokens);
    ctx += 1100;
    const base = { type: 'assistant', parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() };
    if (s.kind === 'text') {
      yield { ...base, message: { id: msgId, model, role: 'assistant', content: [{ type: 'thinking', thinking: t('mock.thinking') }, { type: 'text', text: s.text }], usage } };
    } else if (s.kind === 'tools') {
      // Chiamate in parallelo: un messaggio per blocco, tutti con lo stesso id e la stessa usage.
      const ids = s.calls.map(() => `toolu_sim_${randomUUID().slice(0, 10)}`);
      for (let k = 0; k < s.calls.length; k++) {
        yield { ...base, uuid: randomUUID(), message: { id: msgId, model, role: 'assistant', content: [{ type: 'tool_use', id: ids[k], name: s.calls[k].name, input: s.calls[k].input }], usage } };
      }
      await sleep(stepMs / 2, o.signal);
      for (let k = 0; k < s.calls.length; k++) {
        yield { type: 'user', parent_tool_use_id: null, session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: ids[k], content: s.calls[k].result }] } };
      }
    } else {
      const toolId = `toolu_sim_${randomUUID().slice(0, 10)}`;
      yield { ...base, message: { id: msgId, model, role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Agent', input: { description: s.description, subagent_type: 'Explore' } }], usage } };
      yield { type: 'system', subtype: 'task_started', task_id: `task_${toolId}`, tool_use_id: toolId, description: s.description, session_id: sessionId };
      let subTokens = 0;
      for (let k = 0; k < s.calls; k++) {
        await sleep(stepMs / 2, o.signal);
        const su = { input_tokens: 30, output_tokens: 1, cache_creation_input_tokens: k === 0 ? 5000 : 300, cache_read_input_tokens: k === 0 ? 0 : 5000 };
        charge(subModel, su.input_tokens, 200, su.cache_creation_input_tokens, su.cache_read_input_tokens);
        subTokens += su.input_tokens + 200 + su.cache_creation_input_tokens + su.cache_read_input_tokens;
        const sid = `msg_sim_sub_${randomUUID().slice(0, 10)}`;
        yield { type: 'assistant', parent_tool_use_id: toolId, session_id: sessionId, uuid: randomUUID(), message: { id: sid, model: subModel, role: 'assistant', content: [{ type: 'tool_use', id: `toolu_sub_${k}`, name: 'Read', input: { file_path: 'test/modulo.test.js' } }], usage: su } };
      }
      yield { type: 'system', subtype: 'task_notification', task_id: `task_${toolId}`, tool_use_id: toolId, status: 'completed', summary: t('mock.subagentSummary'), usage: { total_tokens: subTokens, tool_uses: s.calls }, session_id: sessionId };
      yield { type: 'user', parent_tool_use_id: null, session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: t('mock.subagentSummary') }] } };
    }
    if (failFirst && i === 1) {
      // Crash simulato: il result di errore arriva con i valori azzerati, come documentato.
      const r = result('error_during_execution', t('mock.crash'), true);
      yield { ...r, total_cost_usd: 0, modelUsage: {}, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
      return;
    }
    const limit = budgetHit ? spent() * 0.5 : o.maxBudgetUsd;
    if (limit !== undefined && spent() > limit) {
      yield result('error_max_budget_usd', t('mock.budgetReached', { limit: limit.toFixed(4) }), true);
      return;
    }
  }

  await sleep(stepMs, o.signal);
  turns++;
  const esito = blockFirst ? 'bloccato' : 'ok';
  const sintesi = blockFirst
    ? t('mock.summary.blocked')
    : resumed ? t('mock.summary.resumed') : t('mock.summary.done', { label: p.label });
  const decisione = t('mock.finalDecision', { outcome: esito, label: p.label });
  const finalText = `${t('mock.workDone')}\n\n\`\`\`regia\n${JSON.stringify({ esito, sintesi, decisioni: [decisione] }, null, 1)}\n\`\`\``;
  const fid = `msg_sim_${randomUUID().slice(0, 12)}`;
  const usage = { input_tokens: 20, output_tokens: 1, cache_creation_input_tokens: 400, cache_read_input_tokens: ctx };
  mainInput += 20; mainCC += 400; mainCR += ctx; mainOutput += 260;
  charge(model, 20, 260, 400, ctx);
  yield { type: 'assistant', parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID(), message: { id: fid, model, role: 'assistant', content: [{ type: 'text', text: finalText }], usage } };
  yield result('success', finalText);
}
