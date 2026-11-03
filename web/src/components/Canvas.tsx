import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  Background, BackgroundVariant, Handle, MarkerType, Position, ReactFlow, applyNodeChanges, useReactFlow,
  type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react';
import { Crosshair, ExternalLink, LayoutGrid, Maximize2, Minus, Plus, TriangleAlert } from 'lucide-react';
import { isAgentKind, type NodeRunState, type PhaseConfig, type PhaseKind, type ServiceStatus, type ValidationIssue, type Workflow } from '../../../shared/types.ts';
import { layoutGraph, NODE_W } from '../../../shared/layout.ts';
import { fmtTok, fmtUsd } from '../api.ts';
import { useI18n } from '../i18n.tsx';
import { KindTile, STATUS_META, StatusPill, kindLabel, serviceLabel } from '../ui.tsx';

/**
 * Compatibilità con i componenti che usano ancora le etichette per tipo e per stato del server.
 * @deprecated usare kindLabel / serviceLabel da ui.tsx
 */
export const KIND_LABEL = new Proxy({} as Record<PhaseKind, string>, { get: (_, k) => (typeof k === 'string' ? kindLabel(k as PhaseKind) : undefined) });
/** @deprecated usare serviceLabel da ui.tsx */
export const SERVICE_LABEL = new Proxy({} as Record<string, string>, { get: (_, k) => (typeof k === 'string' ? serviceLabel(k as ServiceStatus) : undefined) });

type PhaseData = { cfg: PhaseConfig; run?: NodeRunState; issues: ValidationIssue[]; live: boolean };

