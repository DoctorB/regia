// Pull request del branch corrente, per la fase "Punti della PR" senza URL: Regia la trova da sé e la fa confermare.
import { execFile } from 'node:child_process';
import { msg, type Msg } from '../shared/i18n.ts';
import type { DetectedPr, PrReplyContext, PrThreadInfo } from '../shared/types.ts';

type Out = { ok: true; out: string } | { ok: false; err: string; missing: boolean; out: string };

/** Esegue un comando senza shell (o con la shell solo per i .cmd di Windows, con argomenti già controllati). */
function exec(cmd: string, args: string[], cwd: string, shell = false): Promise<Out> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 30000, windowsHide: true, shell, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, out: String(stdout) });
      const e = err as NodeJS.ErrnoException;
      const text = String(stderr || e.message || '').trim();
      // Comando assente: ENOENT senza shell, "non riconosciuto" / "not found" con la shell.
      const missing = e.code === 'ENOENT' || /not recognized|non è riconosciuto|command not found/i.test(text);
      // Anche l'output: gh api esce con errore se la risposta GraphQL ha errori parziali, ma i dati restano utili.
      resolve({ ok: false, err: text.split('\n').slice(0, 3).join(' ').slice(0, 300), missing, out: String(stdout ?? '') });
    });
  });
}

/** PR di GitHub: proprietario, repository e numero dall'indirizzo. */
export function parseGithubPr(url: string): { owner: string; repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i.exec(url.trim());
  return m ? { owner: m[1], repo: m[2], number: Number(m[3]) } : null;
}

export type PrPost = { ok: true; url?: string } | { ok: false; reason: Msg };

const THREADS_QUERY = 'query($ids:[ID!]!){viewer{login} nodes(ids:$ids){... on PullRequestReviewThread{id path line isResolved pullRequest{number repository{nameWithOwner}} comments(first:1){nodes{author{login} body url}}}}}';

/**
 * Account di gh che pubblicherebbe e discussioni a cui si risponderebbe, verificate su GitHub: devono esistere ed
 * essere di questa PR. Solo GitHub; in prova restituisce dati simulati.
 */
export async function prReplyContext(cwd: string, prUrl: string, threadIds: string[], simulate: boolean): Promise<PrReplyContext> {
  const ids = [...new Set(threadIds)];
  const pr = parseGithubPr(prUrl);
  if (!pr) return { accountError: msg('interventions.pr.replyGithubOnly', { url: prUrl }), threads: {} };
  if (simulate) {
    return { account: 'utente-simulato', threads: Object.fromEntries(ids.map((id) => [id, { ok: true, path: 'src/api.ts', line: 30, author: 'revisore', excerpt: 'Commento simulato del revisore.', url: `${prUrl}#${id}` } satisfies PrThreadInfo])) };
  }
  const r = ids.length
    ? await exec('gh', ['api', 'graphql', '-f', `query=${THREADS_QUERY}`, ...ids.flatMap((id) => ['-f', `ids[]=${id}`])], cwd)
    : await exec('gh', ['api', 'graphql', '-f', 'query=query{viewer{login}}'], cwd);
  let data: { viewer?: { login?: string }; nodes?: (Record<string, unknown> | null)[] } | undefined;
  try { data = JSON.parse(r.out).data; } catch { data = undefined; }
  const account = data?.viewer?.login;
  if (!account) {
    const reason = !r.ok && r.missing ? msg('interventions.pr.toolMissing', { tool: 'gh' }) : msg('interventions.pr.accountUnknown', { detail: r.ok ? '' : r.err });
    return { accountError: reason, threads: {} };
  }
  const repo = `${pr.owner}/${pr.repo}`.toLowerCase();
  const threads: Record<string, PrThreadInfo> = {};
  ids.forEach((id, i) => {
    const n = data?.nodes?.[i] as { path?: string; line?: number | null; isResolved?: boolean; pullRequest?: { number?: number; repository?: { nameWithOwner?: string } }; comments?: { nodes?: { author?: { login?: string }; body?: string; url?: string }[] } } | null | undefined;
    if (!n?.pullRequest) { threads[id] = { ok: false, reason: msg('interventions.pr.replyThreadNotFound') }; return; }
    if (n.pullRequest.number !== pr.number || n.pullRequest.repository?.nameWithOwner?.toLowerCase() !== repo) { threads[id] = { ok: false, reason: msg('interventions.pr.replyThreadOtherPr') }; return; }
    const c = n.comments?.nodes?.[0];
    threads[id] = { ok: true, path: n.path, line: n.line ?? undefined, resolved: Boolean(n.isResolved), author: c?.author?.login, excerpt: (c?.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 300), url: c?.url };
  });
  return { account, threads };
}

