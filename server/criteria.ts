// Fase "Criteri di accettazione": l'agente restituisce i criteri nel blocco di esito, Regia li controlla e ne fa una
// pagina HTML autonoma (stili e script inclusi), da aprire nel browser o scaricare, con i pulsanti per copiarli
// nella user story: formattati per Azure DevOps, come testo per GitHub.
import type { AcceptanceCriteria, AcceptanceCriterion, CriterionStatus, SpecGap, StoryCriterionReview, StoryCriterionVerdict, UserStory } from '../shared/types.ts';
import type { Translate } from '../shared/i18n.ts';
import { redact } from './redact.ts';

const MAX_CRITERIA = 40;
const MAX_NOTES = 30;
const STATUSES: CriterionStatus[] = ['nuovo', 'coperto', 'diverso', 'da_confermare'];
const VERDICTS: StoryCriterionVerdict[] = ['ok', 'vago', 'non_verificabile', 'in_contrasto', 'non_coperto'];

const obj = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined);
const str = (x: unknown, max: number) => (typeof x === 'string' || typeof x === 'number' ? redact(String(x)).trim().slice(0, max) : '');

/** Criteri dal blocco di esito dell'agente; undefined se non ce n'è nessuno valido. */
export function parseCriteria(v: unknown): AcceptanceCriteria | undefined {
  const o = obj(v);
  if (!o) return undefined;
  const used = new Set<string>();
  const proposti = (Array.isArray(o.proposti) ? o.proposti : []).flatMap((x, i): AcceptanceCriterion[] => {
    const c = typeof x === 'string' ? { testo: x } : obj(x);
    const testo = str(c?.testo, 1000);
    if (!c || !testo) return [];
    // Id brevi e unici (AC1, AC2…): servono a collegare note e confronto.
    let id = str(c.id, 20).replace(/\s+/g, '');
    if (!id || used.has(id)) id = `AC${i + 1}`;
    while (used.has(id)) id += "'";
    used.add(id);
    const stato = STATUSES.includes(c.stato as CriterionStatus) ? (c.stato as CriterionStatus) : 'nuovo';
    const origine = str(c.origine, 300);
    const acUs = str(c.acUs, 500);
    const nota = str(c.nota, 500);
    return [{ id, testo, stato, ...(origine ? { origine } : {}), ...(acUs ? { acUs } : {}), ...(nota ? { nota } : {}) }];
  }).slice(0, MAX_CRITERIA);
  const esistenti = (Array.isArray(o.esistenti) ? o.esistenti : []).flatMap((x): StoryCriterionReview[] => {
    const c = obj(x);
    const testo = str(c?.testo, 1000);
    if (!c || !testo) return [];
    const valutazione = VERDICTS.includes(c.valutazione as StoryCriterionVerdict) ? (c.valutazione as StoryCriterionVerdict) : 'ok';
    const nota = str(c.nota, 500);
    return [{ testo, valutazione, ...(nota ? { nota } : {}) }];
  }).slice(0, MAX_CRITERIA);
  const note = (Array.isArray(o.note) ? o.note : []).flatMap((x): SpecGap[] => {
    const c = typeof x === 'string' ? { domanda: x } : obj(x);
    const domanda = str(c?.domanda, 1000);
    if (!c || !domanda) return [];
    const criteri = (Array.isArray(c.criteri) ? c.criteri : []).map((y) => str(y, 20)).filter(Boolean).slice(0, 10);
    return [{ argomento: str(c.argomento, 200), domanda, ...(criteri.length ? { criteri } : {}) }];
  }).slice(0, MAX_NOTES);
  if (!proposti.length && !esistenti.length && !note.length) return undefined;
  return { proposti, esistenti, note };
}

