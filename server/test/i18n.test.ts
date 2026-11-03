import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranslator, flatten } from '../../shared/i18n.ts';
import { languages, mergedDict, serverT } from '../i18n.ts';

test('ogni lingua prevale sulle lingue di riserva', () => {
  assert.equal(mergedDict('it')['kinds.analisi.label'], 'Analisi');
  assert.equal(mergedDict('en')['kinds.analisi.label'], 'Analysis');
  assert.equal(serverT('it')('kinds.revisione.label'), 'Revisione');
  assert.equal(serverT('en')('kinds.revisione.label'), 'Review');
});

test('lingua sconosciuta o chiave mancante: riserva inglese, poi la chiave stessa', () => {
  assert.equal(serverT('fr')('kinds.analisi.label'), 'Analysis');
  assert.equal(serverT('it')('chiave.inesistente'), 'chiave.inesistente');
});

test('parametri e plurali', () => {
  const t = createTranslator([flatten({ a: { n: { one: '{count} fase', other: '{count} fasi' }, p: 'Ciao {name}' } })], 'it-IT');
  assert.equal(t('a.n', { count: 1 }), '1 fase');
  assert.equal(t('a.n', { count: 12000 }), '12.000 fasi');
  assert.equal(t('a.p', { name: 'Luca' }), 'Ciao Luca');
  assert.equal(t('a.p'), 'Ciao {name}');
});

test('italiano e inglese disponibili, con le stesse chiavi', () => {
  const codes = languages().map((l) => l.code);
  assert.ok(codes.includes('it') && codes.includes('en'));
  const it = Object.keys(mergedDict('it')).sort();
  const en = Object.keys(mergedDict('en')).sort();
  assert.deepEqual(it, en);
});
