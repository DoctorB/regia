// User story collegata al workflow: Regia la legge dall'URL e la passa agli agenti, immagini comprese.
// - Azure DevOps (dev.azure.com, *.visualstudio.com): API REST dei work item. Accesso chiesto a Git Credential Manager
//   (lo stesso di git: se manca, apre il login Microsoft una volta e poi lo ricorda), altrimenti AZURE_DEVOPS_EXT_PAT
//   o la CLI az. Il token resta in memoria il tempo della lettura: Regia non lo salva mai.
// - GitHub Issues: con la CLI gh già autenticata.
// - Testo: HTML e Markdown diventano testo semplice; ogni immagine resta segnata al suo posto ("[immagine 2: x.png]")
//   ed è scaricata nella cartella della lettura (al massimo 10, 5 MB l'una), così gli agenti possono aprirla.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { StoryImage, UserStory } from '../shared/types.ts';
import { redact } from './redact.ts';
import { DATA_DIR } from './store.ts';

export const STORIES_DIR = path.join(DATA_DIR, 'stories');
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 20_000;
const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

export type StoryRef =
  | { provider: 'azure'; host: string; org: string; project: string; id: string; base: string }
  | { provider: 'github'; owner: string; repo: string; id: string };

/** Riconosce l'URL di un work item Azure DevOps o di una issue GitHub. */
export function parseStoryUrl(raw: string): StoryRef | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const itemId = (): string | undefined => {
    const i = parts.findIndex((p) => p === '_workitems');
    if (i >= 0 && parts[i + 1] === 'edit' && /^\d+$/.test(parts[i + 2] ?? '')) return parts[i + 2];
    const q = u.searchParams.get('workitem');
    return q && /^\d+$/.test(q) ? q : undefined;
  };
  const vs = /^([\w-]+)\.visualstudio\.com$/i.exec(u.hostname);
  if (vs && parts[0] && !parts[0].startsWith('_')) {
    const id = itemId();
    if (id) return { provider: 'azure', host: u.hostname, org: vs[1], project: parts[0], id, base: `https://${u.hostname}/${encodeURIComponent(parts[0])}` };
  }
  if (u.hostname.toLowerCase() === 'dev.azure.com' && parts.length >= 2 && !parts[1].startsWith('_')) {
    const id = itemId();
    if (id) return { provider: 'azure', host: 'dev.azure.com', org: parts[0], project: parts[1], id, base: `https://dev.azure.com/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}` };
  }
  if (u.hostname.toLowerCase() === 'github.com' && parts[2] === 'issues' && /^\d+$/.test(parts[3] ?? '')) {
    return { provider: 'github', owner: parts[0], repo: parts[1], id: parts[3] };
  }
  return null;
}

// ---------- Accesso ----------

function run(cmd: string, args: string[], input?: string, timeout = 180_000, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } });
    let out = '';
    let err = '';
    const t = setTimeout(() => { child.kill(); reject(new Error('timeout')); }, timeout);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', (code) => { clearTimeout(t); if (code === 0) resolve(out); else reject(new Error(err.trim().slice(-300) || `exit ${code}`)); });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

/**
 * Intestazioni di autorizzazione da provare, nell'ordine. Un token OAuth (JWT, quello che Git Credential Manager ottiene
 * con il login Microsoft) va come Bearer; un Personal Access Token come Basic. Si prova anche l'altra forma, perché il
 * tipo non è dichiarato.
 */
export function authHeaders(user: string, secret: string): string[] {
  const basic = (u: string) => `Basic ${Buffer.from(`${u}:${secret}`).toString('base64')}`;
  const jwt = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(secret);
  return [...new Set(jwt ? [`Bearer ${secret}`, basic(user)] : [basic(user), basic(''), `Bearer ${secret}`])];
}

/**
 * Token che ha funzionato, per organizzazione, solo in memoria e fino a poco prima della sua scadenza: anteprima e avvio
 * delle esecuzioni non chiedono di nuovo l'accesso finché Regia resta aperto. Non viene mai scritto su disco.
 */
const tokens = new Map<string, { header: string; until: number }>();

/** Scadenza del token: dal campo exp di un JWT (meno 5 minuti), altrimenti un'ora. */
export function tokenUntil(header: string, now = Date.now()): number {
  const jwt = /^Bearer (eyJ[\w-]+)\.([\w-]+)\./.exec(header);
  if (jwt) {
    try {
      const exp = Number(JSON.parse(Buffer.from(jwt[2], 'base64url').toString('utf8')).exp);
      if (exp) return Math.min(exp * 1000 - 5 * 60_000, now + 60 * 60_000);
    } catch { /* payload illeggibile */ }
  }
  return now + 60 * 60_000;
}

