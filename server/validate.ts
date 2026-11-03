import fs from 'node:fs';
import path from 'node:path';
import { KNOWN_TOOLS, WRITE_TOOLS, type SkillInfo, type ValidationIssue, type Workflow } from '../shared/types.ts';
import { msg, type Msg } from '../shared/i18n.ts';
import { serverT } from './i18n.ts';
import { discoverSkills, phaseSkills, skillSources } from './skills.ts';

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

/** Controlla il workflow. Ogni problema ha il messaggio localizzabile (msg) e il testo già reso nella lingua indicata. */
export function validateWorkflow(wf: Workflow, mode: 'prova' | 'reale' = 'prova', lang = 'it'): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const t = serverT(lang);
  const add = (level: ValidationIssue['level'], m: Msg, nodeId?: string) => issues.push({ level, message: t(m.key, m.params), msg: m, nodeId });
  const err = (m: Msg, nodeId?: string) => add('errore', m, nodeId);
  const warn = (m: Msg, nodeId?: string) => add('avviso', m, nodeId);

  if (!wf.name?.trim()) err(msg('validate.noName'));
  if (wf.nodes.length === 0) err(msg('validate.empty'));

  const ids = new Set<string>();
  for (const n of wf.nodes) {
    if (ids.has(n.id)) err(msg('validate.duplicateId', { id: n.id }), n.id);
    ids.add(n.id);
  }
  const labels = new Map<string, number>();
  for (const n of wf.nodes) labels.set(n.data.label.trim(), (labels.get(n.data.label.trim()) ?? 0) + 1);
  for (const [l, c] of labels) if (c > 1) warn(msg('validate.duplicateLabel', { label: l }));

  const seenEdges = new Set<string>();
  for (const e of wf.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) err(msg('validate.edgeMissingNode', { id: e.id }));
    if (e.source === e.target) err(msg('validate.selfLoop'), e.source);
    const k = `${e.source}->${e.target}`;
    if (seenEdges.has(k)) warn(msg('validate.duplicateEdge'), e.target);
    seenEdges.add(k);
  }
  if (wf.nodes.length && !topoOrder(wf)) err(msg('validate.cycle'));

  const dir = wf.settings.projectDir?.trim();
  if (!dir) err(msg('validate.noProjectDir'));
  else if (!path.isAbsolute(dir)) err(msg('validate.projectDirNotAbsolute'));
  else if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) err(msg('validate.projectDirMissing', { dir }));

  if (wf.settings.runBudgetUsd !== undefined && !(wf.settings.runBudgetUsd > 0)) err(msg('validate.runBudgetInvalid'));
  if (mode === 'reale' && wf.settings.runBudgetUsd === undefined) warn(msg('validate.noRunBudget'));
  if (!(wf.settings.maxParallel >= 1 && wf.settings.maxParallel <= 8)) err(msg('validate.maxParallelRange'));

  const hasIn = new Set(wf.edges.map((e) => e.target));
  const hasOut = new Set(wf.edges.map((e) => e.source));
  let skills: SkillInfo[] | undefined;
  for (const n of wf.nodes) {
    const d = n.data;
    // Nome della fase come appare nei messaggi (le virgolette sono nei testi tradotti).
    const name = d.label || n.id;
    if (!d.label?.trim()) err(msg('validate.phaseNoName'), n.id);
    if (wf.nodes.length > 1 && !hasIn.has(n.id) && !hasOut.has(n.id)) warn(msg('validate.notConnected', { name }), n.id);
    if (d.kind === 'server') {
      if (!d.command?.trim()) err(msg('validate.serverNoCommand', { name }), n.id);
      if (d.url?.trim() && !/^https?:\/\/[^\s]+$/i.test(d.url.trim())) err(msg('validate.invalidUrl', { name }), n.id);
      if (d.subdir?.trim() && (path.isAbsolute(d.subdir.trim()) || d.subdir.includes('..'))) err(msg('validate.subdirNotRelative', { name }), n.id);
      if (d.nodeVersion?.trim() && !/^(v?\d+(\.\d+){0,2}|lts.*|[<>=^~].+)$/i.test(d.nodeVersion.trim())) err(msg('validate.invalidNodeVersion', { name }), n.id);
      if (d.readyTimeoutSec !== undefined && !(d.readyTimeoutSec >= 5 && d.readyTimeoutSec <= 900)) err(msg('validate.readyTimeoutRange', { name }), n.id);
      if (!wf.edges.some((e) => e.source === n.id)) warn(msg('validate.serverNoSuccessor', { name }), n.id);
      continue;
    }
    if (d.kind === 'approvazione') {
      if (!hasIn.has(n.id)) err(msg('validate.approvalNoPredecessor', { name }), n.id);
      continue;
    }
    if (!d.instructions?.trim()) err(msg('validate.noInstructions', { name }), n.id);
    if (d.allowedTools.length === 0) warn(msg('validate.noTools', { name }), n.id);
    for (const tool of d.allowedTools) {
      if (!(KNOWN_TOOLS as readonly string[]).includes(tool) && !tool.startsWith('mcp__')) err(msg('validate.unknownTool', { tool, name }), n.id);
    }
    if ((d.kind === 'analisi' || d.kind === 'revisione') && d.allowedTools.some((x) => WRITE_TOOLS.includes(x))) {
      warn(d.kind === 'analisi' ? msg('validate.readOnlyKindWrites.analisi', { name }) : msg('validate.readOnlyKindWrites.revisione', { name }), n.id);
    }
    if (d.maxTurns !== undefined && !(Number.isInteger(d.maxTurns) && d.maxTurns > 0)) err(msg('validate.invalidMaxTurns', { name }), n.id);
    if (d.maxTurns === undefined) warn(msg('validate.noMaxTurns', { name }), n.id);
    if (d.maxBudgetUsd !== undefined && !(d.maxBudgetUsd > 0)) err(msg('validate.invalidBudget', { name }), n.id);
    if (d.model && !/^[a-zA-Z0-9.\-_[\]:]+$/.test(d.model)) err(msg('validate.invalidModel', { name }), n.id);
    if (d.skills && d.skills.length) {
      skills ??= discoverSkills(dir, skillSources(wf.settings));
      const found = phaseSkills(d, skills);
      if (found.missing.length) warn(msg('validate.skillsMissing', { name, skills: found.missing.map((s) => s.replace(/^(progetto|personale):/, '')).join(', ') }), n.id);
      else if (found.selected.length === 0) warn(msg('validate.skillsNone', { name }), n.id);
    }
  }
  return issues;
}
