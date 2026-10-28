import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { remapProject, type BackupImage } from './backup';
import { collectImgIds, importImages, purgeOrphans } from './images';
import type {
  Card,
  CodexEntry,
  CodexType,
  Connection,
  Group,
  Project,
  Revision,
} from './types';
import { nowIso, uid, CODEX_DEFAULT_COLOR, CODEX_DEFAULT_ICON } from './types';

/** Instantánea de estado para deshacer/rehacer (por referencia: barato). */
export interface HistoryEntry {
  projects: Project[];
  currentId: string | null;
}

const HISTORY_LIMIT = 60;
let histDepth = 0;
let histBatchOrigin: HistoryEntry | null = null;
let histBatchPushed = false;

/**
 * Ejecuta varias acciones del store como UN SOLO paso de historial:
 * la primera modificación de `projects` dentro del lote guarda el estado
 * previo completo; las siguientes no generan pasos extra.
 */
export function runHistoryBatch(fn: () => void): void {
  histDepth++;
  if (histDepth === 1 && !histBatchOrigin) {
    const s = useStore.getState();
    histBatchOrigin = { projects: s.projects, currentId: s.currentId };
    histBatchPushed = false;
  }
  try {
    fn();
  } finally {
    histDepth--;
    if (histDepth === 0) {
      histBatchOrigin = null;
      histBatchPushed = false;
    }
  }
}

interface StoryState {
  projects: Project[];
  currentId: string | null;
  theme: 'dark' | 'light';
  style: 'normal' | 'liquid';
  past: HistoryEntry[];
  future: HistoryEntry[];

  createProject: (name?: string) => Project;
  renameProject: (id: string, name: string) => void;
  setProjectIcon: (id: string, icon: string | null) => void;
  deleteProject: (id: string) => void;
  openProject: (id: string | null) => void;
  importProject: (p: Project, images?: BackupImage[]) => void;

  addCard: (x: number, y: number) => Card | null;
  updateCard: (id: string, patch: Partial<Card>) => void;
  duplicateCard: (id: string) => Card | null;
  trashCard: (id: string) => void;
  restoreCard: (id: string) => void;
  deleteCardForever: (id: string) => void;
  emptyTrash: () => void;
  removeFromFlow: (id: string) => void;
  setCardGroup: (id: string, groupId: string | null, x?: number, y?: number) => void;

  addConnection: (source: string, target: string) => Connection | null;
  insertCardInto: (connectionId: string, cardId: string) => void;
  deleteConnection: (id: string) => void;

  addGroup: (x: number, y: number) => Group | null;
  updateGroup: (id: string, patch: Partial<Group>) => void;
  deleteGroup: (id: string, ungroup?: boolean) => void;
  ungroupAll: (groupId: string) => void;

  addCodex: (type?: CodexType) => CodexEntry | null;
  updateCodex: (id: string, patch: Partial<CodexEntry>) => void;
  deleteCodex: (id: string) => void;

  saveRevision: (cardId: string) => void;
  restoreRevision: (cardId: string, revisionId: string) => void;

  toggleTheme: () => void;
  setStyle: (style: 'normal' | 'liquid') => void;

  undo: () => void;
  redo: () => void;
}

function makeStart(x = 40, y = 220): Card {
  return {
    id: uid(),
    title: 'Start',
    summary: '',
    content: '',
    color: '#16A34A',
    icon: null,
    tags: [],
    x,
    y,
    type: 'start',
    groupId: null,
    deletedAt: null,
  };
}

function seedProject(): Project {
  const start = makeStart();
  const a: Card = {
    id: uid(),
    title: 'La llamada',
    summary: 'Mara recibe el mapa de su abuela',
    content: 'Mara encuentra el mapa escondido en el desván del Faro Viejo. El Capitán la espera en el muelle.',
    color: '#2563EB',
    icon: 'lightbulb',
    tags: ['capítulo 1'],
    x: 340,
    y: 120,
    type: 'normal',
    groupId: null,
    deletedAt: null,
  };
  const b: Card = {
    id: uid(),
    title: 'El cruce',
    summary: 'Decide si quemar el mapa o seguirlo',
    content: 'El Eclipse se acerca. Mara debe elegir entre quemar el mapa o seguir la ruta marcada.',
    color: '#DB2777',
    icon: 'triangle-alert',
    tags: ['capítulo 1', 'decisión'],
    x: 340,
    y: 360,
    type: 'normal',
    groupId: null,
    deletedAt: null,
  };
  const t = nowIso();
  return {
    id: uid(),
    name: 'Mi historia',
    icon: null,
    cards: [start, a, b],
    connections: [
      { id: uid(), source: start.id, target: a.id },
      { id: uid(), source: start.id, target: b.id },
    ],
    groups: [],
    codex: [
      { id: uid(), type: 'character', name: 'Mara', aliases: [], color: '#2563EB', notes: 'Protagonista, nieta del Capitán.' },
      { id: uid(), type: 'character', name: 'Capitán', aliases: ['el Capitán'], color: '#EA580C', notes: '' },
      { id: uid(), type: 'location', name: 'Faro Viejo', aliases: [], color: '#CA8A04', notes: '' },
      { id: uid(), type: 'other', name: 'Eclipse', aliases: ['el Eclipse'], color: '#9333EA', notes: '' },
    ],
    revisions: [],
    createdAt: t,
    updatedAt: t,
  };
}