/**
 * Associa l'organizzazione all'account del login (comando ufficiale di Git Credential Manager), se non ne ha già uno:
 * senza associazione GCM non sa quale sessione riusare e chiede il login a ogni lettura.
 */
async function bindAccount(org: string, account: string) {
  try {
    const current = await run('git', ['config', '--global', '--get', `credential.azrepos:org/${org}.username`], undefined, 10_000).catch(() => '');
    if (current.trim()) return;
    await run('git', ['credential-manager', 'azure-repos', 'bind', org, account], undefined, 30_000);
  } catch { /* associazione non riuscita: si riprova alla prossima lettura */ }
}

/** Accesso ad Azure DevOps; il token non viene mai scritto da nessuna parte. */
async function azureAuth(ref: Extract<StoryRef, { provider: 'azure' }>): Promise<{ headers: string[]; via: string; account?: string }> {
  const pat = process.env.AZURE_DEVOPS_EXT_PAT;
  if (pat) return { headers: authHeaders('', pat), via: 'pat' };
  // Git Credential Manager: per dev.azure.com l'organizzazione è nel percorso.
  const query = ref.host === 'dev.azure.com' ? `protocol=https\nhost=dev.azure.com\npath=${ref.org}\n\n` : `protocol=https\nhost=${ref.host}\n\n`;
  // Prima il token OAuth del login Microsoft (GCM_AZREPOS_CREDENTIALTYPE=oauth): vale per tutte le API che l'account
  // vede. Di serie, per i repository, GCM crea invece un Personal Access Token con il solo permesso sul codice, che
  // non legge i work item. Quel token OAuth GCM non lo mette tra le credenziali salvate: non serve confermarlo.
  try {
    const out = await run('git', ['credential', 'fill'], query, 180_000, { GCM_AZREPOS_CREDENTIALTYPE: 'oauth' });
    const pass = /^password=(.*)$/m.exec(out)?.[1];
    if (pass) {
      const account = /^username=(.*)$/m.exec(out)?.[1] ?? '';
      const headers = authHeaders(account, pass);
      // Accesso salvato per git (di solito il PAT dei repository): ultima prova, se il token OAuth non basta.
      const saved = await run('git', ['credential', 'fill'], query, 30_000).catch(() => '');
      const savedPass = /^password=(.*)$/m.exec(saved)?.[1];
      if (savedPass && savedPass !== pass) headers.push(...authHeaders(/^username=(.*)$/m.exec(saved)?.[1] ?? '', savedPass));
      return { headers: [...new Set(headers)], via: 'git', account: account.includes('@') ? account : undefined };
    }
  } catch { /* Git Credential Manager assente o login annullato */ }
  try {
    const token = (await run(process.platform === 'win32' ? 'az.cmd' : 'az', ['account', 'get-access-token', '--resource', ADO_RESOURCE, '--query', 'accessToken', '-o', 'tsv'], undefined, 30_000)).trim();
    if (token) return { headers: [`Bearer ${token}`], via: 'az' };
  } catch { /* az assente o non autenticato */ }
  throw new StoryError('auth');
}

export class StoryError extends Error {
  constructor(public code: 'url' | 'auth' | 'denied' | 'notFound' | 'network' | 'gh', detail = '') {
    super(detail || code);
  }
}

// ---------- Testo ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITIES[e.toLowerCase()] ?? m;
});

interface ImageRef { url: string; name: string; source: StoryImage['source'] }

/** HTML dei work item in testo: paragrafi e liste mantenuti, immagini sostituite da un segnaposto numerato. */
export function htmlToText(html: string, images: ImageRef[], source: StoryImage['source']): string {
  let s = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!src || src.startsWith('data:')) return '';
    const url = decode(src);
    const fileName = (() => { try { return new URL(url).searchParams.get('fileName') ?? ''; } catch { return ''; } })();
    const name = fileName || decodeURIComponent(url.split('?')[0].split('/').pop() || 'immagine');
    images.push({ url, name, source });
    return ` [immagine ${images.length}: ${name}] `;
  });
  s = s.replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<\/\s*(p|div|h[1-6]|tr|ul|ol|table)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decode(s).replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

/** Markdown di GitHub: le immagini (Markdown o HTML) diventano segnaposto numerati, il resto resta com'è. */
export function markdownImages(md: string, images: ImageRef[], source: StoryImage['source']): string {
  const add = (url: string, alt: string) => {
    const name = alt || decodeURIComponent(url.split('?')[0].split('/').pop() || 'immagine');
    images.push({ url, name, source });
    return `[immagine ${images.length}: ${name}]`;
  };
  return md
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt: string, url: string) => add(url, alt))
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
      return src ? add(src, /\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '') : '';
    });
}

