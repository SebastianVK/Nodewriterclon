import { useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { currentProject, useStore } from './store';
import { cardTags } from './types';
import {
  DEFAULT_FORCES,
  buildGraph,
  neighborhood,
  stepSim,
  type BuiltGraph,
  type ForceParams,
  type GNode,
} from './graph';

interface View {
  x: number;
  y: number;
  k: number;
}

export default function GraphView({
  onClose,
  onJumpCard,
  onOpenCodex,
  onConnectCards,
}: {
  onClose: () => void;
  onJumpCard: (cardId: string) => void;
  onOpenCodex: (entryId: string) => void;
  onConnectCards: (a: string, b: string) => 'ok' | 'dup' | 'loop' | 'self';
}) {
  const project = useStore((s) => currentProject(s));
  const theme = useStore((s) => s.theme);

  const [mode, setMode] = useState<'global' | 'local'>('global');
  const [focusSel, setFocusSel] = useState('');
  const [depth, setDepth] = useState(2);
  const [showMentions, setShowMentions] = useState(true);
  const [showOrphans, setShowOrphans] = useState(true);
  const [tag, setTag] = useState('all');
  const [forces, setForces] = useState<ForceParams>(DEFAULT_FORCES);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<GNode[]>([]);
  const graphRef = useRef<BuiltGraph | null>(null);
  const viewRef = useRef<View>({ x: 0, y: 0, k: 1 });
  const dragRef = useRef({ idx: -1, panning: false, moved: 0, lx: 0, ly: 0 });
  const connRef = useRef<{ from: number; mx: number; my: number } | null>(null);
  const noticeTimer = useRef(0);
  const [notice, setNotice] = useState('');
  const hoverRef = useRef(-1);
  const forcesRef = useRef(forces);
  const colorsRef = useRef({ ink: '#ccc', faint: '#888', edge: '#555', accent: '#4f8cff' });
  const cbRef = useRef({ onJumpCard, onOpenCodex, onConnectCards });
  cbRef.current = { onJumpCard, onOpenCodex, onConnectCards };
  forcesRef.current = forces;

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const c of project?.cards ?? []) {
      if (c.deletedAt) continue;
      for (const t of cardTags(c.tags)) set.add(t);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [project]);

  const graph = useMemo(
    () => (project ? buildGraph(project, { showMentions, showOrphans, tag }) : null),
    [project, showMentions, showOrphans, tag],
  );
  graphRef.current = graph;

  const defaultFocus = graph?.nodes.find((n) => n.kind === 'card')?.id ?? '';
  const focusId = focusSel || defaultFocus;

  const focusOptions = useMemo(() => {
    if (!project) return [];
    const cards = project.cards
      .filter((c) => !c.deletedAt)
      .map((c) => ({ id: `c:${c.id}`, label: c.type === 'start' ? 'Start' : c.title || 'Sin título' }));
    const codex = project.codex.map((e) => ({ id: `x:${e.id}`, label: `◈ ${e.name}` }));
    return [...cards, ...codex];
  }, [project]);

  const stats = useMemo(() => {
    if (!graph) return { n: 0, e: 0, vn: 0 };
    let vn = graph.nodes.length;
    if (mode === 'local') {
      const fi = graph.nodes.findIndex((n) => n.id === focusId);
      if (fi >= 0) vn = neighborhood(graph, fi, depth).size;
    }
    return { n: graph.nodes.length, e: graph.edges.length, vn };
  }, [graph, mode, focusId, depth]);

  // Reconstruye la simulación preservando posiciones de nodos ya vistos.
  useEffect(() => {
    const prev = new Map(simRef.current.map((n) => [n.id, n]));
    simRef.current = (graph?.nodes ?? []).map((n) => {
      const old = prev.get(n.id);
      return old ? { ...n, x: old.x, y: old.y, vx: 0, vy: 0 } : { ...n };
    });
    hoverRef.current = -1;
  }, [graph]);

  // Colores de texto según tema.
  useEffect(() => {
    const cs = getComputedStyle(document.documentElement);
    colorsRef.current = {
      ink: cs.getPropertyValue('--ink').trim() || '#ccc',
      faint: cs.getPropertyValue('--ink-faint').trim() || '#888',
      edge: theme === 'dark' ? '#4a4a52' : '#b1b1b7',
      accent: cs.getPropertyValue('--accent').trim() || '#4f8cff',
    };
  }, [theme]);

  // Bucle principal: física + dibujo.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let centered = false;

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(r.width * dpr));
      canvas.height = Math.max(1, Math.floor(r.height * dpr));
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      if (!centered) {
        viewRef.current.x = r.width / 2;
        viewRef.current.y = r.height / 2;
        centered = true;
      }
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    const toWorld = (px: number, py: number) => {
      const v = viewRef.current;
      return { x: (px - v.x) / v.k, y: (py - v.y) / v.k };
    };
    const hitNode = (px: number, py: number): number => {
      const w = toWorld(px, py);
      const nodes = simRef.current;
      const v = viewRef.current;
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        const dx = (n.x - w.x) * v.k;
        const dy = (n.y - w.y) * v.k;
        if (Math.hypot(dx, dy) < n.r * v.k + 6) return i;
      }
      return -1;
    };

    const draw = () => {
      const g = graphRef.current;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const W = canvas.width / dpr;
      const H = canvas.height / dpr;
      const v = viewRef.current;
      const col = colorsRef.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (!g) return;
      const nodes = simRef.current;
      if (nodes.length !== g.nodes.length) return;

      // Conjunto visible (modo local = vecindario).
      let visible: Set<number> | null = null;
      const fi = g.nodes.findIndex((n) => n.id === (uiFocus() || ''));
      if (uiMode() === 'local' && fi >= 0) visible = neighborhood(g, fi, uiDepth());
      const isVis = (i: number) => !visible || visible.has(i);
      const hov = hoverRef.current;
      const hovSet = hov >= 0 ? new Set([hov, ...(g.neighbors.get(hov) ?? [])]) : null;

      ctx.save();
      ctx.translate(v.x, v.y);
      ctx.scale(v.k, v.k);
      ctx.lineWidth = 1 / v.k + 0.4;

      for (const e of g.edges) {
        if (!isVis(e.a) || !isVis(e.b)) continue;
        const a = nodes[e.a];
        const b = nodes[e.b];
        const dim = hovSet && !(hovSet.has(e.a) && hovSet.has(e.b));
        if (e.kind === 'flow') {
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 1;
          const ux = dx / d;
          const uy = dy / d;
          const sx = a.x + ux * (a.r + 1);
          const sy = a.y + uy * (a.r + 1);
          const tx = b.x - ux * (b.r + 3);
          const ty = b.y - uy * (b.r + 3);
          ctx.globalAlpha = dim ? 0.08 : 0.85;
          ctx.strokeStyle = col.edge;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(tx, ty);
          ctx.stroke();
          // Flecha de dirección.
          const s = 5 / v.k + 3;
          ctx.globalAlpha = dim ? 0.08 : 0.9;
          ctx.fillStyle = col.edge;
          ctx.beginPath();
          ctx.moveTo(tx + ux * s, ty + uy * s);
          ctx.lineTo(tx - uy * s * 0.55, ty + ux * s * 0.55);
          ctx.lineTo(tx + uy * s * 0.55, ty - ux * s * 0.55);
          ctx.closePath();
          ctx.fill();
        } else {
          ctx.globalAlpha = dim ? 0.06 : 0.4;
          ctx.strokeStyle = col.faint;
          ctx.setLineDash([4 / v.k + 2, 4 / v.k + 2]);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      ctx.globalAlpha = 1;

      const labelAlpha = Math.max(0, Math.min(1, (v.k - 0.35) * 2.2));
      ctx.textAlign = 'center';
      for (let i = 0; i < nodes.length; i++) {
        if (!isVis(i)) continue;
        const n = nodes[i];
        const dim = hovSet && !hovSet.has(i);
        ctx.globalAlpha = dim ? 0.12 : 1;
        if (n.kind === 'card') {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
          ctx.fillStyle = n.color;
          ctx.fill();
          ctx.lineWidth = i === hov ? 2.5 : 1.2;
          ctx.strokeStyle = i === hov ? '#fff' : 'rgba(0,0,0,0.55)';
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.moveTo(n.x, n.y - n.r);
          ctx.lineTo(n.x + n.r, n.y);
          ctx.lineTo(n.x, n.y + n.r);
          ctx.lineTo(n.x - n.r, n.y);
          ctx.closePath();
          ctx.fillStyle = n.color;
          ctx.fill();
          ctx.lineWidth = i === hov ? 2.5 : 1.2;
          ctx.strokeStyle = i === hov ? '#fff' : 'rgba(0,0,0,0.55)';
          ctx.stroke();
        }
        if (labelAlpha > 0.05) {
          ctx.globalAlpha = (dim ? 0.12 : 1) * Math.min(1, labelAlpha + 0.25);
          ctx.font = `${i === hov ? '600 ' : ''}11px system-ui, sans-serif`;
          ctx.fillStyle = col.ink;
          ctx.fillText(n.label, n.x, n.y - n.r - 5);
        }
      }
      const cc = connRef.current;
      const from = cc ? nodes[cc.from] : undefined;
      if (cc && from) {
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = col.accent;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(cc.mx, cc.my);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;
      ctx.restore();
    };

    const uiMode = () => uiRef.current.mode;
    const uiDepth = () => uiRef.current.depth;
    const uiFocus = () => uiRef.current.focusId;

    const loop = () => {
      const g = graphRef.current;
      if (g && simRef.current.length === g.nodes.length) {
        stepSim(simRef.current, g.edges, forcesRef.current, dragRef.current.idx);
      }
      draw();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const v = viewRef.current;
      const k2 = Math.max(0.2, Math.min(3, v.k * Math.pow(1.0015, -e.deltaY)));
      v.x = px - ((px - v.x) / v.k) * k2;
      v.y = py - ((py - v.y) / v.k) * k2;
      v.k = k2;
    };
    const flash = (msg: string) => {
      setNotice(msg);
      window.clearTimeout(noticeTimer.current);
      noticeTimer.current = window.setTimeout(() => setNotice(''), 2600);
    };

    const finishConnect = (fromIdx: number, toIdx: number) => {
      const nodes = simRef.current;
      if (toIdx < 0 || toIdx === fromIdx) return;
      const a = nodes[fromIdx];
      const b = nodes[toIdx];
      if (!a || !b) return;
      if (a.kind !== 'card' || b.kind !== 'card') {
        flash('Solo se pueden conectar tarjetas');
        return;
      }
      const res = cbRef.current.onConnectCards(a.refId, b.refId);
      flash(
        res === 'ok'
          ? `Conectado: ${a.label} → ${b.label}`
          : res === 'dup'
            ? 'Ya existe esa conexión'
            : res === 'loop'
              ? 'Esa conexión crearía un ciclo'
              : 'Conexión no válida',
      );
    };

    const onDown = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const idx = hitNode(px, py);
      if (e.shiftKey && idx >= 0) {
        const w = toWorld(px, py);
        connRef.current = { from: idx, mx: w.x, my: w.y };
        dragRef.current = { idx: -1, panning: false, moved: 0, lx: px, ly: py };
        canvas.style.cursor = 'crosshair';
        return;
      }
      dragRef.current = { idx, panning: idx < 0, moved: 0, lx: px, ly: py };
      canvas.style.cursor = idx >= 0 ? 'grabbing' : 'move';
    };
    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const cc = connRef.current;
      if (cc) {
        const w = toWorld(px, py);
        cc.mx = w.x;
        cc.my = w.y;
      }
      const dr = dragRef.current;
      if (dr.idx >= 0 || dr.panning) {
        const dx = px - dr.lx;
        const dy = py - dr.ly;
        dr.moved += Math.abs(dx) + Math.abs(dy);
        if (dr.idx >= 0) {
          const n = simRef.current[dr.idx];
          if (n) {
            n.x += dx / viewRef.current.k;
            n.y += dy / viewRef.current.k;
            n.vx = 0;
            n.vy = 0;
          }
        } else {
          viewRef.current.x += dx;
          viewRef.current.y += dy;
        }
        dr.lx = px;
        dr.ly = py;
      } else {
        const h = hitNode(px, py);
        hoverRef.current = h;
        canvas.style.cursor = h >= 0 ? 'pointer' : 'default';
      }
    };
    const onUp = (e: MouseEvent) => {
      const cc = connRef.current;
      if (cc) {
        connRef.current = null;
        const rect = canvas.getBoundingClientRect();
        finishConnect(cc.from, hitNode(e.clientX - rect.left, e.clientY - rect.top));
        canvas.style.cursor = 'default';
        return;
      }
      const dr = dragRef.current;
      if (dr.moved < 4 && dr.idx >= 0) {
        const n = simRef.current[dr.idx];
        if (n) {
          if (n.kind === 'card') cbRef.current.onJumpCard(n.refId);
          else cbRef.current.onOpenCodex(n.refId);
        }
      }
      dragRef.current = { idx: -1, panning: false, moved: 0, lx: 0, ly: 0 };
      canvas.style.cursor = 'default';
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(noticeTimer.current);
      ro.disconnect();
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const uiRef = useRef({ mode, focusId, depth });
  uiRef.current = { mode, focusId, depth };

  if (!project || !graph) return null;

  const setF = (patch: Partial<typeof forces>) => setForces((f) => ({ ...f, ...patch }));

  return (
    <div className="graph-overlay">
      <div className="graph-canvas-wrap" ref={wrapRef}>
        <canvas ref={canvasRef} className="graph-canvas" />
      </div>
      <div className="graph-topbar">
        <strong>Vista Grafo</strong>
        <span className="muted">
          {stats.vn} nodos · {stats.e} aristas
        </span>
        <span className="spacer" />
        <button className="btn btn-icon" onClick={onClose} title="Cerrar">
          <X size={18} />
        </button>
      </div>
      <div className="graph-panel">
        <div className="graph-seg">
          <button className={mode === 'global' ? 'active' : ''} onClick={() => setMode('global')}>
            Global
          </button>
          <button className={mode === 'local' ? 'active' : ''} onClick={() => setMode('local')}>
            Local
          </button>
        </div>
        {mode === 'local' && (
          <>
            <label className="field-label">Nodo foco</label>
            <select className="input" value={focusId} onChange={(e) => setFocusSel(e.target.value)}>
              {focusOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <label className="field-label">Profundidad: {depth}</label>
            <input
              type="range"
              min={1}
              max={3}
              step={1}
              value={depth}
              onChange={(e) => setDepth(Number(e.target.value))}
              className="graph-range"
            />
          </>
        )}
        <label className="field-label">Filtros</label>
        <select className="input" value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="all">Todas las etiquetas</option>
          {allTags.map((t) => (
            <option key={t} value={t}>
              #{t}
            </option>
          ))}
        </select>
        <label className="check-row">
          <input type="checkbox" checked={showMentions} onChange={(e) => setShowMentions(e.target.checked)} />
          Menciones del codex
        </label>
        <label className="check-row">
          <input type="checkbox" checked={showOrphans} onChange={(e) => setShowOrphans(e.target.checked)} />
          Huérfanas (sin aristas)
        </label>
        <label className="field-label">Fuerzas</label>
        <label className="graph-slider">
          Centro
          <input
            type="range" min={0} max={0.05} step={0.001} value={forces.center}
            onChange={(e) => setF({ center: Number(e.target.value) })} className="graph-range"
          />
        </label>
        <label className="graph-slider">
          Repulsión
          <input
            type="range" min={0} max={5000} step={50} value={forces.repel}
            onChange={(e) => setF({ repel: Number(e.target.value) })} className="graph-range"
          />
        </label>
        <label className="graph-slider">
          Tensión
          <input
            type="range" min={0} max={0.05} step={0.001} value={forces.linkForce}
            onChange={(e) => setF({ linkForce: Number(e.target.value) })} className="graph-range"
          />
        </label>
        <label className="graph-slider">
          Distancia
          <input
            type="range" min={40} max={400} step={5} value={forces.linkDist}
            onChange={(e) => setF({ linkDist: Number(e.target.value) })} className="graph-range"
          />
        </label>
        <div className="graph-legend">
          <span><i className="legend-dot" /> tarjeta (tamaño ∝ conexiones)</span>
          <span><i className="legend-diamond" /> codex</span>
          <span><i className="legend-line" /> flujo →</span>
          <span><i className="legend-dash" /> mención</span>
        </div>
      </div>
      <div className="graph-hint muted">
        {notice || 'rueda: zoom · arrastrar: mover · click: abrir · shift+arrastrar: conectar'}
      </div>
    </div>
  );
}
