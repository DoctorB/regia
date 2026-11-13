import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regia-story-'));
process.env.REGIA_DATA_DIR = path.join(tmp, 'data');
process.env.REGIA_MOCK_SPEED = '2';

// Azure DevOps finto: work item con descrizione, criteri, un'immagine nel testo e un allegato, commenti.
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const auths: string[] = [];
const srv = http.createServer((req, res) => {
  auths.push(String(req.headers.authorization ?? ''));
  const u = new URL(req.url!, 'http://x');
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  if (u.pathname.endsWith('/_apis/wit/workitems/248637')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return void res.end(JSON.stringify({
      fields: {
        'System.WorkItemType': 'User Story', 'System.Title': 'Filtro per categoria', 'System.State': 'Active',
        'System.Description': `<div>Come cliente voglio <b>filtrare</b> i prodotti &amp; vederli subito.</div><div><img src="${base}/_apis/wit/attachments/aaa?fileName=mockup.png"></div><ul><li>uno</li><li>due</li></ul>`,
        'Microsoft.VSTS.Common.AcceptanceCriteria': '<ol><li>La lista si aggiorna</li><li>Messaggio se vuota</li></ol>',
      },
      relations: [
        { rel: 'AttachedFile', url: `${base}/_apis/wit/attachments/bbb`, attributes: { name: 'schermata.png' } },
        { rel: 'AttachedFile', url: `${base}/_apis/wit/attachments/ccc`, attributes: { name: 'note.docx' } },
      ],
    }));
  }
  if (u.pathname.endsWith('/_apis/wit/workItems/248637/comments')) {
    res.setHeader('Content-Type', 'application/json');
    return void res.end(JSON.stringify({ comments: [{ text: '<p>Ok per me</p>', createdBy: { displayName: 'Anna' }, createdDate: '2026-11-10T10:00:00Z' }] }));
  }
  if (u.pathname.includes('/_apis/wit/attachments/')) {
    res.setHeader('Content-Type', 'image/png');
    return void res.end(PNG);
  }
  res.statusCode = 404;
  res.end();
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
process.env.REGIA_ADO_BASE = `http://127.0.0.1:${(srv.address() as { port: number }).port}/ABB_Portfolio`;
process.env.AZURE_DEVOPS_EXT_PAT = 'token-di-prova';

const story = await import('../story.ts');
const store = await import('../store.ts');
const { startRun } = await import('../engine.ts');
const { runReport } = await import('../../shared/report.ts');
const { serverT } = await import('../i18n.ts');
store.initStore();

test('riconosce gli indirizzi di Azure DevOps e di GitHub', () => {
  assert.deepEqual(story.parseStoryUrl('https://abbsace.visualstudio.com/ABB_Portfolio/_workitems/edit/248637'),
    { provider: 'azure', host: 'abbsace.visualstudio.com', org: 'abbsace', project: 'ABB_Portfolio', id: '248637', base: 'https://abbsace.visualstudio.com/ABB_Portfolio' });
  const dev = story.parseStoryUrl('https://dev.azure.com/contoso/Web%20Shop/_workitems/edit/12/');
  assert.equal(dev?.provider === 'azure' && dev.base, 'https://dev.azure.com/contoso/Web%20Shop');
  assert.equal(story.parseStoryUrl('https://dev.azure.com/contoso/Shop/_boards/board/t/Team/Stories?workitem=77')?.id, '77');
  assert.deepEqual(story.parseStoryUrl('https://github.com/DoctorB/regia/issues/5'), { provider: 'github', owner: 'DoctorB', repo: 'regia', id: '5' });
  for (const bad of ['', 'non un url', 'http://dev.azure.com/a/b/_workitems/edit/1', 'https://github.com/a/b/pull/3', 'https://example.com/_workitems/edit/1']) {
    assert.equal(story.parseStoryUrl(bad), null, bad);
  }
});

test('testo: HTML in testo semplice, immagini numerate al loro posto; Markdown di GitHub', () => {
  const imgs: { url: string; name: string; source: string }[] = [];
  const t = story.htmlToText('<p>Ciao&nbsp;<b>mondo</b></p><img src="https://x/_apis/wit/attachments/1?fileName=a.png"><ul><li>uno</li></ul>', imgs as never, 'descrizione');
  assert.equal(t, 'Ciao mondo\n[immagine 1: a.png]\n- uno');
  const md = story.markdownImages('Vedi ![mockup](https://github.com/user-attachments/assets/x) e <img alt="b" src="https://i/b.png">', imgs as never, 'commento');
  assert.equal(md, 'Vedi [immagine 2: mockup] e [immagine 3: b]');
});

test('lettura da Azure DevOps: testo, criteri, commenti e immagini (testo e allegati), sempre con l\'accesso', async () => {
  const s = await story.fetchStory('https://abbsace.visualstudio.com/ABB_Portfolio/_workitems/edit/248637', 'prova');
  assert.equal(s.title, 'Filtro per categoria');
  assert.equal(s.type, 'User Story');
  assert.match(s.description, /voglio filtrare i prodotti & vederli subito\.\n\[immagine 1: mockup\.png\]/);
  assert.equal(s.acceptance, '- La lista si aggiorna\n- Messaggio se vuota');
  assert.deepEqual(s.comments, [{ author: 'Anna', at: '2026-11-10T10:00:00Z', text: 'Ok per me' }]);
  assert.deepEqual(s.images.map((i) => [i.n, i.name, i.source]), [[1, 'mockup.png', 'descrizione'], [2, 'schermata.png', 'allegato']]);
  for (const i of s.images) assert.ok(fs.existsSync(path.join(story.storyDir(s), i.file)));
  assert.ok(auths.every((a) => a === `Basic ${Buffer.from(':token-di-prova').toString('base64')}`));
  // Il testo per gli agenti porta i percorsi delle immagini.
  const p = story.storyPrompt(s, serverT('it'));
  assert.match(p, /# User story collegata\nUser Story 248637: Filtro per categoria/);
  assert.match(p, /## Criteri di accettazione\n- La lista si aggiorna/);
  assert.match(p, /\[immagine 2: schermata\.png\] .*\/prova\/02-schermata\.png/);
  await assert.rejects(story.fetchStory('https://abbsace.visualstudio.com/ABB_Portfolio/_workitems/edit/999', 'x'), (e: Error & { code?: string }) => e.code === 'notFound');
  await assert.rejects(story.fetchStory('https://example.com/x', 'y'), (e: Error & { code?: string }) => e.code === 'url');
});

test('esecuzione con la user story: evento all\'avvio e riga nel resoconto; senza, un avviso e si prosegue', async () => {
  const s = await story.fetchStory('https://abbsace.visualstudio.com/ABB_Portfolio/_workitems/edit/248637', 'run');
  const projectDir = path.join(tmp, 'p');
  fs.mkdirSync(projectDir, { recursive: true });
  const wf = {
    id: 'wf_s', name: 'S', description: '', updatedAt: '', edges: [],
    settings: { maxParallel: 1, loadProjectSettings: false, applyGeneralRules: false, projectDir, goal: 'Filtro', story: s.url },
    nodes: [{ id: 'a', position: { x: 0, y: 0 }, data: { label: 'Analisi', kind: 'analisi' as const, role: '', instructions: 'Leggi.', model: 'haiku', allowedTools: ['Read'], maxTurns: 5, contextMode: 'sintesi' as const, reuseResult: false } }],
  };
  const eng = startRun(wf, 'prova', undefined, undefined, { story: s });
  await new Promise<void>((r) => { const i = setInterval(() => { if (eng.run.status !== 'in_corso') { clearInterval(i); r(); } }, 10); });
  assert.ok(eng.run.events.some((e) => e.msg?.key === 'events.story.loaded' && e.text.includes('248637')));
  assert.match(runReport(eng.run, serverT('it'), 'it-IT'), /\| User story \| \[User Story 248637: Filtro per categoria\]\(https:\/\/abbsace/);
  const eng2 = startRun({ ...wf, id: 'wf_s2' }, 'prova', undefined, undefined, { error: { key: 'story.error.denied' } });
  await new Promise<void>((r) => { const i = setInterval(() => { if (eng2.run.status !== 'in_corso') { clearInterval(i); r(); } }, 10); });
  assert.ok(eng2.run.events.some((e) => e.msg?.key === 'events.story.failed'));
  assert.equal(eng2.run.status, 'completata');
  srv.close();
});

test('accesso: un token OAuth (JWT) si prova prima come Bearer, un PAT come Basic', async () => {
  const { authHeaders } = await import('../story.ts');
  const jwt = 'eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl';
  assert.deepEqual(authHeaders('mario', jwt), [`Bearer ${jwt}`, `Basic ${Buffer.from(`mario:${jwt}`).toString('base64')}`]);
  const pat = authHeaders('', 'abc123');
  assert.equal(pat[0], `Basic ${Buffer.from(':abc123').toString('base64')}`);
  assert.equal(pat.at(-1), 'Bearer abc123');
});

test('token in memoria fino a poco prima della scadenza del JWT, al massimo un\'ora', async () => {
  const { tokenUntil } = await import('../story.ts');
  const now = Date.parse('2026-11-13T10:00:00Z');
  const jwt = (exp: number) => `Bearer eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.sig`;
  assert.equal(tokenUntil(jwt(now / 1000 + 30 * 60), now), now + 25 * 60_000);
  assert.equal(tokenUntil(jwt(now / 1000 + 3 * 3600), now), now + 60 * 60_000);
  assert.equal(tokenUntil('Basic abc', now), now + 60 * 60_000);
});
