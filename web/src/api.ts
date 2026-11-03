import { currentLocaleTag, tm } from './i18n.tsx';
import type { ApiErrorBody, ContinuationPlan, EnvInfo, FolderInfo, HumanAction, Insight, RulesInfo, Run, RunMode, RunSummary, SkillInfo, ValidationIssue, Workflow, WorkflowTemplate } from '../../shared/types.ts';

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const body = j as Partial<ApiErrorBody>;
    // Messaggio localizzato se il server ha indicato la chiave, altrimenti il testo ricevuto.
    const err = new Error(tm(body.msg, body.error ?? `HTTP ${r.status}`)) as Error & { issues?: ValidationIssue[] };
    err.issues = body.issues;
    throw err;
  }
  return j as T;
}

export const api = {
  env: (refresh = false) => req<EnvInfo>('GET', `/api/env${refresh ? '?refresh=1' : ''}`),
  workflows: () => req<Workflow[]>('GET', '/api/workflows'),
  templates: (lang?: string) => req<WorkflowTemplate[]>('GET', `/api/templates${lang ? `?lang=${lang}` : ''}`),
  duplicateWorkflow: (id: string) => req<Workflow>('POST', `/api/workflows/${id}/duplicate`),
  renameGroup: (from: string, to: string) => req<{ ok: boolean; updated: number }>('POST', '/api/workflow-groups/rename', { from, to }),
  createWorkflow: (body: { name?: string; projectDir?: string; goal?: string; templateId?: string; language?: string; group?: string }) => req<Workflow>('POST', '/api/workflows', body),
  rules: (projectDir?: string) => req<RulesInfo>('GET', `/api/rules${projectDir ? `?projectDir=${encodeURIComponent(projectDir)}` : ''}`),
  saveRules: (text: string) => req<RulesInfo>('PUT', '/api/rules', { text }),
  skills: (projectDir: string, sources: { project: boolean; personal: boolean }) => req<{ personalDir: string; skills: SkillInfo[] }>('GET', `/api/skills?projectDir=${encodeURIComponent(projectDir)}&project=${sources.project ? 1 : 0}&personal=${sources.personal ? 1 : 0}`),
  folderInfo: (path: string) => req<FolderInfo>('GET', `/api/folder-info?path=${encodeURIComponent(path)}`),
  saveWorkflow: (wf: Workflow) => req<Workflow>('PUT', `/api/workflows/${wf.id}`, wf),
  deleteWorkflow: (id: string, withRuns = false) => req<{ ok: boolean; removedRuns: number }>('DELETE', `/api/workflows/${id}${withRuns ? '?runs=1' : ''}`),
  validate: (workflow: Workflow, mode: RunMode) => req<ValidationIssue[]>('POST', '/api/validate', { workflow, mode }),
  runs: (workflowId?: string) => req<RunSummary[]>('GET', `/api/runs${workflowId ? `?workflowId=${workflowId}` : ''}`),
  run: (id: string) => req<Run>('GET', `/api/runs/${id}`),
  insights: (id: string) => req<Insight[]>('GET', `/api/runs/${id}/insights`),
  startRun: (workflowId: string, mode: RunMode, confirmReal = false, continueFrom?: string) => req<{ id: string }>('POST', '/api/runs', { workflowId, mode, confirmReal, continueFrom }),
  continuation: (runId: string, workflowId: string) => req<ContinuationPlan & { mode: RunMode }>('GET', `/api/runs/${runId}/continuation?workflowId=${workflowId}`),
  action: (runId: string, nodeId: string, action: HumanAction, feedback?: string) => req<{ ok: boolean }>('POST', `/api/runs/${runId}/action`, { nodeId, action, feedback }),
  serviceAction: (runId: string, nodeId: string, action: 'ferma' | 'riavvia') => req<{ ok: boolean }>('POST', `/api/runs/${runId}/service/${nodeId}`, { action }),
  cancel: (runId: string) => req<{ ok: boolean }>('POST', `/api/runs/${runId}/cancel`),
};

export const fmtUsd = (n: number | null | undefined, digits = 4) => (n === null || n === undefined ? '—' : `$${n.toFixed(digits)}`);
export const fmtTok = (n: number | undefined) => (n ?? 0).toLocaleString(currentLocaleTag());
export const fmtDur = (ms?: number) => {
  if (ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
export const fmtTime = (iso?: string) => (iso ? new Date(iso).toLocaleString(currentLocaleTag(), { dateStyle: 'short', timeStyle: 'medium' }) : '—');
export const runDuration = (r: { startedAt: string; endedAt?: string }) => (r.endedAt ? Date.parse(r.endedAt) - Date.parse(r.startedAt) : Date.now() - Date.parse(r.startedAt));
