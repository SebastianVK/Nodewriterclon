export type CardType = 'start' | 'normal';

export interface Card {
  id: string;
  title: string;
  summary: string;
  content: string;
  color: string;
  icon: string | null;
  tags: string[];
  x: number;
  y: number;
  type: CardType;
  groupId: string | null;
  deletedAt: string | null;
}

export interface Connection {
  id: string;
  source: string;
  target: string;
}

export interface Group {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
  locked: boolean;
}

export type CodexType = 'character' | 'location' | 'item' | 'lore' | 'other';

export interface CodexEntry {
  id: string;
  type: CodexType;
  name: string;
  aliases: string[];
  color: string;
  icon?: string | null;
  notes: string;
}

export interface Revision {
  id: string;
  cardId: string;
  summary: string;
  content: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  icon: string | null;
  cards: Card[];
  connections: Connection[];
  groups: Group[];
  codex: CodexEntry[];
  revisions: Revision[];
  createdAt: string;
  updatedAt: string;
}

/* Meta real de NodeWriter (/api/meta.php) */
export const CARD_COLORS = [
  '#2563EB',
  '#DC2626',
  '#16A34A',
  '#CA8A04',
  '#9333EA',
  '#0891B2',
  '#EA580C',
  '#DB2777',
  '#4F46E5',
  '#7C3AED',
  '#0EA5E9',
  '#059669',
  '#EAB308',
  '#F472B6',
  '#14B8A6',
  '#64748B',
];

export const CARD_ICONS: { key: string; label: string }[] = [
  { key: 'lightbulb', label: 'Idea' },
  { key: 'star', label: 'Importante' },
  { key: 'triangle-alert', label: 'Atención' },
  { key: 'circle-help', label: 'Pregunta' },
  { key: 'heart', label: 'Amor' },
  { key: 'flag', label: 'Hito' },
  { key: 'bookmark', label: 'Referencia' },
  { key: 'user', label: 'Personaje' },
  { key: 'map-pin', label: 'Lugar' },
  { key: 'clock', label: 'Cronología' },
  { key: 'pencil', label: 'Borrador' },
  { key: 'check-circle', label: 'Hecho' },
  { key: 'eye', label: 'Revisar' },
  { key: 'zap', label: 'Acción' },
  { key: 'lock', label: 'Bloqueado' },
  { key: 'message-circle', label: 'Diálogo' },
];

export const GROUP_COLORS = [
  '#94A3B8',
  '#F87171',
  '#4ADE80',
  '#FBBF24',
  '#C084FC',
  '#22D3EE',
  '#FB923C',
  '#F472B6',
];

export const CODEX_COLORS = [
  '#2563EB',
  '#4F46E5',
  '#7C3AED',
  '#9333EA',
  '#A855F7',
  '#DC2626',
  '#EA580C',
  '#F97316',
  '#D97706',
  '#EAB308',
  '#16A34A',
  '#059669',
  '#0891B2',
  '#0EA5E9',
  '#DB2777',
  '#64748B',
];

export const CODEX_DEFAULT_COLOR: Record<CodexType, string> = {
  character: '#2563EB',
  location: '#16A34A',
  item: '#D97706',
  lore: '#9333EA',
  other: '#64748B',
};

export const CODEX_DEFAULT_ICON: Record<CodexType, string | null> = {
  character: 'user',
  location: 'map-pin',
  item: 'bookmark',
  lore: 'flag',
  other: null,
};

export const CODEX_TYPES: { key: CodexType; label: string }[] = [
  { key: 'character', label: 'Personaje' },
  { key: 'location', label: 'Lugar' },
  { key: 'item', label: 'Objeto' },
  { key: 'lore', label: 'Trasfondo' },
  { key: 'other', label: 'Otro' },
];

