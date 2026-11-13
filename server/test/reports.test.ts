import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regia-reports-'));
process.env.REGIA_DATA_DIR = path.join(tmp, 'data');

// Servizio di raccolta finto: registra i corpi ricevuti; "down" simula la rete assente.
const received: Record<string, unknown>[] = [];
let down = false;
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (down) { res.statusCode = 503; return void res.end(); }
    received.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json');
    res.end('{"ok":true}');
  });
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
process.env.REGIA_REPORTS_URL = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/regia/report`;

const store = await import('../store.ts');
const reports = await import('../reports.ts');
store.initStore();

const projectDir = path.join(tmp, 'Clienti', 'Progetto Segreto');
fs.mkdirSync(projectDir, { recursive: true });
store.saveWorkflow({
  id: 'wf_r', name: 'R', description: '', updatedAt: '', nodes: [], edges: [],
  settings: { maxParallel: 1, loadProjectSettings: false, projectDir, goal: '' },
});

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('senza consenso non si salva né si invia nulla; con REGIA_REPORTS=0 nemmeno con il consenso', async () => {
  reports.report({ source: 'fase', key: 'events.phaseFailed', message: 'errore uno' });
  assert.equal(reports.reportsInfo().consent, undefined);
  assert.equal(reports.reportsInfo().reports.length, 0);
  reports.setConsent('si');
  process.env.REGIA_REPORTS = '0';
  reports.report({ source: 'fase', key: 'events.phaseFailed', message: 'errore due' });
  assert.equal(reports.reportsInfo().disabled, true);
  delete process.env.REGIA_REPORTS;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(received.length, 0);
  assert.equal(reports.reportsInfo().reports.length, 0);
});

test('anonimizzazione: progetto, cartella utente, nome utente, email e segreti spariscono', () => {
  const user = os.userInfo().username;
  const text = `Build fallita in ${projectDir}\\app e ${projectDir.replace(/\\/g, '/')}/src; home ${os.homedir()}\\x; utente ${user}; mail mario.rossi@example.com; ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789`;
  const a = reports.anonymize(text);
  assert.ok(!a.includes('Progetto Segreto'), a);
  assert.ok(a.includes('<progetto>\\app') && a.includes('<progetto>/src'), a);
  assert.ok(!a.includes(os.homedir()), a);
  if (user.length >= 3) assert.ok(!new RegExp(`\\b${user}\\b`, 'i').test(a), a);
  assert.ok(a.includes('<email>') && !a.includes('mario.rossi'), a);
  assert.ok(!a.includes('abcdefghijklmnopqrstuvwxyz0123456789'), a);
});

test('con il consenso: copia locale, invio senza i campi locali, stesso errore non rimandato prima di 24 ore', async () => {
  reports.report({ source: 'fase', key: 'events.phaseFailed', kind: 'collaudo', lang: 'it', message: `Collaudo: errore in ${projectDir} (porta 51234)`, detail: 'riga\nriga' });
  await waitFor(() => received.length === 1);
  const got = received[0];
  assert.equal(got.v, 1);
  assert.equal(got.source, 'fase');
  assert.equal(got.kind, 'collaudo');
  assert.match(String(got.message), /<progetto>/);
  assert.match(String(got.install), /^[0-9a-f-]{36}$/);
  assert.equal(got.sent, undefined);
  await waitFor(() => reports.reportsInfo().reports[0]?.sent === true);
  // Stesso errore, numeri diversi: è lo stesso, non si rimanda.
  reports.report({ source: 'fase', key: 'events.phaseFailed', kind: 'collaudo', message: `Collaudo: errore in ${projectDir} (porta 60000)` });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, 1);
});

test('senza rete la segnalazione resta in coda e parte con il primo invio successivo', async () => {
  down = true;
  reports.report({ source: 'server', key: 'uncaught', message: 'TypeError: x is undefined' });
  await new Promise((r) => setTimeout(r, 200));
  const queued = reports.reportsInfo().reports.find((r) => r.source === 'server')!;
  assert.equal(queued.sent, false);
  down = false;
  await reports.flush();
  assert.equal(received.length, 2);
  assert.equal(reports.reportsInfo().reports.find((r) => r.source === 'server')!.sent, true);
  // Revocando il consenso non parte più nulla.
  reports.setConsent('no');
  reports.report({ source: 'ui', message: 'altro errore' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, 2);
  srv.close();
});