function PhaseNode({ data, selected }: NodeProps<Node<PhaseData>>) {
  const { t, tm } = useI18n();
  const modelLabel = (m: string) => m || t('common.defaultModel');
  const { cfg, run, issues, live } = data;
  const status = run?.status;
  const tone = status ? STATUS_META[status].tone : 'idle';
  const attempts = run?.attempts ?? [];
  const cost = attempts.reduce((s, a) => s + (a.usage.costUsd ?? 0), 0);
  const active = attempts.find((a) => a.status === 'attiva');
  const liveTok = active ? active.live.inputTokens + active.live.cacheCreationInputTokens + active.live.cacheReadInputTokens : 0;
  const errors = issues.filter((i) => i.level === 'errore').length;
  const agent = isAgentKind(cfg.kind);
  const svc = run?.service;
  const svcUp = svc && (svc.status === 'attivo' || svc.status === 'simulato');

  const meta = cfg.kind === 'approvazione' ? kindLabel('approvazione')
    : cfg.kind === 'server' ? kindLabel('server')
      : `${kindLabel(cfg.kind)} · ${modelLabel(cfg.model)}`;

  return (
    <div className={`node tone-${live ? tone : 'idle'} ${selected ? 'is-selected' : ''} ${!live && errors ? 'has-error' : ''} ${live ? 'is-live' : ''}`} style={{ width: NODE_W }}>
      <Handle type="target" position={Position.Top} />
      <div className="node-head">
        <KindTile kind={cfg.kind} />
        <div className="node-titles">
          <div className="node-title">{cfg.label || t('common.untitled')}</div>
          <div className="node-meta">{meta}</div>
        </div>
        {live && status && <StatusPill status={status} compact />}
        {!live && errors > 0 && <span className="pill tone-bad" title={issues.map((i) => i.message).join('\n')}><TriangleAlert />{errors}</span>}
      </div>

      {!live && (
        <div className="node-foot">
          {agent && <><span>{t('canvas.tools', { count: cfg.allowedTools.length })}</span><span>{cfg.maxTurns ? t('canvas.turns', { count: cfg.maxTurns }) : t('canvas.freeTurns')}</span>{cfg.maxBudgetUsd ? <span>{t('canvas.maxBudget', { amount: cfg.maxBudgetUsd })}</span> : null}{cfg.skills === 'all' ? <span>{t('canvas.skillsAll')}</span> : cfg.skills?.length ? <span>{t('canvas.skills', { count: cfg.skills.length })}</span> : null}{cfg.reuseResult && <span>{t('canvas.reuse')}</span>}</>}
          {cfg.kind === 'server' && <code className="node-cmd">{cfg.command || t('canvas.noCommand')}</code>}
          {cfg.kind === 'approvazione' && <span>{t('canvas.waitsForYou')}</span>}
        </div>
      )}

      {live && (
        <div className="node-live">
          {run?.activity && <div className="node-activity" title={run.activity}>{run.activity}</div>}
          {svc && (
            <div className="node-service">
              <span className={`dot ${svcUp ? 'on' : ''}`} />{serviceLabel(svc.status)}
              {svcUp && svc.url && (
                <a className="nodrag" href={svc.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{svc.url.replace(/^https?:\/\//, '')}<ExternalLink /></a>
              )}
            </div>
          )}
          {run?.lastDecision && status !== 'in_attesa' && <div className="node-decision" title={run.lastDecision}>{run.lastDecision}</div>}
          {(agent && attempts.length > 0) || attempts.length > 1 ? (
            <div className="node-foot">
              {agent && attempts.length > 0 && <span className="num">{fmtUsd(cost, 3)}</span>}
              {active && <span className="num">{t('canvas.tokens', { n: fmtTok(liveTok) })}</span>}
              {attempts.length > 1 && <span>{t('canvas.attempts', { count: attempts.length })}</span>}
            </div>
          ) : null}
        </div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { phase: PhaseNode };

interface Props {
  workflow: Workflow;
  runNodes?: Record<string, NodeRunState>;
  issues: ValidationIssue[];
  selectedId: string | null;
  editable: boolean;
  onSelect: (id: string | null) => void;
  onChange?: (wf: Workflow) => void;
  /** Rilascio di una fase trascinata dalla palette. */
  onDropPhase?: (payload: string, position: { x: number; y: number }) => void;
}

export function Canvas({ workflow, runNodes, issues, selectedId, editable, onSelect, onChange, onDropPhase }: Props) {
  const { t } = useI18n();
  const rf = useReactFlow();
  const live = Boolean(runNodes);
  const [follow, setFollow] = useState(true);
  // In esecuzione il diagramma è sempre disposto automaticamente, per essere leggibile qualunque sia la disposizione salvata.
  // Le schede in esecuzione sono più alte (attività, decisione, costi): più spazio tra i livelli.
  const autoPos = useMemo(() => (live ? layoutGraph(workflow.nodes, workflow.edges, 150) : null), [live, workflow.nodes, workflow.edges]);

  const nodes: Node<PhaseData>[] = useMemo(() => workflow.nodes.map((n) => ({
    id: n.id, type: 'phase', position: autoPos?.[n.id] ?? n.position, selected: n.id === selectedId,
    data: { cfg: n.data, run: runNodes?.[n.id], issues: issues.filter((i) => i.nodeId === n.id), live },
  })), [workflow.nodes, runNodes, issues, selectedId, autoPos, live]);

  const edges: Edge[] = useMemo(() => workflow.edges.map((e) => {
    const s = runNodes?.[e.source]?.status;
    const t = runNodes?.[e.target]?.status;
    const done = s === 'completata' || s === 'riusata' || s === 'saltata';
    const flowing = done && (t === 'attiva' || t === 'attesa_intervento');
    return {
      id: e.id, source: e.source, target: e.target, type: 'smoothstep',
      animated: flowing,
      className: flowing ? 'edge-flow' : done ? 'edge-done' : '',
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      pathOptions: { borderRadius: 14 },
    } as Edge;
  }), [workflow.edges, runNodes]);

  // Segue la fase attiva (o quella che attende un intervento) durante l'esecuzione.
  const focusId = useMemo(() => {
    if (!runNodes) return null;
    const list = workflow.nodes.map((n) => runNodes[n.id]).filter(Boolean);
    return (list.find((n) => n.pendingActions?.length) ?? list.find((n) => n.status === 'attiva'))?.nodeId ?? null;
  }, [runNodes, workflow.nodes]);
  const lastFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!live || !follow || !focusId || focusId === lastFocus.current) return;
    lastFocus.current = focusId;
    const p = autoPos?.[focusId];
    if (p) rf.setCenter(p.x + NODE_W / 2, p.y + 60, { zoom: Math.max(rf.getZoom(), 0.85), duration: 450 });
  }, [focusId, follow, live, autoPos, rf]);

  // Inquadratura iniziale: tutto il diagramma se resta leggibile, altrimenti zoom leggibile dall'alto (o sulla fase attiva).
  // Calcolata dalle posizioni note delle fasi (non serve attendere le misure del DOM).
  const wrapRef = useRef<HTMLDivElement>(null);
  const frame = useCallback(() => {
    const el = wrapRef.current;
    if (!el || workflow.nodes.length === 0) return;
    const { width, height } = el.getBoundingClientRect();
    if (!width || !height) return;
    const estH = live ? 150 : 104;
    const pts = workflow.nodes.map((n) => autoPos?.[n.id] ?? n.position);
    const x0 = Math.min(...pts.map((p) => p.x)), x1 = Math.max(...pts.map((p) => p.x)) + NODE_W;
    const y0 = Math.min(...pts.map((p) => p.y)), y1 = Math.max(...pts.map((p) => p.y)) + estH;
    const fitZoom = Math.min((width - 80) / (x1 - x0), (height - 80) / (y1 - y0), 1);
    if (fitZoom >= 0.72) { rf.setViewport({ x: width / 2 - ((x0 + x1) / 2) * fitZoom, y: height / 2 - ((y0 + y1) / 2) * fitZoom, zoom: fitZoom }); return; }
    const z = 0.85;
    const p = live && focusId ? autoPos?.[focusId] : null;
    if (p) { lastFocus.current = focusId; rf.setViewport({ x: width / 2 - (p.x + NODE_W / 2) * z, y: height / 2 - (p.y + 60) * z, zoom: z }); return; }
    rf.setViewport({ x: width / 2 - ((x0 + x1) / 2) * z, y: 32 - y0 * z, zoom: z });
  }, [workflow.nodes, autoPos, live, focusId, rf]);

  const onNodesChange = (changes: NodeChange<Node<PhaseData>>[]) => {
    for (const c of changes) if (c.type === 'select' && c.selected) onSelect(c.id);
    if (!editable || !onChange) return;
    if (!changes.some((c) => c.type === 'position' || c.type === 'remove')) return;
    const removed = changes.filter((c) => c.type === 'remove').map((c) => (c as { id: string }).id);
    const moved = applyNodeChanges(changes.filter((c) => c.type === 'position' || c.type === 'remove'), nodes);
    const pos = new Map(moved.map((n) => [n.id, n.position]));
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

  const onDragOver = (e: DragEvent) => {
    if (!editable || !e.dataTransfer.types.includes('application/regia-phase')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (e: DragEvent) => {
    const payload = e.dataTransfer.getData('application/regia-phase');
    if (!payload || !onDropPhase) return;
    e.preventDefault();
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    onDropPhase(payload, { x: p.x - NODE_W / 2, y: p.y - 30 });
  };

  const relayout = () => {
    if (!onChange) return;
    const pos = layoutGraph(workflow.nodes, workflow.edges);
    onChange({ ...workflow, nodes: workflow.nodes.map((n) => ({ ...n, position: pos[n.id] ?? n.position })) });
    setTimeout(() => rf.fitView({ padding: 0.2, duration: 350 }), 30);
  };

  return (
    <div className="canvas-wrap" ref={wrapRef} onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onPaneClick={() => onSelect(null)}
        onInit={() => requestAnimationFrame(frame)}
        nodesDraggable={editable}
        nodesConnectable={editable}
        deleteKeyCode={editable ? ['Delete', 'Backspace'] : null}
        minZoom={0.2}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        connectionLineStyle={{ strokeWidth: 2 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
      </ReactFlow>

      <div className="canvas-tools" role="toolbar" aria-label={t('canvas.toolbar')}>
        <button className="icon-btn" onClick={() => rf.zoomIn({ duration: 150 })} title={t('canvas.zoomIn')} aria-label={t('canvas.zoomIn')}><Plus /></button>
        <button className="icon-btn" onClick={() => rf.zoomOut({ duration: 150 })} title={t('canvas.zoomOut')} aria-label={t('canvas.zoomOut')}><Minus /></button>
        <button className="icon-btn" onClick={() => rf.fitView({ padding: 0.2, duration: 300 })} title={t('canvas.fitViewTitle')} aria-label={t('canvas.fitView')}><Maximize2 /></button>
        {editable && <span className="tools-sep" />}
        {editable && <button className="btn sm ghost" onClick={relayout} title={t('canvas.relayoutTitle')}><LayoutGrid />{t('canvas.relayout')}</button>}
        {live && <span className="tools-sep" />}
        {live && (
          <button className={`btn sm ${follow ? 'soft' : 'ghost'}`} onClick={() => { setFollow(!follow); lastFocus.current = null; }} aria-pressed={follow} title={t('canvas.followTitle')}>
            <Crosshair />{t('canvas.follow')}
          </button>
        )}
      </div>

      {editable && workflow.nodes.length === 0 && (
        <div className="canvas-empty">
          <strong>{t('canvas.emptyTitle')}</strong>
          <span>{t('canvas.emptyText')}</span>
        </div>
      )}
    </div>
  );
}
