import fs from 'node:fs';
import path from 'node:path';
import { KNOWN_TOOLS, WRITE_TOOLS, type ValidationIssue, type Workflow } from '../shared/types.ts';

/** Ordine topologico; restituisce null se il grafo ha cicli. */
export function topoOrder(wf: Workflow): string[] | null {
  const indeg = new Map(wf.nodes.map((n) => [n.id, 0]));
  for (const e of wf.edges) if (indeg.has(e.target)) indeg.set(e.target, indeg.get(e.target)! + 1);
  const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of wf.edges.filter((e) => e.source === id)) {
      const d = indeg.get(e.target)! - 1;
      indeg.set(e.target, d);
      if (d === 0) queue.push(e.target);
    }
  }
  return order.length === wf.nodes.length ? order : null;
}

export function validateWorkflow(wf: Workflow, mode: 'prova' | 'reale' = 'prova'): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (message: string, nodeId?: string) => issues.push({ level: 'errore', message, nodeId });
  const warn = (message: string, nodeId?: string) => issues.push({ level: 'avviso', message, nodeId });

  if (!wf.name?.trim()) err('Il workflow non ha un nome.');
  if (wf.nodes.length === 0) err('Il diagramma è vuoto: aggiungi almeno una fase.');

  const ids = new Set<string>();
  for (const n of wf.nodes) {
    if (ids.has(n.id)) err(`Identificativo di fase duplicato: ${n.id}`, n.id);
    ids.add(n.id);
  }
  const labels = new Map<string, number>();
  for (const n of wf.nodes) labels.set(n.data.label.trim(), (labels.get(n.data.label.trim()) ?? 0) + 1);
  for (const [l, c] of labels) if (c > 1) warn(`Più fasi si chiamano "${l}": nel pannello eventi sarà difficile distinguerle.`);

  const seenEdges = new Set<string>();
  for (const e of wf.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) err(`Collegamento ${e.id} verso una fase inesistente.`);
    if (e.source === e.target) err('Una fase è collegata a se stessa.', e.source);
    const k = `${e.source}->${e.target}`;
    if (seenEdges.has(k)) warn('Collegamento duplicato tra le stesse fasi.', e.target);
    seenEdges.add(k);
  }
  if (wf.nodes.length && !topoOrder(wf)) err('Il diagramma contiene un ciclo: le fasi devono formare un grafo aciclico.');

  const dir = wf.settings.projectDir?.trim();
  if (!dir) err('Cartella del progetto non impostata (Impostazioni workflow).');
  else if (!path.isAbsolute(dir)) err('La cartella del progetto deve essere un percorso assoluto.');
  else if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) err(`La cartella del progetto non esiste: ${dir}`);

  if (wf.settings.runBudgetUsd !== undefined && !(wf.settings.runBudgetUsd > 0)) err('Il limite di spesa per esecuzione deve essere maggiore di zero.');
  if (mode === 'reale' && wf.settings.runBudgetUsd === undefined) warn('Nessun limite di spesa per esecuzione: consigliato impostarlo prima di un\'esecuzione reale.');
  if (!(wf.settings.maxParallel >= 1 && wf.settings.maxParallel <= 8)) err('Le fasi in parallelo devono essere tra 1 e 8.');

  const hasIn = new Set(wf.edges.map((e) => e.target));
  const hasOut = new Set(wf.edges.map((e) => e.source));
  for (const n of wf.nodes) {
    const d = n.data;
    const name = `"${d.label || n.id}"`;
    if (!d.label?.trim()) err('Fase senza nome.', n.id);
    if (wf.nodes.length > 1 && !hasIn.has(n.id) && !hasOut.has(n.id)) warn(`La fase ${name} non è collegata a nessun'altra.`, n.id);
    if (d.kind === 'server') {
      if (!d.command?.trim()) err(`La fase ${name} non ha un comando da avviare.`, n.id);
      if (d.url?.trim() && !/^https?:\/\/[^\s]+$/i.test(d.url.trim())) err(`URL non valido in ${name} (es. http://localhost:5173).`, n.id);
      if (d.subdir?.trim() && (path.isAbsolute(d.subdir.trim()) || d.subdir.includes('..'))) err(`La sottocartella di ${name} deve essere un percorso relativo dentro il progetto.`, n.id);
      if (d.nodeVersion?.trim() && !/^(v?d+(.d+){0,2}|lts.*|[<>=^~].+)$/i.test(d.nodeVersion.trim())) err(`Versione di Node non valida in ${name} (es. 24, 22.23, >=22.23.4).`, n.id);
      if (d.readyTimeoutSec !== undefined && !(d.readyTimeoutSec >= 5 && d.readyTimeoutSec <= 900)) err(`Il tempo di attesa di ${name} deve essere tra 5 e 900 secondi.`, n.id);
      if (!wf.edges.some((e) => e.source === n.id)) warn(`Il server ${name} non ha fasi successive: verrà fermato appena l'esecuzione termina. Aggiungi un'approvazione dopo per avere il tempo di verificarlo.`, n.id);
      continue;
    }
    if (d.kind === 'approvazione') {
      if (!hasIn.has(n.id)) err(`L'approvazione ${name} deve avere almeno una fase precedente da approvare.`, n.id);
      continue;
    }
    if (!d.instructions?.trim()) err(`La fase ${name} non ha istruzioni.`, n.id);
    if (d.allowedTools.length === 0) warn(`La fase ${name} non ha strumenti: potrà solo rispondere a testo.`, n.id);
    for (const t of d.allowedTools) {
      if (!(KNOWN_TOOLS as readonly string[]).includes(t) && !t.startsWith('mcp__')) err(`Strumento sconosciuto "${t}" in ${name}.`, n.id);
    }
    if ((d.kind === 'analisi' || d.kind === 'revisione') && d.allowedTools.some((t) => WRITE_TOOLS.includes(t))) {
      warn(`La fase ${name} è di tipo ${d.kind} ma può modificare file o eseguire comandi.`, n.id);
    }
    if (d.maxTurns !== undefined && !(Number.isInteger(d.maxTurns) && d.maxTurns > 0)) err(`Numero massimo di turni non valido in ${name}.`, n.id);
    if (d.maxTurns === undefined) warn(`La fase ${name} non ha un limite di turni.`, n.id);
    if (d.maxBudgetUsd !== undefined && !(d.maxBudgetUsd > 0)) err(`Limite di spesa non valido in ${name}.`, n.id);
    if (d.model && !/^[a-zA-Z0-9.\-_[\]:]+$/.test(d.model)) err(`Nome modello non valido in ${name}.`, n.id);
  }
  return issues;
}
