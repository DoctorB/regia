import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regia-trace-'));
process.env.REGIA_DATA_DIR = path.join(tmp, 'data');
const { ServiceTrace, descendants, describeTree, psDuration, rel } = await import('../servicetrace.ts');

test('log di diagnosi: istanti, pause lunghe e silenzio finale', () => {
  const t0 = Date.parse('2026-11-18T14:00:00Z');
  const file = path.join(tmp, 'a.log');
  const tr = new ServiceTrace(file, { comando: 'gradlew installDebug', vuoto: '' }, t0);
  tr.line('> Task :app:compile', '', t0 + 1000);
  tr.line('> Task :app:dex', '', t0 + 2000);
  tr.line('> Task :app:mergeGlobalDebugGlobalSynthetics', '', t0 + 95_000);
  tr.line('BE pronto', '[be]', t0 + 96_000);
  tr.note('attesa finita', t0 + 1_200_000);
  const s = tr.summary(t0 + 1_200_000);
  assert.equal(s.elapsedSec, 1200);
  assert.equal(s.silentSec, 1104);
  assert.equal(s.lines, 4);
  assert.equal(s.lastLine, '[be] BE pronto');
  // Il silenzio in corso è la pausa più lunga, poi quella di 93 secondi dopo "dex".
  assert.deepEqual(s.gaps.map((g) => g.sec), [1104, 93]);
  assert.equal(s.gaps[1].after, '> Task :app:dex');
  tr.close('fine');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^comando: gradlew installDebug$/m);
  assert.doesNotMatch(text, /^vuoto:/m);
  assert.match(text, /^\[\+00:01\] > Task :app:compile$/m);
  assert.match(text, /^\[\+01:35\] ## silenzio di 93 s$/m);
  assert.match(text, /^\[\+01:36\] \[be\] BE pronto$/m);
  assert.match(text, /^\[\+20:00\] ## attesa finita$/m);
  assert.match(text, /## fine\n$/);
  // Dopo la chiusura le scritture non fanno nulla (e non lanciano errori).
  tr.line('tardi');
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('riepilogo per le segnalazioni: testa sempre presente, righe recenti entro il limite', () => {
  const t0 = 0;
  const tr = new ServiceTrace(path.join(tmp, 'b.log'), {}, t0);
  for (let i = 0; i < 40; i++) tr.line(`riga ${i} ${'x'.repeat(100)}`, '', t0 + i * 1000);
  const procs = [
    { pid: 10, ppid: 1, name: 'cmd.exe', cpuSec: 0, ageSec: 1200 },
    { pid: 11, ppid: 10, name: 'java.exe', cpuSec: 312, ageSec: 1199 },
  ];
  const d = tr.reportDetail(procs, 1000, t0 + 600_000);
  assert.ok(d.length <= 1000, String(d.length));
  assert.match(d, /^tempo: 600 s · silenzio finale: 561 s · righe: 40$/m);
  assert.match(d, /^pausa di 561 s a \+00:39 dopo: riga 39/m);
  assert.match(d, /^processi ancora attivi: cmd\.exe \(cpu 0 s, da 1200 s\) › java\.exe \(cpu 312 s, da 1199 s\)$/m);
  assert.match(d, /\[\+00:39\] riga 39 x+$/);
  assert.doesNotMatch(d, /riga 0 /);
  assert.match(tr.reportDetail(undefined, 7000, t0 + 1000), /^tempo: 1 s/);
  assert.doesNotMatch(tr.reportDetail(undefined), /processi/);
  tr.close();
});

test('albero dei processi e durate di ps', () => {
  const all = [
    { pid: 1, ppid: 0, name: 'init' },
    { pid: 10, ppid: 1, name: 'sh' },
    { pid: 11, ppid: 10, name: 'java' },
    { pid: 12, ppid: 11, name: 'adb' },
    { pid: 13, ppid: 1, name: 'altro' },
    { pid: 14, ppid: 14, name: 'ciclo' },
  ];
  assert.deepEqual(descendants(all, 10).map((p) => p.name), ['sh', 'java', 'adb']);
  assert.deepEqual(descendants(all, 99), []);
  assert.equal(describeTree([{ pid: 1, ppid: 0, name: 'sh' }]), 'sh');
  assert.equal(psDuration('05:07'), 307);
  assert.equal(psDuration('01:00:00'), 3600);
  assert.equal(psDuration('2-00:00:01'), 172801);
  assert.equal(psDuration('n/d'), undefined);
  assert.equal(rel(61_500), '+01:01');
});
