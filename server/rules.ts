// Regole generali applicate agli agenti.
// - Regole personali di Claude Code: ~/.claude/CLAUDE.md, lette a ogni esecuzione e mai modificate da Regia.
//   Il SDK è avviato senza impostazioni utente (niente hook o plugin personali), quindi queste regole
//   vengono aggiunte esplicitamente al prompt di sistema di ogni fase.
// - Regole di Regia: testo modificabile dall'interfaccia, salvato in data/regole.md.
// - CLAUDE.md del progetto: caricato dalla CLI stessa quando l'opzione del workflow è attiva; qui viene solo letto per mostrarlo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppliedRules, RulesInfo, WorkflowSettings } from '../shared/types.ts';
import { DATA_DIR } from './store.ts';

export const GLOBAL_RULES_PATH = path.resolve(process.env.REGIA_GLOBAL_RULES || path.join(os.homedir(), '.claude', 'CLAUDE.md'));
const REGIA_RULES_PATH = path.join(DATA_DIR, 'regole.md');
const MAX_RULES = 20000;

const DEFAULT_REGIA_RULES = `- Non eseguire git commit, git push o altre operazioni che pubblicano modifiche, salvo che le istruzioni della fase lo chiedano esplicitamente.
- Non modificare file fuori dalla cartella del progetto.
- Non leggere né riportare file con credenziali (.env, chiavi, token) se non è indispensabile al compito.
`;

function readText(p: string): { exists: boolean; text: string } {
  try {
    return { exists: true, text: fs.readFileSync(p, 'utf8').slice(0, MAX_RULES) };
  } catch {
    return { exists: false, text: '' };
  }
}

export function ensureRegiaRules() {
  if (!fs.existsSync(REGIA_RULES_PATH)) fs.writeFileSync(REGIA_RULES_PATH, DEFAULT_REGIA_RULES);
}

export function projectClaudeMdPath(projectDir: string): string | undefined {
  for (const p of [path.join(projectDir, 'CLAUDE.md'), path.join(projectDir, '.claude', 'CLAUDE.md')]) if (fs.existsSync(p)) return p;
  return undefined;
}

export function getRules(projectDir?: string): RulesInfo {
  const info: RulesInfo = {
    global: { path: GLOBAL_RULES_PATH, ...readText(GLOBAL_RULES_PATH) },
    regia: { path: REGIA_RULES_PATH, text: readText(REGIA_RULES_PATH).text },
  };
  if (projectDir && path.isAbsolute(projectDir)) {
    const p = projectClaudeMdPath(projectDir);
    info.project = p ? { path: p, ...readText(p) } : { path: path.join(projectDir, 'CLAUDE.md'), exists: false, text: '' };
  }
  return info;
}

export function saveRegiaRules(text: string) {
  fs.writeFileSync(REGIA_RULES_PATH, text.slice(0, MAX_RULES));
}

/** Regole da applicare a un'esecuzione, fotografate all'avvio. */
export function snapshotRules(settings: WorkflowSettings): AppliedRules {
  const projectPath = settings.loadProjectSettings && settings.projectDir ? projectClaudeMdPath(settings.projectDir) : undefined;
  if (settings.applyGeneralRules === false) return { applied: false, projectPath };
  const r = getRules();
  return {
    applied: true,
    globalPath: r.global.exists ? r.global.path : undefined,
    global: r.global.exists ? r.global.text.trim() : undefined,
    regia: r.regia.text.trim() || undefined,
    projectPath,
  };
}

/** Testo aggiunto al prompt di sistema di ogni fase. */
export function rulesPrompt(rules: AppliedRules | undefined): string {
  if (!rules?.applied) return '';
  const parts: string[] = [];
  if (rules.global) parts.push(`## Regole personali dell'utente (${rules.globalPath})\n${rules.global}`);
  if (rules.regia) parts.push(`## Regole per i workflow\n${rules.regia}`);
  if (!parts.length) return '';
  return `\n\n# Regole generali\nRispetta sempre queste regole, in ogni file, commento, messaggio di commit e testo che produci. Prevalgono sulle istruzioni della fase in caso di conflitto.\n\n${parts.join('\n\n')}`;
}
