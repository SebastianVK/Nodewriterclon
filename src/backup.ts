import JSZip from 'jszip';
import type {
  Card,
  CodexEntry,
  CodexType,
  Connection,
  Group,
  Project,
  Revision,
} from './types';
import { nowIso, uid } from './types';

export const BACKUP_FORMAT = 'storygraph-backup';
export const BACKUP_VERSION = 1;

export interface BackupCounts {
  cards: number;
  connections: number;
  groups: number;
  codex: number;
  revisions: number;
}

export interface ParsedBackup {
  kind: 'storygraph' | 'nodewriter';
  name: string;
  counts: BackupCounts;
  /** Proyecto normalizado (con ids originales; se remapean al importar). */
  project: Project;
}

/* ---------- helpers defensivos ---------- */

function str(v: unknown, fb = ''): string {
  return typeof v === 'string' ? v : fb;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function num(v: unknown, fb = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fb;
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).map((s) => s.trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

const CODEX_TYPES: CodexType[] = ['character', 'location', 'item', 'lore', 'other'];

function asCodexType(v: unknown): CodexType {
  return CODEX_TYPES.includes(v as CodexType) ? (v as CodexType) : 'other';
}

function countsOf(p: Project): BackupCounts {
  return {
    cards: p.cards.length,
    connections: p.connections.length,
    groups: p.groups.length,
    codex: p.codex.length,
    revisions: p.revisions.length,
  };
}

/* ---------- normalización: formato propio ---------- */

function normalizeStorygraph(o: Record<string, unknown>): Project {
  const t = nowIso();
  const cards: Card[] = (Array.isArray(o.cards) ? o.cards : []).map((r) => {
    const c = (r ?? {}) as Record<string, unknown>;
    const type = c.type === 'start' ? 'start' : 'normal';
    return {
      id: str(c.id, uid()),
      title: str(c.title),
      summary: str(c.summary),
      content: str(c.content),
      color: str(c.color, '#64748B'),
      icon: strOrNull(c.icon),
      tags: toStringArray(c.tags),
      x: num(c.x),
      y: num(c.y),
      type,
      groupId: c.groupId == null ? null : String(c.groupId),
      deletedAt: strOrNull(c.deletedAt),
    } as Card;
  });
  const connections: Connection[] = (Array.isArray(o.connections) ? o.connections : []).map((r) => {
    const c = (r ?? {}) as Record<string, unknown>;
    return { id: str(c.id, uid()), source: String(c.source ?? ''), target: String(c.target ?? '') };
  });
  const groups: Group[] = (Array.isArray(o.groups) ? o.groups : []).map((r) => {
    const g = (r ?? {}) as Record<string, unknown>;
    return {
      id: str(g.id, uid()),
      name: str(g.name, 'Grupo'),
      color: str(g.color, '#64748B'),
      x: num(g.x),
      y: num(g.y),
      width: num(g.width, 320),
      height: num(g.height, 240),
      locked: g.locked === true,
    };
  });
  const codex: CodexEntry[] = (Array.isArray(o.codex) ? o.codex : []).map((r) => {
    const e = (r ?? {}) as Record<string, unknown>;
    return {
      id: str(e.id, uid()),
      type: asCodexType(e.type),
      name: str(e.name, 'Sin nombre'),
      aliases: toStringArray(e.aliases),
      color: str(e.color, '#64748B'),
      icon: strOrNull(e.icon),
      notes: str(e.notes),
    };
  });
  const revisions: Revision[] = (Array.isArray(o.revisions) ? o.revisions : []).map((r) => {
    const v = (r ?? {}) as Record<string, unknown>;
    return {
      id: str(v.id, uid()),
      cardId: String(v.cardId ?? ''),
      summary: str(v.summary),
      content: str(v.content),
      createdAt: str(v.createdAt, t),
    };
  });
  return {
    id: str(o.id, uid()),
    name: str(o.name, 'Proyecto importado'),
    icon: strOrNull(o.icon),
    cards,
    connections,
    groups,
    codex,
    revisions,
    createdAt: str(o.createdAt, t),
    updatedAt: str(o.updatedAt, t),
  };
}

/* ---------- normalización: NodeWriter (get.php + codex/list.php) ---------- */

function normalizeNodeWriter(
  nw: Record<string, unknown>,
  extraCodex: unknown,
): Project {
  const t = nowIso();
  const cards: Card[] = (Array.isArray(nw.cards) ? nw.cards : []).map((r) => {
    const c = (r ?? {}) as Record<string, unknown>;
    return {
      id: String(c.id ?? uid()),
      title: str(c.title),
      summary: str(c.summary),
      content: str(c.content),
      color: str(c.color_hex, '#64748B'),
      icon: strOrNull(c.icon_name),
      tags: toStringArray(c.tags),
      x: num(c.position_x),
      y: num(c.position_y),
      type: c.card_type === 'start' ? 'start' : 'normal',
      groupId: c.group_id == null ? null : String(c.group_id),
      deletedAt: strOrNull(c.deleted_at),
    } as Card;
  });
  const connections: Connection[] = (Array.isArray(nw.connections) ? nw.connections : []).map((r) => {
    const c = (r ?? {}) as Record<string, unknown>;
    return {
      id: String(c.id ?? uid()),
      source: String(c.source_card_id ?? c.source ?? ''),
      target: String(c.target_card_id ?? c.target ?? ''),
    };
  });
  const groups: Group[] = (Array.isArray(nw.groups) ? nw.groups : []).map((r) => {
    const g = (r ?? {}) as Record<string, unknown>;
    return {
      id: String(g.id ?? uid()),
      name: str(g.name, 'Grupo'),
      color: str(g.color_hex, '#64748B'),
      x: num(g.position_x),
      y: num(g.position_y),
      width: num(g.width, 320),
      height: num(g.height, 240),
      locked: g.locked === true || g.locked === 1,
    };
  });
  const rawCodex = Array.isArray(extraCodex) ? extraCodex : [];
  const codex: CodexEntry[] = rawCodex.map((r) => {
    const e = (r ?? {}) as Record<string, unknown>;
    return {
      id: String(e.id ?? uid()),
      type: asCodexType(e.entry_type ?? e.type),
      name: str(e.name, 'Sin nombre'),
      aliases: toStringArray(e.aliases),
      color: str(e.color_hex ?? e.color, '#64748B'),
      icon: strOrNull(e.icon_name ?? e.icon),
      notes: str(e.description ?? e.notes),
    };
  });
  return {
    id: uid(),
    name: str(nw.name, 'Proyecto importado'),
    icon: strOrNull(nw.icon_name ?? nw.icon),
    cards,
    connections,
    groups,
    codex,
    revisions: [],
    createdAt: str(nw.created_at, t),
    updatedAt: str(nw.updated_at, t),
  };
}

/* ---------- parse principal ---------- */

export function parseBackupJson(text: string): ParsedBackup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('No es un JSON válido.');
  }
  if (!raw || typeof raw !== 'object') throw new Error('Formato no reconocido.');
  const o = raw as Record<string, unknown>;

  const wrapped = o.project && typeof o.project === 'object'
    ? (o.project as Record<string, unknown>)
    : null;
  // Candidato a proyecto: envuelto (get.php / nuestro backup) o raíz.
  const cand: Record<string, unknown> | null =
    wrapped && Array.isArray(wrapped.cards) ? wrapped
    : Array.isArray(o.cards) ? o
    : null;
  if (!cand) {
    throw new Error('No reconozco este archivo (falta el array "cards").');
  }
  const cards = cand.cards as Record<string, unknown>[];
  const looksNW =
    'public_id' in cand || (cards.length > 0 && 'position_x' in (cards[0] ?? {}));
  if (looksNW) {
    const extra = Array.isArray(o.codex) ? o.codex : Array.isArray(o.entries) ? o.entries : [];
    const project = normalizeNodeWriter(cand, extra);
    return { kind: 'nodewriter', name: project.name, counts: countsOf(project), project };
  }
  const project = normalizeStorygraph(cand);
  return { kind: 'storygraph', name: project.name, counts: countsOf(project), project };
}