/** Riassunto in testo per le fasi successive, l'approvazione e il rapporto dell'esecuzione. */
export function criteriaText(c: AcceptanceCriteria, t: Translate): string {
  const parts: string[] = [];
  if (c.proposti.length) {
    parts.push(`${t('criteria.text.proposed')}\n${c.proposti.map((x) => `- ${x.id}${x.stato === 'nuovo' ? '' : ` [${t(`criteria.status.${x.stato}`)}]`}: ${x.testo}`).join('\n')}`);
  }
  const flagged = c.esistenti.filter((x) => x.valutazione !== 'ok');
  if (flagged.length) {
    parts.push(`${t('criteria.text.storyIssues')}\n${flagged.map((x) => `- [${t(`criteria.verdict.${x.valutazione}`)}] ${x.testo}${x.nota ? ` (${x.nota})` : ''}`).join('\n')}`);
  }
  if (c.note.length) {
    parts.push(`${t('criteria.text.gaps')}\n${c.note.map((x) => `- ${x.argomento ? `${x.argomento}: ` : ''}${x.domanda}${x.criteri?.length ? ` (${x.criteri.join(', ')})` : ''}`).join('\n')}`);
  }
  return parts.join('\n');
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const STATUS_TONE: Record<CriterionStatus, string> = { nuovo: 'new', coperto: 'good', diverso: 'warn', da_confermare: 'bad' };
const VERDICT_TONE: Record<StoryCriterionVerdict, string> = { ok: 'good', vago: 'warn', non_verificabile: 'warn', in_contrasto: 'bad', non_coperto: 'warn' };

export interface CriteriaPage {
  criteria: AcceptanceCriteria;
  story?: UserStory;
  /** Sintesi dell'agente, mostrata sotto il titolo. */
  summary?: string;
  workflowName: string;
  generatedAt: string;
  lang: string;
  t: Translate;
}

/** Nome del file scaricato: criteri-accettazione-<id della user story>.html */
export function criteriaFileName(story: UserStory | undefined, t: Translate): string {
  const id = story?.id ? `-${story.id.replace(/[^\w-]/g, '')}` : '';
  return `${t('criteria.fileName')}${id}.html`;
}

/** Pagina HTML autonoma con i criteri, il confronto con la user story e le specifiche mancanti. */
export function criteriaHtml(p: CriteriaPage): string {
  const { criteria: c, story, t } = p;
  const e = (key: string, params?: Record<string, string | number>) => esc(t(key, params));
  const storyTitle = story ? `${story.type ? `${story.type} ` : ''}#${story.id} ${story.title}` : '';
  const date = new Date(p.generatedAt).toLocaleString(p.lang, { dateStyle: 'medium', timeStyle: 'short' });
  const pending = c.proposti.filter((x) => x.stato === 'da_confermare').length;
  const hasStoryAc = Boolean(story?.acceptance?.trim()) || c.esistenti.length > 0;

  // Contenuto da incollare nella user story: elenco numerato (formattato) e testo semplice (Markdown).
  const mark = (x: AcceptanceCriterion) => (x.stato === 'da_confermare' ? ` [${t('criteria.status.da_confermare')}]` : '');
  const copyHtml = `<ol>${c.proposti.map((x) => `<li><b>${esc(x.id)}</b> – ${esc(x.testo)}${esc(mark(x))}</li>`).join('')}</ol>`;
  const copyText = c.proposti.map((x) => `- **${x.id}** – ${x.testo}${mark(x)}`).join('\n');
  const questionsHtml = `<ol>${c.note.map((x) => `<li>${x.argomento ? `<b>${esc(x.argomento)}</b>: ` : ''}${esc(x.domanda)}</li>`).join('')}</ol>`;
  const questionsText = c.note.map((x, i) => `${i + 1}. ${x.argomento ? `${x.argomento}: ` : ''}${x.domanda}`).join('\n');

  const criterion = (x: AcceptanceCriterion) => `
      <li class="ac" id="${esc(x.id)}">
        <div class="ac-head"><span class="ac-id">${esc(x.id)}</span><span class="badge ${STATUS_TONE[x.stato]}">${e(`criteria.status.${x.stato}`)}</span></div>
        <p class="ac-text">${esc(x.testo)}</p>
        ${x.origine ? `<p class="meta"><span>${e('criteria.origin')}</span> ${esc(x.origine)}</p>` : ''}
        ${x.acUs ? `<p class="meta"><span>${e('criteria.storyAc')}</span> ${esc(x.acUs)}</p>` : ''}
        ${x.nota ? `<p class="meta"><span>${e('criteria.note')}</span> ${esc(x.nota)}</p>` : ''}
      </li>`;
  const review = (x: StoryCriterionReview) => `
      <li class="ac">
        <div class="ac-head"><span class="badge ${VERDICT_TONE[x.valutazione]}">${e(`criteria.verdict.${x.valutazione}`)}</span></div>
        <p class="ac-text">${esc(x.testo)}</p>
        ${x.nota ? `<p class="meta">${esc(x.nota)}</p>` : ''}
      </li>`;
  const gap = (x: SpecGap) => `
      <li class="gap">
        ${x.argomento ? `<strong>${esc(x.argomento)}</strong>` : ''}
        <p>${esc(x.domanda)}</p>
        ${x.criteri?.length ? `<p class="meta"><span>${e('criteria.related')}</span> ${x.criteri.map((id) => `<a href="#${esc(id)}">${esc(id)}</a>`).join(', ')}</p>` : ''}
      </li>`;

  return `<!doctype html>
<html lang="${esc(p.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e('criteria.title')}${story ? ` – #${esc(story.id)}` : ''}</title>
<style>
:root { --bg: #f7f7f5; --card: #fff; --text: #1d1d1b; --muted: #6b6b66; --line: #e3e2dd; --accent: #2f5bd3;
  --good: #1f7a4d; --good-bg: #e3f3ea; --warn: #8a5a00; --warn-bg: #fbefd5; --bad: #b3261e; --bad-bg: #fbe4e2; --new: #2f5bd3; --new-bg: #e5ecfb; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --card: #1f1f1d; --text: #ecebe6; --muted: #a3a29c; --line: #34332f; --accent: #8aa8f5;
  --good: #7fd3a6; --good-bg: #1d3328; --warn: #f0c36b; --warn-bg: #3a2f17; --bad: #f2a29b; --bad-bg: #3d1f1c; --new: #8aa8f5; --new-bg: #1f2944; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 0; }
a { color: var(--accent); }
.sub { color: var(--muted); margin: 0 0 16px; }
.summary { margin: 0 0 20px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 24px; }
.chip { background: var(--card); border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px; font-size: 13px; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
.sec-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
.hint { color: var(--muted); font-size: 13px; margin: -4px 0 12px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
button { font: inherit; font-size: 13px; border: 1px solid var(--line); background: var(--bg); color: var(--text); border-radius: 8px; padding: 6px 12px; cursor: pointer; }
button:hover { border-color: var(--accent); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--card); }
ol.list, ul.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.ac, .gap { border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.ac:target { outline: 2px solid var(--accent); }
.ac-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.ac-id { font-weight: 700; }
.ac-text, .gap p { margin: 0; }
.meta { color: var(--muted); font-size: 13px; margin: 6px 0 0 !important; }
.meta span { font-weight: 600; }
.badge { font-size: 12px; font-weight: 600; border-radius: 999px; padding: 1px 10px; }
.badge.good { color: var(--good); background: var(--good-bg); }
.badge.warn { color: var(--warn); background: var(--warn-bg); }
.badge.bad { color: var(--bad); background: var(--bad-bg); }
.badge.new { color: var(--new); background: var(--new-bg); }
.callout { border-radius: 10px; padding: 10px 14px; background: var(--warn-bg); color: var(--warn); margin: 0 0 12px; }
.gaps { border-color: var(--warn); }
.toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: var(--text); color: var(--bg); padding: 8px 16px; border-radius: 8px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
.toast.show { opacity: 1; }
footer { color: var(--muted); font-size: 12px; text-align: center; }
template { display: none; }
@media print { button, .actions { display: none; } section { break-inside: avoid; } }
</style>
</head>
<body>
<main>
  <h1>${e('criteria.title')}</h1>
  <p class="sub">${story ? `<a href="${esc(story.url)}" target="_blank" rel="noreferrer">${esc(storyTitle)}</a> · ` : ''}${esc(p.workflowName)} · ${esc(date)}</p>
  ${p.summary ? `<p class="summary">${esc(p.summary)}</p>` : ''}
  <div class="chips">
    <span class="chip">${e('criteria.count.proposed', { count: c.proposti.length })}</span>
    ${pending ? `<span class="chip">${e('criteria.count.pending', { count: pending })}</span>` : ''}
    ${c.note.length ? `<span class="chip">${e('criteria.count.gaps', { count: c.note.length })}</span>` : ''}
  </div>

  ${c.note.length ? `<section class="gaps">
    <div class="sec-head"><h2>${e('criteria.gaps')}</h2>
      <div class="actions"><button data-copy="questions">${e('criteria.copyQuestions')}</button></div></div>
    <p class="hint">${e('criteria.gapsHint')}</p>
    <ul class="list">${c.note.map(gap).join('')}</ul>
  </section>` : ''}

  <section>
    <div class="sec-head"><h2>${e('criteria.proposed')}</h2>
      ${c.proposti.length ? `<div class="actions">
        <button class="primary" data-copy="ac">${e('criteria.copyFormatted')}</button>
        <button data-copy="ac" data-plain>${e('criteria.copyMarkdown')}</button>
      </div>` : ''}</div>
    <p class="hint">${e('criteria.copyHint')}</p>
    ${c.proposti.length ? `<ol class="list">${c.proposti.map(criterion).join('')}</ol>` : `<p>${e('criteria.noneProposed')}</p>`}
  </section>

  <section>
    <div class="sec-head"><h2>${e('criteria.comparison')}</h2></div>
    ${!hasStoryAc ? `<p class="callout">${e('criteria.storyHasNone')}</p>` : ''}
    ${c.esistenti.length ? `<ul class="list">${c.esistenti.map(review).join('')}</ul>` : hasStoryAc ? `<p>${e('criteria.noComparison')}</p>` : ''}
  </section>

  <footer>${e('criteria.footer')}</footer>
</main>
<template id="copy-ac-html">${copyHtml}</template>
<template id="copy-ac-text">${esc(copyText)}</template>
<template id="copy-questions-html">${questionsHtml}</template>
<template id="copy-questions-text">${esc(questionsText)}</template>
<div class="toast" id="toast" role="status">${e('criteria.copied')}</div>
<script>
(function () {
  var toast = document.getElementById('toast');
  function done() { toast.classList.add('show'); setTimeout(function () { toast.classList.remove('show'); }, 1600); }
  // Senza API degli appunti (pagina aperta come file in alcuni browser): si seleziona il contenuto e si copia.
  function fallback(html, plain) {
    var box = document.createElement('div');
    box.style.position = 'fixed'; box.style.left = '-9999px';
    if (plain) { box.style.whiteSpace = 'pre'; box.textContent = plain; } else { box.innerHTML = html; }
    document.body.appendChild(box);
    var r = document.createRange(); r.selectNodeContents(box);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    try { document.execCommand('copy'); done(); } finally { s.removeAllRanges(); box.remove(); }
  }
  document.querySelectorAll('button[data-copy]').forEach(function (b) {
    b.addEventListener('click', function () {
      var key = b.getAttribute('data-copy');
      var html = document.getElementById('copy-' + key + '-html').innerHTML;
      var text = document.getElementById('copy-' + key + '-text').content.textContent;
      var plainOnly = b.hasAttribute('data-plain');
      if (navigator.clipboard && window.ClipboardItem && !plainOnly) {
        navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })])
          .then(done, function () { fallback(html); });
      } else if (navigator.clipboard && plainOnly) {
        navigator.clipboard.writeText(text).then(done, function () { fallback(null, text); });
      } else {
        fallback(plainOnly ? null : html, plainOnly ? text : null);
      }
    });
  });
})();
</script>
</body>
</html>
`;
}
