import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FolderInfo, GitState } from '../shared/types.ts';
import { projectClaudeMdPath } from './rules.ts';

function git(dir: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, ...args], { timeout: 8000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/** Ramo e commit attuali della cartella; undefined se non è un repository git (o git non è disponibile). */
export async function gitState(dir: string): Promise<GitState | undefined> {
  if (!dir || !path.isAbsolute(dir) || !fs.existsSync(dir)) return undefined;
  const head = (await git(dir, ['rev-parse', 'HEAD']))?.trim();
  if (!head) return undefined;
  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
  return { branch: branch || undefined, head, at: new Date().toISOString() };
}

/** Controlla una cartella di progetto: esistenza, stato git e presenza di CLAUDE.md. */
export async function folderInfo(p: string): Promise<FolderInfo> {
  const info: FolderInfo = { path: p, exists: false, isDirectory: false, claudeMd: false };
  if (!p || !path.isAbsolute(p) || !fs.existsSync(p)) return info;
  info.exists = true;
  info.isDirectory = fs.statSync(p).isDirectory();
  if (!info.isDirectory) return info;
  info.claudeMd = Boolean(projectClaudeMdPath(p));
  const inside = (await git(p, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true';
  if (!inside) {
    info.git = { isRepo: false };
    return info;
  }
  const branch = (await git(p, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim();
  const status = await git(p, ['status', '--porcelain']);
  info.git = { isRepo: true, branch, pendingChanges: status === null ? undefined : status.split('\n').filter(Boolean).length };
  return info;
}