export const TRASH_RETENTION_DAYS = 30;
export const SUMMARY_MAX = 200;

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function wordCount(text: string): number {
  const clean = (text || '').replace(/[#*_`[\]()>-]/g, ' ').trim();
  if (!clean) return 0;
  return clean.split(/\s+/).filter(Boolean).length;
}

export function cardLabel(card: Pick<Card, 'title'>): string {
  return card.title.trim() || 'Nueva tarjeta';
}

export function cardTags(tags: string[] | null | undefined): string[] {
  if (!tags) return [];
  return Array.isArray(tags) ? tags : String(tags).split(',').map((t) => t.trim()).filter(Boolean);
}

/** DFS desde el Start; en bifurcaciones gana la tarjeta más alta (menor y), como NodeWriter. */
export function orderFromStart(cards: Card[], connections: Connection[]): Card[] {
  const live = cards.filter((c) => !c.deletedAt);
  const start = live.find((c) => c.type === 'start');
  if (!start) return [];
  const byId = new Map(live.map((c) => [c.id, c]));
  const adj = new Map<string, Card[]>();
  for (const cn of connections) {
    const target = byId.get(cn.target);
    if (byId.has(cn.source) && target) {
      const list = adj.get(cn.source) ?? [];
      list.push(target);
      adj.set(cn.source, list);
    }
  }
  for (const list of adj.values()) {
    list.sort((a, b) => a.y - b.y || a.x - b.x);
  }
  const visited = new Set<string>();
  const order: Card[] = [];
  const stack: Card[] = [start];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (visited.has(cur.id)) continue;
    visited.add(cur.id);
    order.push(cur);
    const next = adj.get(cur.id) ?? [];
    for (let i = next.length - 1; i >= 0; i--) {
      if (!visited.has(next[i].id)) stack.push(next[i]);
    }
  }
  return order;
}

/** true si conectar source->target crearía un ciclo. */
export function wouldCreateLoop(
  source: string,
  target: string,
  connections: Connection[],
): boolean {
  if (source === target) return true;
  const adj = new Map<string, string[]>();
  for (const cn of connections) {
    const list = adj.get(cn.source) ?? [];
    list.push(cn.target);
    adj.set(cn.source, list);
  }
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === source) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of adj.get(cur) ?? []) stack.push(nxt);
  }
  return false;
}

export function degreeOf(cardId: string, connections: Connection[]): number {
  let n = 0;
  for (const cn of connections) {
    if (cn.source === cardId) n++;
    if (cn.target === cardId) n++;
  }
  return n;
}

function escapeHtml(s: string): string {
  const div = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>;
  return s.replace(/[&<>"]/g, (c) => div[c]);
}

/** Fuentes permitidas en ![](): refs internas img://, http(s) y data de png/jpeg/gif/webp. Bloquea SVG. */
export function safeImgSrc(src: string): string | null {
  const s = (src || '').trim();
  if (/^img:\/\/[A-Za-z0-9_-]+$/.test(s)) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(s)) return s;
  return null;
}

function inlineMd(s: string): string {
  let out = escapeHtml(s);
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*(.+?)\*/g, '<em>$1</em>');
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, src: string) => {
    const safe = safeImgSrc(src);
    return safe ? `<img src="${safe}" alt="${alt}" loading="lazy">` : '';
  });
  out = out.replace(/\[(.+?)\]\((.+?)\)/g, (_m, label: string, href: string) => {
    const h = href.trim();
    if (/^(https?:\/\/|mailto:|#)/i.test(h)) {
      return `<a href="${h}" target="_blank" rel="noopener">${label}</a>`;
    }
    return label;
  });
  return out;
}

/** Mini-render markdown (headings, listas, párrafos) como el original. */
export function markdownToHtml(src: string): string {
  const lines = (src || '').split('\n');
  let html = '';
  let inList = false;
  for (const line of lines) {
    const t = line.trim();
    if (t === '') {
      if (inList) { html += '</ul>'; inList = false; }
      continue;
    }
    const h = t.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`;
      continue;
    }
    const li = t.match(/^[-*+]\s+(.*)$/);
    if (li) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inlineMd(li[1])}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    html += `<p>${inlineMd(t)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

export function relativeTime(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'ahora mismo';
  if (mins < 60) return `hace ${mins} min`;
  const h = Math.round(mins / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  if (d < 30) return `hace ${d} d`;
  return new Date(iso).toLocaleDateString('es-ES');
}
