import { memo } from 'react';
import {
  BaseEdge,
  BezierEdge,
  useInternalNode,
  type ConnectionLineComponentProps,
  type EdgeProps,
  type InternalNode,
} from '@xyflow/react';
import { useStore } from './store';
import type { Card } from './types';

/* Dibujo de aristas del tablero.
   - Anclado: bezier original de React Flow, sale y entra por los handles guardados.
   - Prototipo: el punto de salida se calcula en el borde del nodo que mira al
     centro del otro nodo, con curva Q y una deriva perpendicular del 12 %. */

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const CARD_FALLBACK = { w: 220, h: 120 };
const START_FALLBACK = { w: 96, h: 40 };

function isStart(node: InternalNode): boolean {
  return (node.data as { card?: Card } | undefined)?.card?.type === 'start';
}

function boxOf(node: InternalNode): Box {
  const start = isStart(node);
  const fallback = start ? START_FALLBACK : CARD_FALLBACK;
  const { x, y } = node.internals.positionAbsolute;
  return {
    x,
    y,
    w: node.measured.width ?? node.width ?? fallback.w,
    h: node.measured.height ?? node.height ?? fallback.h,
  };
}

function centerOf(b: Box): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/* Intersección del rayo centro→destino con el rectángulo del bounding box. */
function rectAnchor(
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  tx: number,
  ty: number,
): { x: number; y: number } {
  const dx = tx - cx;
  const dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const s = Math.min(
    dx ? halfW / Math.abs(dx) : Infinity,
    dy ? halfH / Math.abs(dy) : Infinity,
  );
  return { x: cx + dx * s, y: cy + dy * s };
}

/* Intersección del rayo centro→destino con una cápsula real:
   segmento horizontal de media longitud a = w/2 - r, radio r = h/2. */
function capsuleAnchor(
  cx: number,
  cy: number,
  w: number,
  h: number,
  tx: number,
  ty: number,
): { x: number; y: number } {
  const dx = tx - cx;
  const dy = ty - cy;
  const len = Math.hypot(dx, dy);
  if (!len) return { x: cx, y: cy };
  const ux = dx / len;
  const uy = dy / len;
  const r = h / 2;
  const a = Math.max(0, w / 2 - r);

  let t: number;
  if (Math.abs(ux) * r <= Math.abs(uy) * a) {
    // Zona vertical: el rayo corta el semicírculo superior/inferior.
    t = Math.abs(uy) > 0 ? r / Math.abs(uy) : r;
  } else {
    // Zona lateral: corta el semicírculo del extremo.
    const q = r * r - a * a * uy * uy;
    t = a * Math.abs(ux) + Math.sqrt(Math.max(0, q));
  }
  return { x: cx + ux * t, y: cy + uy * t };
}

function anchorOf(
  node: InternalNode,
  tx: number,
  ty: number,
): { x: number; y: number } {
  const b = boxOf(node);
  const c = centerOf(b);
  if (isStart(node)) return capsuleAnchor(c.x, c.y, b.w, b.h, tx, ty);
  return rectAnchor(c.x, c.y, b.w / 2, b.h / 2, tx, ty);
}

/* Curva Q del prototipo con deriva perpendicular del 12 %. */
function threadPath(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
): string {
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  const nx = -(p2.y - p1.y) * 0.12;
  const ny = (p2.x - p1.x) * 0.12;
  return `M ${p1.x} ${p1.y} Q ${mx + nx} ${my + ny} ${p2.x} ${p2.y}`;
}

function PrototypeEdge(props: EdgeProps) {
  const sourceNode = useInternalNode(props.source);
  const targetNode = useInternalNode(props.target);

  if (!sourceNode || !targetNode) return <BezierEdge {...props} />;

  const sc = centerOf(boxOf(sourceNode));
  const tc = centerOf(boxOf(targetNode));
  const p1 = anchorOf(sourceNode, tc.x, tc.y);
  const p2 = anchorOf(targetNode, sc.x, sc.y);

  return (
    <BaseEdge
      id={props.id}
      path={threadPath(p1, p2)}
      markerEnd={props.markerEnd}
      markerStart={props.markerStart}
      style={props.style}
      interactionWidth={props.interactionWidth}
    />
  );
}

export function PrototypeConnectionLine({
  fromNode,
  fromX,
  fromY,
  toX,
  toY,
}: ConnectionLineComponentProps) {
  // `toX`/`toY` vienen en coordenadas del lienzo (como las aristas); `pointer`
  // viene en coordenadas de pantalla y provocaba que la punta se alejara del cursor.
  const end = { x: toX, y: toY };
  const start = fromNode ? anchorOf(fromNode, end.x, end.y) : { x: fromX, y: fromY };
  return (
    <path
      className="react-flow__connection-path"
      d={threadPath(start, end)}
      fill="none"
    />
  );
}

function ThreadEdge(props: EdgeProps) {
  const linkStyle = useStore((s) => s.linkStyle);
  return linkStyle === 'prototipo' ? <PrototypeEdge {...props} /> : <BezierEdge {...props} />;
}

export default memo(ThreadEdge);
