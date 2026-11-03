import { useMemo } from 'react';
import {
  Background, Controls, Handle, Position, ReactFlow, applyNodeChanges, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps, type Connection,
} from '@xyflow/react';
import { isAgentKind, type NodeRunState, type NodeStatus, type PhaseConfig, type PhaseKind, type ValidationIssue, type Workflow } from '../../../shared/types.ts';
import { fmtTok, fmtUsd } from '../api.ts';

export const STATUS: Record<NodeStatus, { label: string; icon: string; cls: string }> = {
  in_attesa: { label: 'In attesa', icon: '○', cls: 'st-wait' },
  attiva: { label: 'Attiva', icon: '◉', cls: 'st-active' },
  completata: { label: 'Completata', icon: '✓', cls: 'st-good' },
  fallita: { label: 'Fallita', icon: '✕', cls: 'st-critical' },
  bloccata: { label: 'Bloccata', icon: '■', cls: 'st-serious' },
  attesa_intervento: { label: 'Attende te', icon: '✋', cls: 'st-warning' },
  saltata: { label: 'Saltata', icon: '↷', cls: 'st-skip' },
  riusata: { label: 'Riusata', icon: '♻', cls: 'st-reused' },
};

export const KIND_LABEL: Record<PhaseKind, string> = {
  analisi: 'Analisi', implementazione: 'Implementazione', test: 'Test', revisione: 'Revisione', approvazione: 'Approvazione umana', server: 'Server locale', personalizzata: 'Personalizzata',
};
const KIND_ICON: Record<PhaseKind, string> = {
  analisi: '🔍', implementazione: '🛠', test: '🧪', revisione: '👁', approvazione: '✋', server: '🌐', personalizzata: '◆',
};

type PhaseData = { cfg: PhaseConfig; run?: NodeRunState; issues: ValidationIssue[]; live: boolean };

