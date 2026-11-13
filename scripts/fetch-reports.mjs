// Scarica le segnalazioni di errore di Regia da trace.lucabottani.dev in local/reports/ (ignorata da git) e ne
// stampa un riepilogo, dalla più recente. Serve il token dell'area admin del servizio:
//   TRACE_ADMIN_TOKEN=... node scripts/fetch-reports.mjs
// oppure, se non è impostato, il file .dev.vars del Worker (ADMIN_TOKEN=...) indicato da TRACE_DEV_VARS
// (predefinito: ../wow-addons/forever-one-button/trace-server/.dev.vars).
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.TRACE_URL || 'https://trace.lucabottani.dev';
const OUT = path.resolve('local', 'reports');

function token() {
  if (process.env.TRACE_ADMIN_TOKEN) return process.env.TRACE_ADMIN_TOKEN;
  const vars = process.env.TRACE_DEV_VARS || path.resolve('..', 'wow-addons', 'forever-one-button', 'trace-server', '.dev.vars');
  const m = fs.existsSync(vars) ? /^ADMIN_TOKEN=(.+)$/m.exec(fs.readFileSync(vars, 'utf8')) : null;
  if (!m) throw new Error('Token mancante: imposta TRACE_ADMIN_TOKEN o TRACE_DEV_VARS.');
  return m[1].trim();
}

const auth = { Authorization: `Bearer ${token()}` };
fs.mkdirSync(OUT, { recursive: true });
let keys = [];
let cursor = null;
do {
  const r = await fetch(`${BASE}/admin/list?prefix=regia/${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: auth });
  if (!r.ok) throw new Error(`Elenco non disponibile (HTTP ${r.status}): token sbagliato?`);
  const page = await r.json();
  keys = keys.concat(page.objects.map((o) => o.key));
  cursor = page.cursor;
} while (cursor);

let fresh = 0;
for (const key of keys) {
  const file = path.join(OUT, key.replace(/^regia\//, '').replace(/\//g, '_'));
  if (fs.existsSync(file)) continue;
  const r = await fetch(`${BASE}/admin/get?key=${encodeURIComponent(key)}`, { headers: auth });
  if (!r.ok) continue;
  fs.writeFileSync(file, JSON.stringify(JSON.parse(await r.text()), null, 2));
  fresh++;
}

const all = fs.readdirSync(OUT).filter((f) => f.endsWith('.json')).sort().reverse()
  .map((f) => ({ f, r: JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')) }));
console.log(`${fresh} nuove, ${all.length} in totale in ${OUT}\n`);
for (const { f, r } of all.slice(0, 30)) {
  console.log(`${f.slice(0, 17)}  ${r.regia}  ${r.source}${r.kind ? `/${r.kind}` : ''}  ${r.install.slice(0, 8)}  ${r.message.replace(/\s+/g, ' ').slice(0, 110)}`);
}
