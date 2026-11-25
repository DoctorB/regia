import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UserStory } from '../../shared/types.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regia-criteria-'));
process.env.REGIA_DATA_DIR = path.join(tmp, 'data');

const { parseCriteria, criteriaHtml, criteriaText, criteriaFileName } = await import('../criteria.ts');
const { parseDeclared, agentProtocol } = await import('../engine.ts');
const { serverT } = await import('../i18n.ts');

const story: UserStory = {
  url: 'https://dev.azure.com/org/prog/_workitems/edit/42', provider: 'azure', id: '42', type: 'User Story', title: 'Salvataggio <modulo>',
  description: 'Come utente voglio salvare il modulo.', images: [], imagesFound: 0, fetchedAt: '2026-11-25T10:00:00Z', dir: 'x',
};

test('criteri: stati e valutazioni sconosciuti diventano i valori prudenti, id mancanti o doppi vengono rinumerati', () => {
  const c = parseCriteria({
    proposti: [
      { id: 'AC1', testo: 'Quando salvo, allora vedo la conferma.', stato: 'coperto', acUs: 'Si può salvare.' },
      { id: 'AC1', testo: 'Quando manca un campo, allora non salva.', stato: 'boh' },
      'Quando esco senza salvare, allora mi chiede conferma.',
      { testo: '  ' },
    ],
    esistenti: [{ testo: 'Gestire gli errori.', valutazione: 'vago', nota: 'quali?' }, { testo: 'Si può salvare.', valutazione: 'strano' }],
    note: [{ argomento: 'Uscita', domanda: 'Va salvata una bozza?', criteri: ['AC3', 7] }, { domanda: '' }],
  })!;
  assert.deepEqual(c.proposti.map((x) => [x.id, x.stato]), [['AC1', 'coperto'], ['AC2', 'nuovo'], ['AC3', 'nuovo']]);
  assert.deepEqual(c.esistenti.map((x) => x.valutazione), ['vago', 'ok']);
  assert.deepEqual(c.note, [{ argomento: 'Uscita', domanda: 'Va salvata una bozza?', criteri: ['AC3', '7'] }]);
  assert.equal(parseCriteria({ proposti: [], esistenti: [], note: [] }), undefined);
  assert.equal(parseCriteria('testo'), undefined);
});

test('criteri nel blocco di esito e nel protocollo della fase', () => {
  const d = parseDeclared('```regia\n{"esito":"ok","sintesi":"s","decisioni":[],"criteri":{"proposti":[{"id":"AC1","testo":"Quando A, allora B.","stato":"da_confermare"}],"note":[{"domanda":"Chi può farlo?"}]}}\n```');
  assert.equal(d?.criteri?.proposti[0].stato, 'da_confermare');
  assert.equal(parseDeclared('```regia\n{"esito":"ok","sintesi":"s","decisioni":[]}\n```')?.criteri, undefined);
  assert.match(agentProtocol('it', 'analisi', true), /"criteri"[\s\S]*"proposti"[\s\S]*"esistenti"[\s\S]*"note"/);
  assert.match(agentProtocol('en', 'analisi', true), /"da_confermare"/);
  assert.doesNotMatch(agentProtocol('it', 'analisi'), /"criteri"/);
  const text = criteriaText(d!.criteri!, serverT('it'));
  assert.match(text, /Criteri di accettazione proposti:\n- AC1 \[Da confermare\]: Quando A, allora B\.\nSpecifiche mancanti nella user story:\n- Chi può farlo\?/);
});

test('pagina HTML: testi escapati, contenuto da copiare, user story senza criteri segnalata', () => {
  const c = parseCriteria({
    proposti: [{ id: 'AC1', testo: 'Quando inserisco <script>alert(1)</script>, allora è mostrato come testo.', stato: 'nuovo' }, { id: 'AC2', testo: 'Quando esco, allora chiede conferma.', stato: 'da_confermare' }],
    note: [{ argomento: 'Uscita', domanda: 'Bozza o perdita delle modifiche?', criteri: ['AC2'] }],
  })!;
  const html = criteriaHtml({ criteria: c, story, workflowName: 'Criteri', generatedAt: '2026-11-25T10:00:00Z', lang: 'it', t: serverT('it') });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Salvataggio &lt;modulo&gt;/);
  assert.match(html, /<template id="copy-ac-html"><ol><li><b>AC1<\/b>/);
  assert.match(html, /- \*\*AC2\*\* – Quando esco, allora chiede conferma\. \[Da confermare\]/);
  assert.match(html, /Specifiche mancanti[\s\S]*Bozza o perdita delle modifiche\?[\s\S]*href="#AC2"/);
  assert.match(html, /La user story non ha criteri di accettazione/);
  // Con criteri già nella user story l'avviso non compare.
  const withAc = criteriaHtml({ criteria: c, story: { ...story, acceptance: 'Si può salvare.' }, workflowName: 'Criteri', generatedAt: '2026-11-25T10:00:00Z', lang: 'en', t: serverT('en') });
  assert.doesNotMatch(withAc, /has no acceptance criteria/);
  assert.match(withAc, /Proposed criteria/);
  assert.equal(criteriaFileName(story, serverT('it')), 'criteri-accettazione-42.html');
  assert.equal(criteriaFileName(undefined, serverT('en')), 'acceptance-criteria.html');
});