// ---------- Lettura ----------

async function getJson(url: string, auth: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new StoryError('network', (e as Error).message);
  }
  // Azure DevOps risponde con un reindirizzamento al login quando l'accesso non vale.
  if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) throw new StoryError('denied', String(res.status));
  if (res.status === 404) throw new StoryError('notFound');
  if (!res.ok) throw new StoryError('network', `HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) throw new StoryError('denied', 'login');
  return res.json();
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

async function downloadImages(images: ImageRef[], dir: string, auth: (url: string) => string | undefined): Promise<StoryImage[]> {
  const out: StoryImage[] = [];
  const used = new Set<string>();
  for (const [i, img] of images.slice(0, MAX_IMAGES).entries()) {
    try {
      const h = auth(img.url);
      const res = await fetch(img.url, { headers: h ? { Authorization: h } : {}, signal: AbortSignal.timeout(30_000) });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !(type.startsWith('image/') || type.includes('octet-stream'))) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_IMAGE_BYTES) continue;
      const ext = IMAGE_EXT.exec(img.name)?.[0] ?? (type.includes('jpeg') ? '.jpg' : type.includes('gif') ? '.gif' : '.png');
      let file = `${String(i + 1).padStart(2, '0')}-${img.name.replace(IMAGE_EXT, '').replace(/[^\w.-]+/g, '_').slice(0, 40)}${ext}`;
      while (used.has(file)) file = `x${file}`;
      used.add(file);
      fs.writeFileSync(path.join(dir, file), buf);
      out.push({ n: i + 1, name: img.name, file, source: img.source });
    } catch { /* immagine non scaricabile: resta il segnaposto */ }
  }
  return out;
}

const clipText = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n[…]` : s);

async function readAzure(ref: Extract<StoryRef, { provider: 'azure' }>, url: string, dir: string): Promise<UserStory> {
  const base = process.env.REGIA_ADO_BASE || ref.base;
  const itemUrl = `${base}/_apis/wit/workitems/${ref.id}?$expand=relations&api-version=7.1`;
  // Si prova ogni forma dell'accesso finché il servizio accetta; nel messaggio di errore restano i codici ricevuti.
  const attempt = async (headers: string[]) => {
    const refused: string[] = [];
    for (const h of headers) {
      try {
        return { header: h, wi: await getJson(itemUrl, h), refused };
      } catch (e) {
        if (!(e instanceof StoryError) || e.code !== 'denied') throw e;
        refused.push(`${h.split(' ')[0]} ${e.message}`);
      }
    }
    return { header: '', wi: undefined, refused };
  };
  const key = `${ref.host}/${ref.org}`.toLowerCase();
  const cached = tokens.get(key);
  let got = cached && cached.until > Date.now() ? await attempt([cached.header]) : undefined;
  if (!got?.header) {
    tokens.delete(key);
    const auth = await azureAuth(ref);
    got = await attempt(auth.headers);
    if (!got.header) throw new StoryError('denied', `${auth.via}: ${got.refused.join(', ')}`);
    tokens.set(key, { header: got.header, until: tokenUntil(got.header) });
    if (auth.account) void bindAccount(ref.org, auth.account);
  }
  const { header, wi } = got;
  const f = wi.fields ?? {};
  const images: ImageRef[] = [];
  const description = htmlToText(String(f['System.Description'] ?? f['Microsoft.VSTS.TCM.ReproSteps'] ?? ''), images, 'descrizione');
  const acceptance = htmlToText(String(f['Microsoft.VSTS.Common.AcceptanceCriteria'] ?? ''), images, 'criteri');
  let comments: UserStory['comments'] = [];
  try {
    const c = await getJson(`${base}/_apis/wit/workItems/${ref.id}/comments?$top=10&order=desc&api-version=7.1-preview.4`, header);
    comments = (c.comments ?? []).slice(0, 10).reverse().map((x: any) => ({
      author: x.createdBy?.displayName, at: x.createdDate, text: htmlToText(String(x.text ?? ''), images, 'commento'),
    })).filter((x: { text: string }) => x.text);
  } catch { /* commenti non disponibili: si prosegue */ }
  // Allegati che sono immagini (screenshot, mockup) e non già inclusi nel testo.
  for (const r of wi.relations ?? []) {
    if (r.rel !== 'AttachedFile' || !IMAGE_EXT.test(r.attributes?.name ?? '')) continue;
    if (!images.some((i) => i.url.split('?')[0] === String(r.url).split('?')[0])) images.push({ url: r.url, name: r.attributes.name, source: 'allegato' });
  }
  // Le immagini si scaricano solo dalla stessa organizzazione, con lo stesso accesso.
  const sameOrg = (u: string) => { try { const h = new URL(u).hostname.toLowerCase(); return h === ref.host.toLowerCase() || (ref.host === 'dev.azure.com' && h === 'dev.azure.com'); } catch { return false; } };
  const saved = await downloadImages(images, dir, (u) => (sameOrg(u) || process.env.REGIA_ADO_BASE ? header : undefined));
  return {
    url, provider: 'azure', id: ref.id, type: f['System.WorkItemType'], title: String(f['System.Title'] ?? ''), state: f['System.State'],
    description: clipText(description), acceptance: acceptance ? clipText(acceptance) : undefined, comments,
    images: saved, imagesFound: images.length, fetchedAt: new Date().toISOString(), dir: path.relative(STORIES_DIR, dir).replace(/\\/g, '/'),
  };
}

