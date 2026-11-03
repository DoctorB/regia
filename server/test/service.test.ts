import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLocalUrl, outputLines } from '../service.ts';

const firstUrl = (raw: string) => outputLines(raw).map(extractLocalUrl).find(Boolean) ?? null;

test('log JSON di Astro: righe leggibili e indirizzo pulito', () => {
  const raw = '{"message":" astro  v7.4.4 ready in 3090 ms\\n┃ Local    http://localhost:4321/\\n┃ Network  use --host to expose","label":"SKIP_FORMAT","level":"info"}';
  assert.deepEqual(outputLines(raw), ['astro  v7.4.4 ready in 3090 ms', '  ┃ Local    http://localhost:4321/', '  ┃ Network  use --host to expose'].map((l, i) => (i === 0 ? ' ' + l : l)));
  assert.equal(firstUrl(raw), 'http://localhost:4321/');
  assert.deepEqual(outputLines('{"message":"connected.","label":"vite","level":"info"}'), ['[vite] connected.']);
  assert.deepEqual(outputLines('{"message":"route non trovata","label":"router","level":"warn"}'), ['WARN [router] route non trovata']);
});

test('indirizzi nei formati più comuni', () => {
  const cases: [string, string | null][] = [
    ['  ➜  Local:   http://localhost:5173/', 'http://localhost:5173/'],
    ['   - Local:        http://localhost:3000', 'http://localhost:3000'],
    ['Server running at http://127.0.0.1:8080.', 'http://127.0.0.1:8080'],
    ['Listening on http://0.0.0.0:8000/ (Press CTRL+C to quit)', 'http://localhost:8000/'],
    ['open (http://localhost:4200/)', 'http://localhost:4200/'],
    ['"url":"http://localhost:4321/\\n┃"', 'http://localhost:4321/'],
    ['┃ Local    http://localhost:4321/┃', 'http://localhost:4321/'],
    ['http://localhost:5173/app/?x=1#y', 'http://localhost:5173/app/?x=1#y'],
    ['Network: use --host to expose', null],
    ['https://example.com/docs', null],
  ];
  for (const [line, want] of cases) assert.equal(firstUrl(line), want, line);
});