/* ---------- remapeo de ids al importar ---------- */

export function remapProject(p: Project): Project {
  const cardMap = new Map(p.cards.map((c) => [c.id, uid()]));
  const groupMap = new Map(p.groups.map((g) => [g.id, uid()]));
  const codexMap = new Map(p.codex.map((e) => [e.id, uid()]));
  const t = nowIso();
  return {
    ...p,
    id: uid(),
    createdAt: t,
    updatedAt: t,
    cards: p.cards.map((c) => ({
      ...c,
      id: cardMap.get(c.id)!,
      tags: [...c.tags],
      groupId: c.groupId ? (groupMap.get(c.groupId) ?? null) : null,
    })),
    connections: p.connections
      .filter((cn) => cardMap.has(cn.source) && cardMap.has(cn.target))
      .map((cn) => ({
        id: uid(),
        source: cardMap.get(cn.source)!,
        target: cardMap.get(cn.target)!,
      })),
    groups: p.groups.map((g) => ({ ...g, id: groupMap.get(g.id)! })),
    codex: p.codex.map((e) => ({ ...e, id: codexMap.get(e.id)!, aliases: [...e.aliases] })),
    revisions: p.revisions
      .filter((r) => cardMap.has(r.cardId))
      .map((r) => ({ ...r, id: uid(), cardId: cardMap.get(r.cardId)! })),
  };
}

