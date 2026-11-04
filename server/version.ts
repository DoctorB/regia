import fs from 'node:fs';
import path from 'node:path';
import semver from 'semver';
import type { VersionInfo } from '../shared/types.ts';
import { ROOT } from './store.ts';

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string; repository?: { url?: string } };

/** "git+https://github.com/owner/repo.git" → "owner/repo". */
const repo = /github\.com[/:]([^/]+\/[^/.]+)/.exec(pkg.repository?.url ?? '')?.[1];

const CACHE_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
let cache: { at: number; latest?: string } | null = null;

/**
 * Versione in uso e ultima versione pubblicata, letta dal package.json del ramo principale su GitHub.
 * Il controllo è facoltativo: senza rete o con REGIA_UPDATE_CHECK=0 si restituisce solo la versione in uso.
 */
export async function versionInfo(): Promise<VersionInfo> {
  const info: VersionInfo = { current: pkg.version, updateAvailable: false };
  if (!repo) return info;
  info.repoUrl = `https://github.com/${repo}`;
  if (process.env.REGIA_UPDATE_CHECK === '0') return info;

  // Dopo un errore si riprova prima, così un avvio senza rete non nasconde gli aggiornamenti per ore.
  if (!cache || Date.now() - cache.at > (cache.latest ? CACHE_MS : RETRY_MS)) {
    let latest: string | undefined;
    try {
      const r = await fetch(`https://raw.githubusercontent.com/${repo}/main/package.json`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) latest = semver.valid(((await r.json()) as { version?: string }).version) ?? undefined;
    } catch { /* rete assente: si riprova al prossimo intervallo */ }
    cache = { at: Date.now(), latest };
  }
  if (cache.latest) {
    info.latest = cache.latest;
    info.updateAvailable = semver.gt(cache.latest, pkg.version);
  }
  return info;
}