function blankProject(name: string): Project {
  const t = nowIso();
  return {
    id: uid(),
    name,
    icon: null,
    cards: [makeStart()],
    connections: [],
    groups: [],
    codex: [],
    revisions: [],
    createdAt: t,
    updatedAt: t,
  };
}

function withCurrent(
  s: StoryState,
  fn: (p: Project) => Partial<Project>,
): Partial<StoryState> {
  if (!s.currentId) return {};
  const next = s.projects.map((p) =>
    p.id === s.currentId ? { ...p, ...fn(p), updatedAt: nowIso() } : p,
  );
  return { projects: next };
}

export function currentProject(s: StoryState): Project | null {
  return s.projects.find((p) => p.id === s.currentId) ?? null;
}

/** Ids `img://` referenciados por cualquier tarjeta (incluso en la papelera). */
function validImageIds(state: StoryState): Set<string> {
  const ids = new Set<string>();
  const scan = (projects: Project[]) => {
    for (const p of projects) {
      for (const c of p.cards) {
        for (const id of collectImgIds(c.content)) ids.add(id);
      }
    }
  };
  scan(state.projects);
  // El historial puede restaurar tarjetas con imágenes: no purgarlas.
  for (const e of state.past) scan(e.projects);
  for (const e of state.future) scan(e.projects);
  return ids;
}

let purgeTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleImagePurge(): void {
  if (purgeTimer) clearTimeout(purgeTimer);
  purgeTimer = setTimeout(() => {
    void purgeOrphans(validImageIds(useStore.getState())).catch(() => undefined);
  }, 1500);
}