/**
 * Pubblica una risposta nella discussione del commento a cui si riferisce, mai come commento generale. Prima verifica
 * che l'account di gh sia ancora quello mostrato alla persona e che la discussione sia di questa PR.
 * Solo GitHub. Il testo passa come argomento, senza shell. In prova non pubblica nulla.
 */
export async function postPrReply(cwd: string, prUrl: string, body: string, thread: string | undefined, expectedAccount: string, simulate: boolean): Promise<PrPost> {
  if (!thread) return { ok: false, reason: msg('interventions.pr.replyNoThread') };
  const ctx = await prReplyContext(cwd, prUrl, [thread], simulate);
  if (ctx.accountError) return { ok: false, reason: ctx.accountError };
  if (ctx.account !== expectedAccount) return { ok: false, reason: msg('interventions.pr.replyAccountChanged', { expected: expectedAccount, actual: ctx.account ?? '' }) };
  const target = ctx.threads[thread];
  if (!target?.ok) return { ok: false, reason: target?.reason ?? msg('interventions.pr.replyThreadNotFound') };
  if (simulate) return { ok: true, url: target.url };
  const r = await exec('gh', ['api', 'graphql', '-f', 'query=mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{url}}}', '-f', `t=${thread}`, '-f', `b=${body}`, '--jq', '.data.addPullRequestReviewThreadReply.comment.url'], cwd);
  if (!r.ok) return { ok: false, reason: r.missing ? msg('interventions.pr.toolMissing', { tool: 'gh' }) : msg('interventions.pr.replyFailed', { detail: r.err }) };
  const url = r.out.trim();
  return { ok: true, ...(/^https:\/\//.test(url) ? { url } : {}) };
}

/** Branch git con caratteri sicuri da passare a un comando (anche attraverso la shell di Windows). */
const SAFE_BRANCH = /^[\w./-]+$/;

export type PrDetection = { ok: true; pr: DetectedPr } | { ok: false; reason: Msg };

/** Trova la PR aperta del branch corrente: GitHub con gh, Azure DevOps con az. In prova restituisce una PR simulata. */
export async function detectPr(cwd: string, simulate: boolean): Promise<PrDetection> {
  const head = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const branch = head.ok ? head.out.trim() : '';
  if (simulate) return { ok: true, pr: { url: 'https://github.com/esempio/progetto/pull/42', title: 'Simulazione', branch: branch || 'feature/esempio', number: 42 } };
  if (!branch || branch === 'HEAD') return { ok: false, reason: msg('interventions.pr.noBranch') };
  const remote = await exec('git', ['remote', 'get-url', 'origin'], cwd);
  const azure = remote.ok && /dev\.azure\.com|visualstudio\.com/i.test(remote.out);

  if (!azure) {
    const r = await exec('gh', ['pr', 'view', '--json', 'url,title,number,headRefName,state'], cwd);
    if (!r.ok) return { ok: false, reason: r.missing ? msg('interventions.pr.toolMissing', { tool: 'gh' }) : msg('interventions.pr.notFound', { branch, detail: r.err }) };
    try {
      const j = JSON.parse(r.out);
      if (j.state && j.state !== 'OPEN') return { ok: false, reason: msg('interventions.pr.notOpen', { branch, url: j.url, state: String(j.state).toLowerCase() }) };
      return { ok: true, pr: { url: String(j.url), title: String(j.title ?? ''), branch: String(j.headRefName ?? branch), number: Number(j.number) || undefined } };
    } catch {
      return { ok: false, reason: msg('interventions.pr.notFound', { branch, detail: r.out.slice(0, 200) }) };
    }
  }

  if (!SAFE_BRANCH.test(branch)) return { ok: false, reason: msg('interventions.pr.notFound', { branch, detail: '' }) };
  // az su Windows è un .cmd: serve la shell, e il branch è già stato controllato.
  const r = await exec('az', ['repos', 'pr', 'list', '--detect', 'true', '--source-branch', branch, '--status', 'active', '--output', 'json'], cwd, process.platform === 'win32');
  if (!r.ok) return { ok: false, reason: r.missing ? msg('interventions.pr.toolMissing', { tool: 'az' }) : msg('interventions.pr.notFound', { branch, detail: r.err }) };
  try {
    const list = JSON.parse(r.out) as { pullRequestId: number; title?: string; repository?: { webUrl?: string } }[];
    const pr = list[0];
    if (!pr) return { ok: false, reason: msg('interventions.pr.notFound', { branch, detail: '' }) };
    const url = pr.repository?.webUrl ? `${pr.repository.webUrl}/pullrequest/${pr.pullRequestId}` : `PR ${pr.pullRequestId}`;
    return { ok: true, pr: { url, title: pr.title ?? '', branch, number: pr.pullRequestId } };
  } catch {
    return { ok: false, reason: msg('interventions.pr.notFound', { branch, detail: r.out.slice(0, 200) }) };
  }
}
