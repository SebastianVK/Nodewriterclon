import type { Project } from './types';
import { cardLabel, cardTags } from './types';
import { cardText, findMentions } from './mentions';

export type GKind = 'card' | 'codex';
export type EKind = 'flow' | 'mention';

export interface GNode {
  id: string;
  kind: GKind;
  refId: string;
  label: string;
  color: string;
  r: number;
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface GEdge {
  a: number;
  b: number;
  kind: EKind;
}

export interface GraphFilters {
  showMentions: boolean;
  showOrphans: boolean;
  tag: string;
}

export interface BuiltGraph {
  nodes: GNode[];
  edges: GEdge[];
  neighbors: Map<number, Set<number>>;
}

function flowDegree(cardId: string, project: Project): number {
  let n = 0;
  for (const cn of project.connections) {
    if (cn.source === cardId || cn.target === cardId) n++;
  }
  return n;
}

function scatter(R: number): { x: number; y: number } {
  const a = Math.random() * Math.PI * 2;
  const rr = R * Math.sqrt(Math.random());
  return { x: Math.cos(a) * rr, y: Math.sin(a) * rr };
}

export function buildGraph(project: Project, f: GraphFilters): BuiltGraph {
  const live = project.cards.filter((c) => !c.deletedAt);
  const keep = new Set<string>();
  for (const c of live) {
    if (f.tag !== 'all' && (c.type === 'start' || !cardTags(c.tags).includes(f.tag))) continue;
    keep.add(c.id);
  }

  const nodes: GNode[] = [];
  const index = new Map<string, number>();

  for (const c of live) {
    if (!keep.has(c.id)) continue;
    const deg = flowDegree(c.id, project);
    const mentions = f.showMentions ? findMentions(cardText(c), project.codex).length : 0;
    const total = deg + mentions;
    const p = scatter(320);
    index.set(`c:${c.id}`, nodes.length);
    nodes.push({
      id: `c:${c.id}`,
      kind: 'card',
      refId: c.id,
      label: c.type === 'start' ? 'Start' : cardLabel(c),
      color: c.color,
      r: c.type === 'start' ? 12 : Math.min(8 + total * 2.2, 22),
      degree: total,
      x: p.x,
      y: p.y,
      vx: 0,
      vy: 0,
    });
  }

  const codexUsed = new Map<string, number>();
  if (f.showMentions) {
    for (const c of live) {
      if (!keep.has(c.id)) continue;
      for (const mid of findMentions(cardText(c), project.codex)) {
        codexUsed.set(mid, (codexUsed.get(mid) ?? 0) + 1);
      }
    }
  }
  for (const e of project.codex) {
    const count = codexUsed.get(e.id) ?? 0;
    if (count === 0) continue;
    const p = scatter(320);
    index.set(`x:${e.id}`, nodes.length);
    nodes.push({
      id: `x:${e.id}`,
      kind: 'codex',
      refId: e.id,
      label: e.name,
      color: e.color,
      r: Math.min(7 + count * 1.6, 16),
      degree: count,
      x: p.x,
      y: p.y,
      vx: 0,
      vy: 0,
    });
  }

  let edges: GEdge[] = [];
  for (const cn of project.connections) {
    const ai = index.get(`c:${cn.source}`);
    const bi = index.get(`c:${cn.target}`);
    if (ai === undefined || bi === undefined) continue;
    edges.push({ a: ai, b: bi, kind: 'flow' });
  }
  if (f.showMentions) {
    for (const c of live) {
      if (!keep.has(c.id)) continue;
      const ai = index.get(`c:${c.id}`);
      if (ai === undefined) continue;
      for (const mid of findMentions(cardText(c), project.codex)) {
        const bi = index.get(`x:${mid}`);
        if (bi === undefined || bi === ai) continue;
        edges.push({ a: ai, b: bi, kind: 'mention' });
      }
    }
  }

  if (!f.showOrphans) {
    const touched = new Set<number>();
    for (const e of edges) {
      touched.add(e.a);
      touched.add(e.b);
    }
    const remap = new Map<number, number>();
    const kept: GNode[] = [];
    nodes.forEach((n, i) => {
      if (touched.has(i)) {
        remap.set(i, kept.length);
        kept.push(n);
      }
    });
    edges = edges.map((e) => ({ ...e, a: remap.get(e.a)!, b: remap.get(e.b)! }));
    nodes.length = 0;
    nodes.push(...kept);
  }

  const neighbors = new Map<number, Set<number>>();
  nodes.forEach((_, i) => neighbors.set(i, new Set()));
  for (const e of edges) {
    neighbors.get(e.a)!.add(e.b);
    neighbors.get(e.b)!.add(e.a);
  }

  return { nodes, edges, neighbors };
}

/** Vecindario a N saltos desde un nodo (grafo local estilo Obsidian). */
export function neighborhood(g: BuiltGraph, startIdx: number, depth: number): Set<number> {
  const seen = new Set<number>([startIdx]);
  let frontier = [startIdx];
  for (let d = 0; d < depth; d++) {
    const next: number[] = [];
    for (const i of frontier) {
      for (const nb of g.neighbors.get(i) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return seen;
}

export interface ForceParams {
  center: number;
  repel: number;
  linkForce: number;
  linkDist: number;
}

export const DEFAULT_FORCES: ForceParams = {
  center: 0.008,
  repel: 1500,
  linkForce: 0.015,
  linkDist: 140,
};

/** Un paso de simulación force-directed (los nodos se mutan in situ). */
export function stepSim(nodes: GNode[], edges: GEdge[], p: ForceParams, skipIdx: number = -1): void {
  const n = nodes.length;
  const fx = new Array<number>(n).fill(0);
  const fy = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        dx = (Math.random() - 0.5) * 2;
        dy = (Math.random() - 0.5) * 2;
        d2 = 1;
      }
      const d = Math.sqrt(d2);
      const f = Math.min(p.repel / d2, 2);
      const ux = dx / d;
      const uy = dy / d;
      fx[i] += ux * f;
      fy[i] += uy * f;
      fx[j] -= ux * f;
      fy[j] -= uy * f;
    }
  }

  for (const e of edges) {
    const a = nodes[e.a];
    const b = nodes[e.b];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const f = (d - p.linkDist) * p.linkForce;
    const ux = dx / d;
    const uy = dy / d;
    fx[e.a] += ux * f;
    fy[e.a] += uy * f;
    fx[e.b] -= ux * f;
    fy[e.b] -= uy * f;
  }

  for (let i = 0; i < n; i++) {
    if (i === skipIdx) continue;
    const nd = nodes[i];
    nd.vx = (nd.vx + fx[i] - nd.x * p.center) * 0.85;
    nd.vy = (nd.vy + fy[i] - nd.y * p.center) * 0.85;
    const sp = Math.hypot(nd.vx, nd.vy);
    if (sp > 8) {
      nd.vx = (nd.vx / sp) * 8;
      nd.vy = (nd.vy / sp) * 8;
    }
    nd.x += nd.vx;
    nd.y += nd.vy;
  }
}
