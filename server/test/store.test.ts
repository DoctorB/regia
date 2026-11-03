import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Run, Workflow } from '../../shared/types.ts';

process.env.REGIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'regia-store-'));
const store = await import('../store.ts');
store.initStore();

const wf = (id: string, group?: string): Workflow => ({
  id, name: id, description: '', group, updatedAt: '',
  settings: { projectDir: '', goal: '', maxParallel: 1, loadProjectSettings: false }, nodes: [], edges: [],
});
const run = (id: string, workflowId: string): Run => ({
  id, workflowId, workflowName: workflowId, snapshot: wf(workflowId), mode: 'prova', status: 'completata', startedAt: new Date().toISOString(),
  nodes: {}, events: [], totals: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUsd: 0, byModel: {} }, notes: [],
});

test('il gruppo viene salvato con il workflow', () => {
  store.saveWorkflow(wf('wf_a', 'Progetto X'));
  assert.equal(store.getWorkflow('wf_a')?.group, 'Progetto X');
});

test('eliminazione delle esecuzioni di un workflow, tranne quelle da tenere', () => {
  store.saveWorkflow(wf('wf_b'));
  store.saveRun(run('run_b1', 'wf_b'));
  store.saveRun(run('run_b2', 'wf_b'));
  store.saveRun(run('run_b3', 'wf_b'));
  store.saveRun(run('run_other', 'wf_a'));
  const removed = store.deleteRunsOf('wf_b', (id) => id === 'run_b2');
  assert.equal(removed, 2);
  assert.deepEqual(store.listRuns('wf_b').map((r) => r.id), ['run_b2']);
  assert.equal(store.listRuns('wf_a').length, 1, 'le esecuzioni degli altri workflow restano');
});