export const useStore = create<StoryState>()(
  persist(
    (rawSet, get) => {
      /* Envuelve `set` para registrar historial de deshacer/rehacer.
         Solo cuenta cambios reales de `projects`; `undo`/`redo` usan
         `rawSet` y por eso no se auto-registran. La rehidratación de
         persist toca el set externo, así que tampoco registra. */
      const set: typeof rawSet = (partial, replace) => {
        const before = get();
        (rawSet as (p: unknown, r?: unknown) => void)(partial, replace);
        const after = get();
        if (before.projects === after.projects) return;
        if (histDepth > 0) {
          if (!histBatchPushed) {
            histBatchPushed = true;
            const origin = histBatchOrigin ?? {
              projects: before.projects,
              currentId: before.currentId,
            };
            rawSet((s) => ({ past: [...s.past, origin].slice(-HISTORY_LIMIT), future: [] }));
          }
          return;
        }
        const origin = { projects: before.projects, currentId: before.currentId };
        rawSet((s) => ({ past: [...s.past, origin].slice(-HISTORY_LIMIT), future: [] }));
      };
      return {
      projects: [],
      currentId: null,
      theme: 'dark',
      style: 'normal',
      past: [],
      future: [],

      createProject: (name = 'Nuevo proyecto') => {
        const p = name.trim() ? blankProject(name.trim()) : blankProject('Nuevo proyecto');
        set((s) => ({ projects: [...s.projects, p], currentId: p.id }));
        return p;
      },

      renameProject: (id, name) =>
        set((s) => ({
          projects: s.projects.map((p) =>
            p.id === id ? { ...p, name: name.trim() || p.name, updatedAt: nowIso() } : p,
          ),
        })),

      setProjectIcon: (id, icon) =>
        set((s) => ({
          projects: s.projects.map((p) => (p.id === id ? { ...p, icon } : p)),
        })),

      deleteProject: (id) => {
        set((s) => ({
          projects: s.projects.filter((p) => p.id !== id),
          currentId: s.currentId === id ? null : s.currentId,
        }));
        scheduleImagePurge();
      },

      openProject: (id) => set({ currentId: id }),

      importProject: (p, images) => {
        const fresh = remapProject(p);
        set((s) => ({ projects: [...s.projects, fresh], currentId: fresh.id }));
        if (images?.length) void importImages(images).catch(() => undefined);
      },

      addCard: (x, y) => {
        const card: Card = {
          id: uid(),
          title: '',
          summary: '',
          content: '',
          color: '#64748B',
          icon: null,
          tags: [],
          x,
          y,
          type: 'normal',
          groupId: null,
          deletedAt: null,
        };
        const hasCurrent = get().currentId;
        if (!hasCurrent) return null;
        set((st) => withCurrent(st, (p) => ({ cards: [...p.cards, card] })));
        return card;
      },

      updateCard: (id, patch) =>
        set((s) => withCurrent(s, (p) => ({ cards: p.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)) }))),

      duplicateCard: (id) => {
        const p = currentProject(get());
        if (!p) return null;
        const src = p.cards.find((c) => c.id === id);
        if (!src || src.type === 'start') return null;
        const copy: Card = {
          ...src,
          id: uid(),
          title: `${src.title} (copia)`,
          x: src.x + 40,
          y: src.y + 40,
          deletedAt: null,
          tags: [...src.tags],
        };
        set((s) => withCurrent(s, (pr) => ({ cards: [...pr.cards, copy] })));
        return copy;
      },

      trashCard: (id) =>
        set((s) =>
          withCurrent(s, (p) => ({
            cards: p.cards.map((c) =>
              c.id === id ? { ...c, deletedAt: nowIso(), groupId: null } : c,
            ),
            connections: p.connections.filter((cn) => cn.source !== id && cn.target !== id),
          })),
        ),

      restoreCard: (id) =>
        set((s) =>
          withCurrent(s, (p) => ({
            cards: p.cards.map((c) => (c.id === id ? { ...c, deletedAt: null } : c)),
          })),
        ),

      deleteCardForever: (id) => {
        set((s) =>
          withCurrent(s, (p) => ({
            cards: p.cards.filter((c) => c.id !== id),
            revisions: p.revisions.filter((r) => r.cardId !== id),
          })),
        );
        scheduleImagePurge();
      },

      emptyTrash: () => {
        set((s) =>
          withCurrent(s, (p) => {
            const trashIds = new Set(p.cards.filter((c) => c.deletedAt).map((c) => c.id));
            return {
              cards: p.cards.filter((c) => !c.deletedAt),
              revisions: p.revisions.filter((r) => !trashIds.has(r.cardId)),
            };
          }),
        );
        scheduleImagePurge();
      },

      removeFromFlow: (id) =>
        set((s) =>
          withCurrent(s, (p) => ({
            connections: p.connections.filter((cn) => cn.source !== id && cn.target !== id),
          })),
        ),

      setCardGroup: (id, groupId, x, y) =>
        set((s) =>
          withCurrent(s, (p) => {
            const card = p.cards.find((c) => c.id === id);
            let nx = x;
            let ny = y;
            // Al desagrupar sin coordenadas, conserva la posición visual
            // (las x/y guardadas eran relativas al grupo).
            if (groupId === null && card?.groupId && nx === undefined) {
              const g = p.groups.find((gr) => gr.id === card.groupId);
              if (g) {
                nx = g.x + card.x;
                ny = g.y + card.y;
              }
            }
            return {
              cards: p.cards.map((c) =>
                c.id === id
                  ? { ...c, groupId, x: nx ?? c.x, y: ny ?? c.y }
                  : c,
              ),
            };
          }),
        ),

      addConnection: (source, target) => {
        let created: Connection | null = null;
        set((s) => {
          const p = s.projects.find((pr) => pr.id === s.currentId);
          if (!p || source === target) return {};
          if (p.connections.some((cn) => cn.source === source && cn.target === target)) return {};
          created = { id: uid(), source, target };
          const cc = created;
          return withCurrent(s, (pr) => ({ connections: [...pr.connections, cc] }));
        });
        return created;
      },

      insertCardInto: (connectionId, cardId) =>
        set((s) =>
          withCurrent(s, (p) => {
            const cn = p.connections.find((c) => c.id === connectionId);
            if (!cn || cn.source === cardId || cn.target === cardId) return {};
            return {
              connections: [
                ...p.connections.filter((c) => c.id !== connectionId),
                { id: uid(), source: cn.source, target: cardId },
                { id: uid(), source: cardId, target: cn.target },
              ],
            };
          }),
        ),

      deleteConnection: (id) =>
        set((s) => withCurrent(s, (p) => ({ connections: p.connections.filter((cn) => cn.id !== id) }))),

      addGroup: (x, y) => {
        const group: Group = {
          id: uid(),
          name: 'Nuevo grupo',
          color: '#64748B',
          x,
          y,
          width: 320,
          height: 240,
          locked: false,
        };
        if (!get().currentId) return null;
        set((s) => withCurrent(s, (p) => ({ groups: [...p.groups, group] })));
        return group;
      },

      updateGroup: (id, patch) =>
        set((s) =>
          withCurrent(s, (p) => ({ groups: p.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)) })),
        ),

      deleteGroup: (id, ungroup = true) =>
        set((s) =>
          withCurrent(s, (p) => ({
            groups: p.groups.filter((g) => g.id !== id),
            cards: ungroup ? p.cards.map((c) => (c.groupId === id ? { ...c, groupId: null } : c)) : p.cards,
          })),
        ),

      ungroupAll: (groupId) =>
        set((s) =>
          withCurrent(s, (p) => ({
            cards: p.cards.map((c) => (c.groupId === groupId ? { ...c, groupId: null } : c)),
          })),
        ),

      addCodex: (type = 'character') => {
        const entry: CodexEntry = {
          id: uid(),
          type,
          name: 'Nueva entrada',
          aliases: [],
          color: CODEX_DEFAULT_COLOR[type],
          icon: CODEX_DEFAULT_ICON[type],
          notes: '',
        };
        if (!get().currentId) return null;
        set((s) => withCurrent(s, (p) => ({ codex: [...p.codex, entry] })));
        return entry;
      },

      updateCodex: (id, patch) =>
        set((s) =>
          withCurrent(s, (p) => ({ codex: p.codex.map((e) => (e.id === id ? { ...e, ...patch } : e)) })),
        ),

      deleteCodex: (id) =>
        set((s) => withCurrent(s, (p) => ({ codex: p.codex.filter((e) => e.id !== id) }))),

      saveRevision: (cardId) =>
        set((s) =>
          withCurrent(s, (p) => {
            const card = p.cards.find((c) => c.id === cardId);
            if (!card) return {};
            const last = p.revisions.filter((r) => r.cardId === cardId)[0];
            if (last && last.content === card.content && last.summary === card.summary) return {};
            const rev: Revision = {
              id: uid(),
              cardId,
              summary: card.summary,
              content: card.content,
              createdAt: nowIso(),
            };
            return { revisions: [rev, ...p.revisions].slice(0, 30) };
          }),
        ),

      restoreRevision: (cardId, revisionId) =>
        set((s) =>
          withCurrent(s, (p) => {
            const rev = p.revisions.find((r) => r.id === revisionId && r.cardId === cardId);
            const card = p.cards.find((c) => c.id === cardId);
            if (!rev || !card) return {};
            const backup: Revision = {
              id: uid(),
              cardId,
              summary: card.summary,
              content: card.content,
              createdAt: nowIso(),
            };
            return {
              cards: p.cards.map((c) =>
                c.id === cardId ? { ...c, summary: rev.summary, content: rev.content } : c,
              ),
              revisions: [backup, ...p.revisions].slice(0, 30),
            };
          }),
        ),

      toggleTheme: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),

      setStyle: (style) => set({ style }),

      undo: () => {
        const s = get();
        const prev = s.past[s.past.length - 1];
        if (!prev) return;
        rawSet({
          past: s.past.slice(0, -1),
          future: [{ projects: s.projects, currentId: s.currentId }, ...s.future].slice(0, HISTORY_LIMIT),
          projects: prev.projects,
          currentId: prev.currentId,
        });
      },

      redo: () => {
        const s = get();
        const nxt = s.future[0];
        if (!nxt) return;
        rawSet({
          past: [...s.past, { projects: s.projects, currentId: s.currentId }].slice(-HISTORY_LIMIT),
          future: s.future.slice(1),
          projects: nxt.projects,
          currentId: nxt.currentId,
        });
      },
      };
    },
    {
      name: 'storygraph-v2',
      version: 2,
      partialize: (s) => ({ projects: s.projects, currentId: s.currentId, theme: s.theme, style: s.style }),
      merge: (persisted, current) => {
        const p = persisted as unknown as Record<string, unknown>;
        if (p && Array.isArray(p.projects)) {
          return { ...current, ...(persisted as object) } as StoryState;
        }
        // Migra formato v1 (proyecto único) al formato multiproyecto.
        if (p && Array.isArray(p.cards)) {
          const t = nowIso();
          const oldCards = (p.cards as Card[]).map((c) => ({
            ...c,
            icon: (c as Partial<Card>).icon ?? null,
            groupId: (c as Partial<Card>).groupId ?? null,
            deletedAt: (c as Partial<Card>).deletedAt ?? null,
          }));
          const oldCodex = ((p.codex as CodexEntry[]) ?? []).map((e) => ({
            ...e,
            type: ((e.type as string) === 'event' ? 'other' : e.type) as CodexEntry['type'],
          }));
          const migrated: Project = {
            id: uid(),
            name: (p.projectName as string) || 'Mi historia',
            icon: null,
            cards: oldCards.length > 0 ? oldCards : [makeStart()],
            connections: (p.connections as Connection[]) ?? [],
            groups: [],
            codex: oldCodex,
            revisions: [],
            createdAt: t,
            updatedAt: t,
          };
          return { ...current, projects: [migrated], currentId: migrated.id } as StoryState;
        }
        const seeded = seedProject();
        return { ...current, projects: [seeded], currentId: seeded.id } as StoryState;
      },
    },
  ),
);