export function exportBackup(project: Project): string {
  return JSON.stringify(
    {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: nowIso(),
      app: 'storygraph',
      project,
    },
    null,
    2,
  );
}

/* ---------- backup ZIP (project.json + imágenes) ---------- */

export interface BackupImage {
  id: string;
  blob: Blob;
  mime: string;
  ext: string;
  name: string;
  w: number;
  h: number;
}

export interface BackupWithImages {
  parsed: ParsedBackup;
  images: BackupImage[];
}

export async function exportBackupZip(project: Project, images: BackupImage[]): Promise<Blob> {
  const zip = new JSZip();
  zip.file(
    'project.json',
    JSON.stringify(
      { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: nowIso(), app: 'storygraph', project },
      null,
      2,
    ),
  );
  zip.file(
    'images.json',
    JSON.stringify(
      images.map(({ id, mime, ext, name, w, h }) => ({ id, mime, ext, name, w, h })),
      null,
      2,
    ),
  );
  for (const i of images) {
    const bytes = new Uint8Array(await i.blob.arrayBuffer());
    zip.file(`images/${i.id}.${i.ext}`, bytes);
  }
  return zip.generateAsync({ type: 'blob' });
}

export async function parseBackupZip(buf: ArrayBuffer): Promise<BackupWithImages> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new Error('El ZIP no se pudo abrir (¿está corrupto?).');
  }
  const pj = zip.file('project.json');
  if (!pj) throw new Error('El ZIP no contiene project.json.');
  const parsed = parseBackupJson(await pj.async('string'));

  const metaFile = zip.file('images.json');
  const metaArr: { id: string; mime?: string; ext?: string; name?: string; w?: number; h?: number }[] = metaFile
    ? JSON.parse(await metaFile.async('string'))
    : [];
  const metaById = new Map(metaArr.map((m) => [m.id, m]));
  const images: BackupImage[] = [];
  for (const path of Object.keys(zip.files)) {
    if (!path.startsWith('images/') || zip.files[path].dir) continue;
    const fname = path.slice('images/'.length);
    const id = fname.replace(/\.[^.]+$/, '');
    const bytes = await zip.files[path].async('uint8array');
    const m = metaById.get(id);
    const mime = m?.mime ?? 'image/png';
    const ext = m?.ext ?? (fname.includes('.') ? (fname.split('.').pop() as string) : 'png');
    images.push({
      id,
      blob: new Blob([new Uint8Array(bytes)], { type: mime }),
      mime,
      ext,
      name: m?.name ?? fname,
      w: m?.w ?? 0,
      h: m?.h ?? 0,
    });
  }
  return { parsed, images };
}

/** Detecta ZIP por la cabecera mágica y parsea ZIP o JSON. */
export async function parseBackupFile(file: File): Promise<BackupWithImages> {
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 2));
  if (head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b) return parseBackupZip(buf);
  return { parsed: parseBackupJson(new TextDecoder().decode(buf)), images: [] };
}