function PhaseNode({ data, selected }: NodeProps<Node<PhaseData>>) {
  const { cfg, run, issues, live } = data;
  const st = run ? STATUS[run.status] : null;
  const attempts = run?.attempts ?? [];
  const cost = attempts.reduce((s, a) => s + (a.usage.costUsd ?? 0), 0);
  const active = attempts.find((a) => a.status === 'attiva');
  const liveTok = active ? active.live.inputTokens + active.live.cacheCreationInputTokens + active.live.cacheReadInputTokens : 0;
  const hasErr = issues.some((i) => i.level === 'errore');
  return (
    <div className={`phase ${st ? st.cls : ''} ${selected ? 'sel' : ''} ${hasErr && !live ? 'has-err' : ''} kind-${cfg.kind}`}>
      <Handle type="target" position={Position.Left} />
      <div className="phase-head">
        <span className="phase-kind" aria-hidden>{KIND_ICON[cfg.kind]}</span>
        <span className="phase-title">{cfg.label || '(senza nome)'}</span>
        {isAgentKind(cfg.kind) && <span className="chip">{cfg.model || 'predefinito'}</span>}
      </div>
      {st && (
        <div className="phase-status">
          <span className="badge"><span aria-hidden>{st.icon}</span> {st.label}</span>
          {attempts.length > 1 && <span className="muted">{attempts.length} tentativi</span>}
          {isAgentKind(cfg.kind) && attempts.length > 0 && <span className="muted mono">{fmtUsd(cost)}</span>}
        </div>
      )}
      {!st && (
        <div className="phase-sub muted">
          {cfg.kind === 'approvazione' ? 'Intervento umano' : cfg.kind === 'server' ? <span className="mono">{cfg.command || '(nessun comando)'}</span> : `${cfg.allowedTools.length} strumenti · ${cfg.maxTurns ?? '∞'} turni`}
          {cfg.reuseResult && ' · riuso'}
        </div>
      )}
      {live && run?.service && (
        <div className={`phase-service svc-${run.service.status}`}>
          {SERVICE_LABEL[run.service.status]}
          {run.service.url && (run.service.status === 'attivo' || run.service.status === 'simulato') && (
            <> · <a className="nodrag" href={run.service.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{run.service.url}</a></>
          )}
        </div>
      )}
      {live && run?.activity && <div className="phase-activity" title={run.activity}>{run.activity}</div>}
      {live && active && <div className="phase-sub muted mono">{fmtTok(liveTok)} token di input/cache (parziale)</div>}
      {live && run?.lastDecision && <div className="phase-decision" title={run.lastDecision}>“{run.lastDecision}”</div>}
      {!live && hasErr && <div className="phase-err">{issues.filter((i) => i.level === 'errore').length} errori</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const SERVICE_LABEL: Record<string, string> = {
  avvio: '⏳ avvio', attivo: '● attivo', simulato: '● attivo (simulato)', fermato: '■ fermato', terminato: '✕ chiuso', errore: '✕ errore',
};

const nodeTypes = { phase: PhaseNode };

interface Props {
  workflow: Workflow;
  runNodes?: Record<string, NodeRunState>;
  issues: ValidationIssue[];
  selectedId: string | null;
  editable: boolean;
  onSelect: (id: string | null) => void;
  onChange?: (wf: Workflow) => void;
}

export function Canvas({ workflow, runNodes, issues, selectedId, editable, onSelect, onChange }: Props) {
  const nodes: Node<PhaseData>[] = useMemo(() => workflow.nodes.map((n) => ({
    id: n.id, type: 'phase', position: n.position, selected: n.id === selectedId,
    data: { cfg: n.data, run: runNodes?.[n.id], issues: issues.filter((i) => i.nodeId === n.id), live: Boolean(runNodes) },
  })), [workflow.nodes, runNodes, issues, selectedId]);

  const edges: Edge[] = useMemo(() => workflow.edges.map((e) => {
    const s = runNodes?.[e.source]?.status;
    const t = runNodes?.[e.target]?.status;
    return {
      id: e.id, source: e.source, target: e.target,
      animated: t === 'attiva' || t === 'attesa_intervento',
      className: s === 'completata' || s === 'riusata' ? 'edge-done' : '',
    };
  }), [workflow.edges, runNodes]);

  const onNodesChange = (changes: NodeChange<Node<PhaseData>>[]) => {
    for (const c of changes) if (c.type === 'select' && c.selected) onSelect(c.id);
    if (!editable || !onChange) return;
    const removed = changes.filter((c) => c.type === 'remove').map((c) => (c as { id: string }).id);
    const moved = applyNodeChanges(changes.filter((c) => c.type === 'position' || c.type === 'remove'), nodes);
    const pos = new Map(moved.map((n) => [n.id, n.position]));
    if (!changes.some((c) => c.type === 'position' || c.type === 'remove')) return;
    onChange({
      ...workflow,
      nodes: workflow.nodes.filter((n) => !removed.includes(n.id)).map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })),
      edges: workflow.edges.filter((e) => !removed.includes(e.source) && !removed.includes(e.target)),
    });
    if (selectedId && removed.includes(selectedId)) onSelect(null);
  };

  const onEdgesChange = (changes: EdgeChange[]) => {
    if (!editable || !onChange) return;
    const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id);
    if (removed.length) onChange({ ...workflow, edges: workflow.edges.filter((e) => !removed.includes(e.id)) });
  };

  const onConnect = (c: Connection) => {
    if (!onChange || !c.source || !c.target || c.source === c.target) return;
    if (workflow.edges.some((e) => e.source === c.source && e.target === c.target)) return;
    onChange({ ...workflow, edges: [...workflow.edges, { id: `e_${Math.random().toString(36).slice(2, 8)}`, source: c.source, target: c.target }] });
  };

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onPaneClick={() => onSelect(null)}
      nodesDraggable={editable}
      nodesConnectable={editable}
      deleteKeyCode={editable ? ['Delete', 'Backspace'] : null}
      fitView
      fitViewOptions={{ padding: 0.15 }}
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
