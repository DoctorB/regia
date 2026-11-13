import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Workflow } from '../../shared/types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regia-uat-'));
process.env.REGIA_DATA_DIR = path.join(tmp, 'data');
process.env.REGIA_GLOBAL_RULES = path.join(tmp, 'CLAUDE.md');
process.env.REGIA_SKILLS_DIR = path.join(tmp, 'skills');
process.env.REGIA_MOCK_SPEED = '2';

const store = await import('../store.ts');
const { startRun, agentProtocol, parseDeclared } = await import('../engine.ts');
const { AppLogParser } = await import('../uat.ts');
store.initStore();

const waitFor = async (cond: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('log dell\'app: righe dei suoi processi, crash e ANR riconosciuti una volta sola', () => {
  const kept: string[] = [];
  const found: string[] = [];
  const p = new AppLogParser('com.example.app', (l) => kept.push(l), (w) => found.push(w));
  p.pids.add('1234');
  const line = (pid: string, lvl: string, tag: string, text: string) => `11-13 12:00:00.000  ${pid}  ${pid} ${lvl} ${tag}: ${text}`;
  p.feed(line('1234', 'W', 'OkHttp', 'slow response'));
  p.feed(line('999', 'E', 'Other', 'non è dell\'app'));
  p.feed(line('1234', 'E', 'AndroidRuntime', 'FATAL EXCEPTION: main'));
  p.feed(line('1234', 'E', 'AndroidRuntime', 'Process: com.example.app, PID: 1234'));
  p.feed(line('1234', 'E', 'AndroidRuntime', 'java.lang.IllegalStateException: filtro vuoto'));
  p.feed(line('1234', 'E', 'AndroidRuntime', '\tat com.example.app.Filter.apply(Filter.kt:10)'));
  p.feed(line('500', 'E', 'ActivityManager', 'ANR in com.example.app (com.example.app/.Main)'));
  // Crash di un'altra app: ignorato.
  p.feed(line('777', 'E', 'AndroidRuntime', 'FATAL EXCEPTION: main'));
  p.feed(line('777', 'E', 'AndroidRuntime', 'Process: com.other, PID: 777'));
  p.feed(line('777', 'E', 'AndroidRuntime', 'java.lang.NullPointerException'));
  p.closeFatal();
  p.feed('riga non logcat');
  assert.deepEqual(found, ['java.lang.IllegalStateException: filtro vuoto', 'ANR in com.example.app (com.example.app/.Main)']);
  assert.equal(kept.length, 6);
  assert.ok(!kept.some((l) => l.includes('non è dell')));
  assert.ok(!kept.some((l) => l.includes('com.other')));
  assert.equal(p.errors, 5);
});

test('protocollo del collaudo: anomalie come punti e scenari da provare a mano', () => {
  assert.match(agentProtocol('it', 'collaudo'), /"punti"[\s\S]*"manuali"/);
  assert.doesNotMatch(agentProtocol('it', 'test'), /"manuali"/);
  const d = parseDeclared('```regia\n{"esito":"ok","sintesi":"s","punti":["a"],"manuali":["Bluetooth"," "]}\n```');
  assert.deepEqual(d?.manuali, ['Bluetooth']);
});

test('collaudo in prova: build e installazione, poi l\'agente; le anomalie arrivano all\'approvazione', async () => {
  const projectDir = path.join(tmp, 'app');
  fs.mkdirSync(path.join(projectDir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'gradlew'), '');
  fs.writeFileSync(path.join(projectDir, 'app', 'build.gradle.kts'), 'plugins { id("com.android.application") }\nandroid { defaultConfig { applicationId = "it.example.app" } }');
  const phase = { role: '', model: 'sonnet', maxTurns: 10, contextMode: 'sintesi' as const, reuseResult: false };
  const wf: Workflow = {
    id: 'wf_uat', name: 'Collaudo', description: '', updatedAt: '',
    settings: { maxParallel: 1, loadProjectSettings: false, applyGeneralRules: false, projectDir, goal: 'Aggiungi il filtro' },
    nodes: [
      { id: 'impl', position: { x: 0, y: 0 }, data: { ...phase, label: 'Implementazione', kind: 'implementazione', instructions: 'Fai.', allowedTools: ['Read', 'Edit', 'Bash'] } },
      { id: 'uat', position: { x: 0, y: 0 }, data: { ...phase, label: 'Collaudo sul telefono', kind: 'collaudo', instructions: 'Prova il filtro.', allowedTools: ['Read', 'Glob', 'Grep', 'Bash'], show: { target: 'dispositivo' } } },
      { id: 'ok', position: { x: 0, y: 0 }, data: { ...phase, label: 'Approvazione', kind: 'approvazione', instructions: '', model: '', allowedTools: [] } },
    ],
    edges: [{ id: 'e1', source: 'impl', target: 'uat' }, { id: 'e2', source: 'uat', target: 'ok' }],
  };
  const eng = startRun(wf, 'prova');
  const run = eng.run;
  await waitFor(() => run.nodes.ok.status === 'attesa_intervento');
  const st = run.nodes.uat;
  // Due passi nella stessa fase: build (senza agente, non conta come tentativo) e collaudo.
  assert.equal(st.status, 'completata');
  assert.deepEqual(st.attempts.map((a) => a.step ?? 'agente'), ['build', 'agente']);
  assert.equal(st.attempts[0].usage.costUsd, 0);
  assert.ok((st.attempts[1].usage.costUsd ?? 0) > 0);
  assert.ok(run.events.some((e) => e.msg?.key === 'events.uat.installed'));
  // Dopo la build il collaudo non resta un'app avviata: niente stato del comando (né il suo percorso di adb) nell'approvazione.
  assert.equal(st.service, undefined);
  assert.equal(st.uat?.round, 1);
  assert.equal(st.uat?.appId, 'it.example.app');
  // Anomalie come punti nell'approvazione; gli scenari manuali restano nell'esito della fase.
  const pts = run.nodes.ok.reviewPoints!;
  assert.equal(pts[0].nodeId, 'uat');
  assert.match(pts[0].items[0], /Filtro per categoria/);
  assert.match(st.output!, /Da provare a mano:\n- Accoppiamento Bluetooth/);
  // Respingendo, la correzione va all'implementazione e il collaudo si ripete, build compresa, in un nuovo giro.
  await eng.human('ok', 'respingi', '', [{ nodeId: 'uat', index: 0 }]);
  await waitFor(() => run.nodes.ok.status === 'attesa_intervento' && run.nodes.uat.uat?.round === 2);
  assert.match(run.nodes.impl.attempts.at(-1)!.feedback!, /Filtro per categoria/);
  assert.deepEqual(run.nodes.uat.attempts.map((a) => a.step ?? 'agente'), ['build', 'agente', 'build', 'agente']);
  assert.equal(run.nodes.ok.reviewPoints, undefined);
  eng.cancel();
});
