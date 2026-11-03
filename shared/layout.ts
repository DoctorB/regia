// Disposizione automatica del diagramma, dall'alto verso il basso: ogni fase sta sotto le fasi da cui dipende,
// le fasi in parallelo affiancate. Usata per i preset, per il pulsante "Riordina" e per la vista di esecuzione.
import type { WorkflowEdge, WorkflowNode } from './types.ts';

export const NODE_W = 264;
export const NODE_H = 104;
const GAP_X = 48;
const GAP_Y = 64;

export function layoutGraph(nodes: WorkflowNode[], edges: WorkflowEdge[], nodeH = NODE_H): Record<string, { x: number; y: number }> {
  const ids = nodes.map((n) => n.id);
  const preds = new Map(ids.map((id) => [id, edges.filter((e) => e.target === id && ids.includes(e.source)).map((e) => e.source)]));
  // Livello = percorso più lungo da una fase iniziale (i cicli, non validi, vengono interrotti).
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (id: string): number => {
    if (rank.has(id)) return rank.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const r = Math.max(-1, ...preds.get(id)!.map(rankOf)) + 1;
    visiting.delete(id);
    rank.set(id, r);
    return r;
  };
  ids.forEach(rankOf);
  const levels: string[][] = [];
  for (const id of ids) (levels[rank.get(id)!] ??= []).push(id);
  // Ordine nel livello: media delle posizioni delle fasi precedenti, per ridurre gli incroci.
  const order = new Map<string, number>();
  levels.forEach((lvl, i) => {
    if (i > 0) {
      const bary = (id: string) => {
        const p = preds.get(id)!;
        return p.length ? p.reduce((s, x) => s + (order.get(x) ?? 0), 0) / p.length : 0;
      };
      lvl.sort((a, b) => bary(a) - bary(b));
    }
    lvl.forEach((id, k) => order.set(id, k - (lvl.length - 1) / 2));
  });
  const pos: Record<string, { x: number; y: number }> = {};
  for (const id of ids) pos[id] = { x: Math.round(order.get(id)! * (NODE_W + GAP_X)), y: rank.get(id)! * (nodeH + GAP_Y) };
  return pos;
}

/** Applica la disposizione automatica a una copia dei nodi. */
export function withLayout(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const pos = layoutGraph(nodes, edges);
  return nodes.map((n) => ({ ...n, position: pos[n.id] ?? n.position }));
}

/** Diagrammi salvati con la vecchia disposizione da sinistra a destra. */
export function looksHorizontal(nodes: WorkflowNode[], edges: WorkflowEdge[]): boolean {
  if (edges.length < 2) return false;
  const byId = new Map(nodes.map((n) => [n.id, n.position]));
  let horiz = 0;
  for (const e of edges) {
    const a = byId.get(e.source), b = byId.get(e.target);
    if (a && b && b.x - a.x > 120 && Math.abs(b.y - a.y) < Math.abs(b.x - a.x)) horiz++;
  }
  return horiz / edges.length > 0.6;
}
