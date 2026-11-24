import fs from 'node:fs';
import path from 'node:path';
import { extraStoryUrls, KNOWN_TOOLS, WRITE_TOOLS, type SkillInfo, type ValidationIssue, type Workflow } from '../shared/types.ts';
import { msg, type Msg } from '../shared/i18n.ts';
import { serverT } from './i18n.ts';
import { discoverSkills, phaseSkills, skillSources } from './skills.ts';
import { parseStoryUrl } from './story.ts';

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
  for (const x of wf.settings.extraDirs ?? []) {
    const d = x.trim();
    if (!d) continue;
    if (!path.isAbsolute(d)) warn(msg('validate.extraDirNotAbsolute', { dir: d }));
    else if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) warn(msg('validate.extraDirMissing', { dir: d }));
  }

  if (!(wf.settings.maxParallel >= 1 && wf.settings.maxParallel <= 8)) err(msg('validate.maxParallelRange'));

  // Correggere i punti di una PR richiede la user story: le correzioni devono rispettarne specifiche e criteri di accettazione.
  const prNode = wf.nodes.find((n) => n.data.pr);
  if (prNode) {
    const story = wf.settings.story?.trim();
    if (!story) err(msg('validate.prNeedsStory', { name: prNode.data.label || prNode.id }), prNode.id);
    else if (!parseStoryUrl(story)) err(msg('validate.storyInvalid'), prNode.id);
  }
  // User story aggiuntive: ognuna deve essere un work item o una issue riconoscibile.
  for (const url of extraStoryUrls(wf.settings)) if (!parseStoryUrl(url)) err(msg('validate.extraStoryInvalid', { url }));

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
      const check = d.readyCheck ?? 'url';
      if (d.show) {
        // Fase "mostra": il comando è composto da Regia; progetto e dispositivo si verificano all'avvio.
        if (d.show.target === 'browser' && d.show.existing && !d.url?.trim()) err(msg('validate.showNeedsUrl', { name }), n.id);
        if (d.url?.trim() && !/^https?:\/\/[^\s]+$/i.test(d.url.trim())) err(msg('validate.invalidUrl', { name }), n.id);
        if (d.subdir?.trim() && (path.isAbsolute(d.subdir.trim()) || d.subdir.includes('..'))) err(msg('validate.subdirNotRelative', { name }), n.id);
        if (d.readyTimeoutSec !== undefined && !(d.readyTimeoutSec >= 5 && d.readyTimeoutSec <= 3600)) err(msg('validate.readyTimeoutRange', { name }), n.id);
        if (!wf.edges.some((e) => e.source === n.id)) warn(msg('validate.serverNoSuccessor', { name }), n.id);
        continue;
      }
      if (!d.command?.trim()) {
        if (!d.url?.trim()) err(msg('validate.serverNoCommand', { name }), n.id);
        else if (check !== 'url') err(msg('validate.externalNeedsUrl', { name }), n.id);
      }
      if (d.command?.trim() && check === 'output' && !d.readyPattern?.trim()) err(msg('validate.readyPatternMissing', { name }), n.id);
      if (d.url?.trim() && !/^https?:\/\/[^\s]+$/i.test(d.url.trim())) err(msg('validate.invalidUrl', { name }), n.id);
      if (d.subdir?.trim() && (path.isAbsolute(d.subdir.trim()) || d.subdir.includes('..'))) err(msg('validate.subdirNotRelative', { name }), n.id);
      if (d.nodeVersion?.trim() && !/^(v?\d+(\.\d+){0,2}|lts.*|[<>=^~].+)$/i.test(d.nodeVersion.trim())) err(msg('validate.invalidNodeVersion', { name }), n.id);
      if (d.readyTimeoutSec !== undefined && !(d.readyTimeoutSec >= 5 && d.readyTimeoutSec <= 3600)) err(msg('validate.readyTimeoutRange', { name }), n.id);
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
    if (d.pr) {
      // Punti della PR: senza URL si usa quello dell'obiettivo o, in mancanza, la PR del branch corrente (confermata
      // durante l'esecuzione, perché la PR può nascere dopo aver creato il workflow). Bash le serve per gh o az.
      const url = d.pr.url.trim();
      if (url && !/^https?:\/\/[^\s]+$/i.test(url)) err(msg('validate.prUrlInvalid', { name }), n.id);
    }
    if ((d.kind === 'analisi' || d.kind === 'revisione') && !d.pr && d.allowedTools.some((x) => WRITE_TOOLS.includes(x))) {
      warn(d.kind === 'analisi' ? msg('validate.readOnlyKindWrites.analisi', { name }) : msg('validate.readOnlyKindWrites.revisione', { name }), n.id);
    }
    if (d.maxTurns !== undefined && !(Number.isInteger(d.maxTurns) && d.maxTurns > 0)) err(msg('validate.invalidMaxTurns', { name }), n.id);
    if (d.maxTurns === undefined) warn(msg('validate.noMaxTurns', { name }), n.id);
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
