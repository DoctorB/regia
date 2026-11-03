import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { EnvInfo } from '../shared/types.ts';
import { DATA_DIR, ROOT } from './store.ts';
import { GLOBAL_RULES_PATH } from './rules.ts';

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15000, shell: process.platform === 'win32', windowsHide: true }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

let cache: { at: number; info: EnvInfo } | null = null;

/** Rileva l'autenticazione disponibile senza leggere né restituire credenziali. */
export async function envInfo(force = false): Promise<EnvInfo> {
  if (cache && !force && Date.now() - cache.at < 60000) return cache.info;
  const sdkPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8'));
  const info: EnvInfo = {
    sdkVersion: sdkPkg.version,
    auth: { loggedIn: false, apiKeyEnv: Boolean(process.env.ANTHROPIC_API_KEY) },
    realRunsEnabled: process.env.REGIA_DISABLE_REAL !== '1',
    dataDir: DATA_DIR,
    globalRulesPath: GLOBAL_RULES_PATH,
  };
  try {
    info.claudeCodeVersion = (await run('claude', ['--version'])).trim();
  } catch { /* CLI non installata globalmente: il SDK usa comunque il proprio eseguibile */ }
  try {
    const j = JSON.parse(await run('claude', ['auth', 'status']));
    // Solo campi non sensibili: niente email, organizzazione o token.
    info.auth.loggedIn = Boolean(j.loggedIn);
    info.auth.authMethod = j.authMethod;
    info.auth.apiProvider = j.apiProvider;
    info.auth.subscriptionType = j.subscriptionType;
  } catch (e) {
    info.auth.error = 'Impossibile leggere lo stato di autenticazione (comando "claude auth status").';
  }
  cache = { at: Date.now(), info };
  return info;
}
