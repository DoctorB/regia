// Permessi di una fase agente in parole semplici: cosa può fare, invece degli strumenti uno per uno.
// Gli strumenti restano il dato salvato (allowedTools); il livello è una vista su di essi.

export type PermissionLevel = 'lettura' | 'modifica' | 'internet';

export const PERMISSION_LEVELS: PermissionLevel[] = ['lettura', 'modifica', 'internet'];

const READ = ['Read', 'Glob', 'Grep'];
const EDIT = [...READ, 'Edit', 'Write', 'Bash'];

/** Strumenti di ogni livello. Bash sta con la modifica: un comando può comunque cambiare i file. */
export const LEVEL_TOOLS: Record<PermissionLevel, string[]> = {
  lettura: READ,
  modifica: EDIT,
  internet: [...EDIT, 'WebFetch', 'WebSearch'],
};

const WRITES = ['Edit', 'Write', 'Bash', 'NotebookEdit'];
const WEB = ['WebFetch', 'WebSearch'];

/** Livello raggiunto dagli strumenti: basta uno strumento che modifica (o che va su internet) per salire. */
export function permissionLevel(tools: readonly string[]): PermissionLevel {
  if (tools.some((x) => WEB.includes(x))) return 'internet';
  if (tools.some((x) => WRITES.includes(x))) return 'modifica';
  return 'lettura';
}

/** Gli strumenti non sono esattamente quelli del livello (ad esempio Bash senza Edit, o subagenti attivi). */
export function isCustomTools(tools: readonly string[]): boolean {
  const base = LEVEL_TOOLS[permissionLevel(tools)];
  return tools.length !== base.length || base.some((x) => !tools.includes(x));
}

/** Strumenti per il livello scelto nell'editor; restano gli strumenti accessori già attivi (subagenti, attività). */
export function toolsForLevel(tools: readonly string[], level: PermissionLevel): string[] {
  const keep = tools.filter((x) => x === 'Agent' || x === 'TodoWrite' || (x === 'NotebookEdit' && level !== 'lettura'));
  return [...LEVEL_TOOLS[level], ...keep.filter((x) => !LEVEL_TOOLS[level].includes(x))];
}

/** Strumenti dopo aver concesso un livello: si aggiunge ciò che manca, senza togliere nulla. */
export function grantLevel(tools: readonly string[], level: PermissionLevel): string[] {
  return [...tools, ...LEVEL_TOOLS[level].filter((x) => !tools.includes(x))];
}

/** Al livello mancano strumenti rispetto a quelli attivi. */
export function lacksLevel(tools: readonly string[], level: PermissionLevel): boolean {
  return LEVEL_TOOLS[level].some((x) => !tools.includes(x));
}