async function readGithub(ref: Extract<StoryRef, { provider: 'github' }>, url: string, dir: string): Promise<UserStory> {
  let issue: any;
  let comments: any[] = [];
  try {
    issue = JSON.parse(await run('gh', ['api', `repos/${ref.owner}/${ref.repo}/issues/${ref.id}`], undefined, 30_000));
    comments = JSON.parse(await run('gh', ['api', `repos/${ref.owner}/${ref.repo}/issues/${ref.id}/comments?per_page=10`], undefined, 30_000));
  } catch (e) {
    const m = (e as Error).message;
    throw new StoryError(/404|Not Found/i.test(m) ? 'notFound' : /auth|login|401|403/i.test(m) ? 'denied' : 'gh', m);
  }
  const images: ImageRef[] = [];
  const description = markdownImages(String(issue.body ?? ''), images, 'descrizione');
  const list = comments.slice(-10).map((c) => ({ author: c.user?.login, at: c.created_at, text: markdownImages(String(c.body ?? ''), images, 'commento') }));
  let token: string | undefined;
  try { token = (await run('gh', ['auth', 'token'], undefined, 10_000)).trim(); } catch { /* repository pubblico */ }
  const saved = await downloadImages(images, dir, (u) => (token && /(^|\.)github(usercontent)?\.com$/i.test(new URL(u).hostname) ? `Bearer ${token}` : undefined));
  return {
    url, provider: 'github', id: ref.id, type: issue.pull_request ? 'Pull request' : 'Issue', title: String(issue.title ?? ''), state: issue.state,
    description: clipText(description), comments: list, images: saved, imagesFound: images.length,
    fetchedAt: new Date().toISOString(), dir: path.relative(STORIES_DIR, dir).replace(/\\/g, '/'),
  };
}

/** Legge la user story nella cartella indicata (dentro data/stories). Lancia StoryError con un codice leggibile. */
export async function fetchStory(url: string, folder: string): Promise<UserStory> {
  const ref = parseStoryUrl(url);
  if (!ref) throw new StoryError('url');
  const dir = path.join(STORIES_DIR, folder);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const story = ref.provider === 'azure' ? await readAzure(ref, url.trim(), dir) : await readGithub(ref, url.trim(), dir);
  story.title = redact(story.title);
  story.description = redact(story.description);
  if (story.acceptance) story.acceptance = redact(story.acceptance);
  for (const c of story.comments ?? []) c.text = redact(c.text);
  return story;
}

/** Testo per gli agenti: dati della user story, sezioni e immagini con il loro percorso. */
export function storyPrompt(s: UserStory, t: (k: string, p?: Record<string, string | number>) => string): string {
  const dir = path.join(STORIES_DIR, s.dir).replace(/\\/g, '/');
  const parts = [
    t('agent.story.header', { type: s.type ?? '', id: s.id, title: s.title, state: s.state ?? '', url: s.url }),
    s.description ? `${t('agent.story.description')}\n${s.description}` : '',
    s.acceptance ? `${t('agent.story.acceptance')}\n${s.acceptance}` : '',
    s.comments?.length ? `${t('agent.story.comments')}\n${s.comments.map((c) => `- ${c.author ?? '?'}${c.at ? ` (${c.at.slice(0, 10)})` : ''}: ${c.text.replace(/\n+/g, ' ')}`).join('\n')}` : '',
    s.images.length ? `${t('agent.story.images')}\n${s.images.map((i) => `- [immagine ${i.n}: ${i.name}] ${dir}/${i.file}`).join('\n')}` : '',
  ];
  return parts.filter(Boolean).join('\n\n');
}

/** Cartella della lettura (per i permessi degli agenti e per servire le immagini). */
export const storyDir = (s: UserStory) => path.join(STORIES_DIR, s.dir);

