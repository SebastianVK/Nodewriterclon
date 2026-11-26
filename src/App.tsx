import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  useReactFlow,
  useUpdateNodeInternals,
  ConnectionMode,
  type Connection as RFConnection,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './App.css';
import CardNode from './CardNode';
import GroupNode from './GroupNode';
import ThreadEdge, { PrototypeConnectionLine } from './ThreadEdge';
import ConfirmCardDropModal, { type CardDropAction } from './ConfirmCardDropModal';
import ConfirmDeleteConnectionsModal from './ConfirmDeleteConnectionsModal';
import { IdeaComposer } from './IdeaComposer';
import GraphView, { type GraphEndpoint } from './GraphView';
import { currentProject, runHistoryBatch, useStore } from './store';
import {
  CARD_COLORS,
  CODEX_COLORS,
  CODEX_TYPES,
  GROUP_COLORS,
  SUMMARY_MAX,
  TRASH_RETENTION_DAYS,
  cardLabel,
  cardTags,
  codexLabel,
  codexPlaceholder,
  degreeOf,
  groupNodeId,
  groupSourceId,
  isGroupNodeId,
  markdownToHtml,
  orderFromStart,
  relativeTime,
  wordCount,
  wouldCreateLoop,
  type Card,
  type CodexEntry,
  type CodexType,
  type Connection,
  type Group,
  type Project,
} from './types';
import { cardText, cardsMentioning, findMentions } from './mentions';
import {
  ArrowLeft,
  Bold,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleQuestionMark,
  Copy,
  Download,
  FileArchive,
  FileDown,
  FileText,
  Group as GroupIcon,
  Heading,
  ImagePlus,
  Italic,
  Link2,
  List,
  Lock,
  Maximize2,
  Minimize2,
  Network,
  Paperclip,
  Plus,
  Printer,
  Redo2,
  RotateCcw,
  Search,
  SquarePen,
  Trash,
  Undo2,
  Ungroup,
  Unlink,
  Unlock,
  X,
} from 'lucide-react';
import { CARD_ICONS, Ban, iconFor } from './icons';
import { buildEpub, printDocument } from './epub';
import {
  exportBackup,
  exportBackupZip,
  parseBackupFile,
  type BackupImage,
  type ParsedBackup,
} from './backup';
import { collectImgIds, getImages, isImageFile, putImage, resolveImgRefs } from './images';

const nodeTypes = { card: CardNode, group: GroupNode };
const edgeTypes = { thread: ThreadEdge };
const GROUP_COLLAPSED_WIDTH = 248;
const GROUP_COLLAPSED_HEIGHT = 44;
const SUMMARY_PREFIX = 'summary:';

/* ---------------- helpers ---------------- */

function toCardNode(
  card: Card,
  groups: Group[],
  codex: CodexEntry[],
  dimmed: boolean,
): Node {
  const g = card.groupId ? groups.find((gr) => gr.id === card.groupId) : undefined;
  const hidden = g?.collapsed === true;
  return {
    id: card.id,
    type: 'card',
    position: g ? { x: card.x - g.x, y: card.y - g.y } : { x: card.x, y: card.y },
    data: { card, codex, dimmed },
    hidden,
    selectable: !hidden,
    deletable: card.type !== 'start',
    ...(g ? { parentId: groupNodeId(g.id), extent: 'parent' as const } : {}),
  };
}

function toGroupNode(
  group: Group,
  handlers: {
    cardCount: number;
    fresh?: boolean;
    onRename: (name: string) => void;
    onResizeEnd: (rect: { x: number; y: number; width: number; height: number }) => void;
    onToggleLock: () => void;
    onToggleCollapse: () => void;
  },
): Node {
  const collapsed = group.collapsed === true;
  const width = collapsed ? Math.min(group.width, GROUP_COLLAPSED_WIDTH) : group.width;
  const height = collapsed ? GROUP_COLLAPSED_HEIGHT : group.height;
  return {
    id: groupNodeId(group.id),
    type: 'group',
    position: { x: group.x, y: group.y },
    /* React Flow usa node.width/height por encima del style una vez medido. */
    width,
    height,
    style: { width, height },
    draggable: !group.locked,
    deletable: false,
    selectable: true,
    data: {
      group,
      cardCount: handlers.cardCount,
      fresh: handlers.fresh ?? false,
      onRename: handlers.onRename,
      onResizeEnd: handlers.onResizeEnd,
      onToggleLock: handlers.onToggleLock,
      onToggleCollapse: handlers.onToggleCollapse,
    },
  };
}

/* Borde por defecto para conexiones guardadas sin handles (creadas antes del
   UI 2.0 o desde la vista grafo): salida por la derecha, llegada por la izq. */
function toEdge(
  source: string,
  target: string,
  id: string,
  sourceHandle?: string | null,
  targetHandle?: string | null,
  options?: { hidden?: boolean; summary?: boolean },
): Edge {
  const summary = options?.summary === true;
  return {
    id,
    source,
    target,
    sourceHandle: sourceHandle ?? 'r',
    targetHandle: targetHandle ?? 'l',
    type: 'thread',
    animated: !summary,
    hidden: options?.hidden === true,
    selectable: !summary,
    deletable: !summary,
    className: summary ? 'edge-summary' : undefined,
  };
}

/** Tarjetas ocultas por un grupo plegado y el grupo que las representa. */
function hiddenCardsByGroup(project: Project): Map<string, string> {
  const hidden = new Map<string, string>();
  for (const card of project.cards) {
    if (card.deletedAt || !card.groupId) continue;
    const group = project.groups.find((g) => g.id === card.groupId);
    if (group?.collapsed) hidden.set(card.id, group.id);
  }
  return hidden;
}

/**
 * Aristas del tablero. Los enlaces manuales se dibujan siempre; las conexiones
 * de tarjetas ocultas por un grupo plegado se resumen contra el grupo.
 */
function buildBoardEdges(project: Project, selectedIds?: Set<string>): Edge[] {
  const hidden = hiddenCardsByGroup(project);
  const seen = new Set<string>();
  const edges: Edge[] = [];

  const add = (cn: Connection, summary: boolean) => {
    const source = hidden.has(cn.source) ? groupNodeId(hidden.get(cn.source)!) : cn.source;
    const target = hidden.has(cn.target) ? groupNodeId(hidden.get(cn.target)!) : cn.target;
    if (source === target) return;
    const key = `${source}->${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      ...toEdge(source, target, summary ? `${SUMMARY_PREFIX}${key}` : cn.id, cn.sourceHandle, cn.targetHandle, {
        summary,
      }),
      selected: !summary && (selectedIds?.has(cn.id) ?? false),
    });
  };

  // Primero los enlaces manuales: si coinciden con un resumen, ganan ellos.
  for (const cn of project.connections) {
    if (!hidden.has(cn.source) && !hidden.has(cn.target)) add(cn, false);
  }
  for (const cn of project.connections) {
    if (hidden.has(cn.source) || hidden.has(cn.target)) add(cn, true);
  }
  return edges;
}

function download(filename: string, text: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function sequenceMarkdown(projectName: string, seq: Card[], withSummaries: boolean): string {
  const lines = [`# ${projectName}`, ''];
  for (const c of seq) {
    if (c.type === 'start') continue;
    lines.push(`## ${cardLabel(c)}`, '');
    if (withSummaries && c.summary) lines.push(`*${c.summary}*`, '');
    if (c.content) lines.push(c.content, '');
  }
  return lines.join('\n');
}

function pointSegDist(
  px: number, py: number, ax: number, ay: number, bx: number, by: number,
): { dist: number; t: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return { dist: Math.hypot(px - cx, py - cy), t };
}

/* ---------------- página de proyectos ---------------- */

function ProjectsPage() {
  const projects = useStore((s) => s.projects);
  const createProject = useStore((s) => s.createProject);
  const deleteProject = useStore((s) => s.deleteProject);
  const renameProject = useStore((s) => s.renameProject);
  const openProject = useStore((s) => s.openProject);
  const importProject = useStore((s) => s.importProject);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<(ParsedBackup & { images: BackupImage[] }) | null>(null);
  const [importError, setImportError] = useState('');

  return (
    <div className="projects-page">
      <div className="projects-box">
        <div className="projects-head">
          <div>
            <h1>StoryGraph</h1>
            <p className="muted">Tus proyectos, en local. Sin cuentas, sin nube.</p>
          </div>
          <span style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-secondary"
              onClick={() => document.getElementById('import-json-input')?.click()}
            >
              Importar JSON/ZIP
            </button>
            <button
              className="btn btn-primary"
              onClick={() => { createProject('Nuevo proyecto'); }}
            >
              + Nuevo proyecto
            </button>
          </span>
        </div>
        <input
          id="import-json-input"
          type="file"
          accept=".json,.zip,application/json,application/zip"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            setImportError('');
            parseBackupFile(f)
              .then((r) => setPending({ ...r.parsed, images: r.images }))
              .catch((err: unknown) =>
                setImportError(err instanceof Error ? err.message : 'No se pudo leer el archivo.'),
              );
          }}
        />
        {importError && <p className="warn">{importError}</p>}
        {projects.length === 0 && <p className="muted">Aún no hay proyectos.</p>}
        <ul className="projects-list">
          {projects.map((p) => {
            const live = p.cards.filter((c) => !c.deletedAt && c.type !== 'start');
            const words = live.reduce((n, c) => n + wordCount(c.content), 0);
            return (
              <li key={p.id} className="project-row">
                <button className="project-open" onClick={() => openProject(p.id)}>
                  <span className="project-name-big">{p.name}</span>
                  <span className="muted">
                    {live.length} tarjeta{live.length === 1 ? '' : 's'} · {words} palabras · act. {relativeTime(p.updatedAt)}
                  </span>
                </button>
                {renamingId === p.id ? (
                  <input
                    autoFocus
                    className="input project-rename"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => { renameProject(p.id, draft); setRenamingId(null); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                  />
                ) : (
                  <>
                    <button
                      className="btn btn-icon"
                      title="Renombrar"
                      onClick={() => { setDraft(p.name); setRenamingId(p.id); }}
                    >
                      <SquarePen size={15} />
                    </button>
                    <button
                      className="btn btn-icon btn-danger"
                      title="Eliminar proyecto"
                      onClick={() => {
                        if (window.confirm(`¿Eliminar "${p.name}" con todo su contenido?`)) {
                          deleteProject(p.id);
                        }
                      }}
                    >
                      <Trash size={15} />
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        {pending && (
          <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setPending(null); }}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>Importar proyecto</h2>
                <button className="btn btn-icon" onClick={() => setPending(null)} title="Cerrar">
                  <X size={18} />
                </button>
              </div>
              <div className="modal-body">
                <p><strong>{pending.name}</strong></p>
                <p className="muted">
                  Origen: {pending.kind === 'nodewriter' ? 'NodeWriter' : 'StoryGraph (backup completo)'}
                </p>
                <ul className="seq-list">
                  <li>{pending.counts.cards} tarjeta{pending.counts.cards === 1 ? '' : 's'}</li>
                  <li>{pending.counts.connections} conexiones</li>
                  <li>{pending.counts.groups} grupos · {pending.counts.codex} entradas codex · {pending.counts.revisions} revisiones</li>
                  {pending.images.length > 0 && (
                    <li>{pending.images.length} imagen{pending.images.length === 1 ? '' : 'es'}</li>
                  )}
                </ul>
                <p className="muted">Se creará como proyecto nuevo con ids frescos. Tus proyectos existentes no se modifican.</p>
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setPending(null)}>Cancelar</button>
                <button
                  className="btn btn-primary"
                  onClick={() => { importProject(pending.project, pending.images); setPending(null); }}
                >
                  Importar
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- editor de tarjeta ---------------- */

function CardEditor({
  cardId,
  onClose,
  onOpenCodexEntry,
  onChanged,
  onDuplicated,
  onFlowChanged,
  onRequestRemoveFromFlow,
}: {
  cardId: string;
  onClose: () => void;
  onOpenCodexEntry: (entryId: string) => void;
  onChanged: () => void;
  onDuplicated: (copy: Card) => void;
  onFlowChanged: () => void;
  onRequestRemoveFromFlow: (cardId: string) => void;
}) {
  const card = useStore((s) => {
    const p = currentProject(s);
    return p?.cards.find((c) => c.id === cardId) ?? null;
  });
  const project = useStore((s) => currentProject(s));
  const updateCard = useStore((s) => s.updateCard);
  const duplicateCard = useStore((s) => s.duplicateCard);
  const trashCard = useStore((s) => s.trashCard);
  const setCardGroup = useStore((s) => s.setCardGroup);
  const saveRevision = useStore((s) => s.saveRevision);

  const [title, setTitle] = useState(card?.title ?? '');
  const [summary, setSummary] = useState(card?.summary ?? '');
  const [content, setContent] = useState(card?.content ?? '');
  const [tags, setTags] = useState<string[]>(card ? cardTags(card.tags) : []);
  const [tagInput, setTagInput] = useState('');
  const [tagIdx, setTagIdx] = useState(0);
  const [tagFocused, setTagFocused] = useState(false);
  const [color, setColor] = useState(card?.color ?? CARD_COLORS[0]);
  const [icon, setIcon] = useState<string | null>(card?.icon ?? null);
  const [focus, setFocus] = useState(false);
  const [showRevisions, setShowRevisions] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const codex = project?.codex ?? [];
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const c of project?.cards ?? []) {
      if (c.deletedAt) continue;
      for (const t of cardTags(c.tags)) set.add(t);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [project]);
  const suggestions = useMemo(() => {
    const q = tagInput.trim().toLowerCase();
    return allTags.filter((t) => !tags.includes(t) && (!q || t.toLowerCase().includes(q))).slice(0, 8);
  }, [allTags, tags, tagInput]);

  useEffect(() => setTagIdx(0), [tagInput]);

  if (!card || !project) return null;

  const draft: Card = { ...card, title, summary, content, tags, color, icon };
  const mentions = codex.filter((e) => findMentions(cardText(draft), codex).includes(e.id));
  const inFlow = degreeOf(card.id, project.connections) > 0;

  function collect() {
    return { title, summary, content, tags, color, icon };
  }

  function save() {
    const id: string = cardId;
    runHistoryBatch(() => {
      updateCard(id, collect());
      saveRevision(id);
    });
    onChanged();
  }

  function done() {
    save();
    onClose();
  }

  function addTag(raw: string) {
    const t = raw.trim().replace(/,+$/, '');
    if (t && !tags.includes(t)) setTags((prev) => [...prev, t]);
    setTagInput('');
  }

  function applyFormat(kind: 'heading' | 'bold' | 'italic' | 'list' | 'link') {
    const ta = taRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e, value } = ta;
    const sel = value.slice(s, e) || 'texto';
    let next = value;
    let caret: [number, number] = [s, s];
    if (kind === 'heading' || kind === 'list') {
      const prefix = kind === 'heading' ? '# ' : '- ';
      const ls = value.lastIndexOf('\n', s - 1) + 1;
      next = value.slice(0, ls) + prefix + value.slice(ls);
      const shift = prefix.length;
      caret = [s + shift, e + shift];
    } else if (kind === 'bold') {
      next = value.slice(0, s) + `**${sel}**` + value.slice(e);
      caret = [s + 2, s + 2 + sel.length];
    } else if (kind === 'italic') {
      next = value.slice(0, s) + `*${sel}*` + value.slice(e);
      caret = [s + 1, s + 1 + sel.length];
    } else {
      next = value.slice(0, s) + `[${sel}](https://)` + value.slice(e);
      caret = [s + sel.length + 3, s + sel.length + 11];
    }
    setContent(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(caret[0], caret[1]);
    });
  }

  function insertMd(snippet: string) {
    const ta = taRef.current;
    const before = content;
    const s = ta?.selectionStart ?? before.length;
    const e = ta?.selectionEnd ?? s;
    const nlL = s > 0 && before[s - 1] !== '\n' ? '\n' : '';
    const nlR = e < before.length && before[e] !== '\n' ? '\n' : '';
    const text = `${nlL}${snippet}${nlR}`;
    const next = before.slice(0, s) + text + before.slice(e);
    setContent(next);
    requestAnimationFrame(() => {
      if (!ta) return;
      const pos = s + text.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  }

  async function insertImages(files: File[]) {
    const imgs = files.filter(isImageFile).slice(0, 10);
    const parts: string[] = [];
    for (const f of imgs) {
      try {
        const { id, name } = await putImage(f);
        parts.push(`![${name.replace(/\.[^.]+$/, '')}](img://${id})`);
      } catch {
        /* formato no soportado o sin espacio */
      }
    }
    if (parts.length) insertMd(parts.join('\n\n'));
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) done(); }}>
      <div
        className={`modal card-editor-modal${focus ? ' focus' : ''}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            done();
          }
        }}
      >
        <div className="modal-header">
          <h2>Editar tarjeta</h2>
          <span>
            <button
              className="btn btn-icon"
              title={focus ? 'Salir del modo concentración' : 'Modo concentración'}
              onClick={() => setFocus((v) => !v)}
            >
              {focus ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button>{' '}
            <button className="btn btn-icon" onClick={done} title="Guardar y cerrar">
              <X size={18} />
            </button>
          </span>
        </div>
        <div className="modal-body">
          {!focus && (
            <>
              <label className="field-label">Título</label>
              <input
                className="input"
                value={title}
                placeholder="Nueva tarjeta"
                {...(card.title.trim() ? {} : { autoFocus: true })}
                onChange={(e) => setTitle(e.target.value)}
              />
              <label className="field-label">
                Resumen <span className="muted">{summary.length}/{SUMMARY_MAX}</span>
              </label>
              <input
                className="input"
                value={summary}
                maxLength={SUMMARY_MAX}
                placeholder="Una línea de resumen"
                onChange={(e) => setSummary(e.target.value)}
              />
              <label className="field-label">Etiquetas</label>
              <div className="tag-editor">
                <div className="tag-chips">
                  {tags.map((t) => (
                    <span key={t} className="tag-chip">
                      {t}
                      <button type="button" aria-label={`Quitar ${t}`} onClick={() => setTags((prev) => prev.filter((x) => x !== t))}>
                        ✕
                      </button>
                    </span>
                  ))}
                  <input
                    className="tag-input"
                    value={tagInput}
                    placeholder={tags.length ? 'Añadir…' : 'Añade etiqueta y pulsa Enter…'}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        if (e.key === 'Enter' && suggestions[tagIdx]) addTag(suggestions[tagIdx]);
                        else addTag(tagInput);
                      }
                      if (e.key === 'ArrowDown') { e.preventDefault(); setTagIdx((i) => Math.min(i + 1, suggestions.length - 1)); }
                      if (e.key === 'ArrowUp') { e.preventDefault(); setTagIdx((i) => Math.max(i - 1, 0)); }
                      if (e.key === 'Backspace' && !tagInput && tags.length) setTags((prev) => prev.slice(0, -1));
                      if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
                    }}
                    onFocus={() => setTagFocused(true)}
                    onBlur={() => { setTagFocused(false); if (tagInput.trim()) addTag(tagInput); }}
                  />
                </div>
                {tagFocused && suggestions.length > 0 && (
                  <div className="tag-suggest">
                    {suggestions.map((s, i) => (
                      <button
                        key={s}
                        type="button"
                        className={i === tagIdx ? 'active' : ''}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => addTag(s)}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {mentions.length > 0 && (
                <>
                  <label className="field-label">Mencionados</label>
                  <div className="mention-chips">
                    {mentions.map((m) => {
                      const MentionIcon = iconFor(m.icon);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          className="mention-chip"
                          title={`Abrir "${codexLabel(m)}" en el codex`}
                          onClick={() => onOpenCodexEntry(m.id)}
                        >
                          {MentionIcon ? (
                            <span className="mention-icon" style={{ color: m.color }}>
                              <MentionIcon size={13} />
                            </span>
                          ) : (
                            <span className="mention-dot" style={{ background: m.color }} />
                          )}
                          {codexLabel(m)}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
              <div className="appearance-groups">
                <div className="appearance-group">
                  <span className="appearance-label">Color</span>
                  <div className="swatches">
                    {CARD_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`swatch${color === c ? ' active' : ''}`}
                        style={{ background: c }}
                        aria-label={c}
                        onClick={() => setColor(c)}
                      />
                    ))}
                    <label
                      className={`swatch swatch-custom${CARD_COLORS.includes(color) ? '' : ' active'}`}
                      title="Color personalizado"
                    >
                      <input
                        type="color"
                        value={color}
                        onChange={(e) => setColor(e.target.value.toUpperCase())}
                      />
                    </label>
                  </div>
                </div>
                <div className="appearance-group">
                  <span className="appearance-label">Icono</span>
                  <div className="icon-grid">
                    <button
                      type="button"
                      className={`icon-btn${!icon ? ' active' : ''}`}
                      title="Sin icono"
                      onClick={() => setIcon(null)}
                    >
                      <Ban size={15} />
                    </button>
                    {CARD_ICONS.map(({ key, label }) => {
                      const Icon = iconFor(key);
                      if (!Icon) return null;
                      return (
                        <button
                          key={key}
                          type="button"
                          className={`icon-btn${icon === key ? ' active' : ''}`}
                          title={label}
                          onClick={() => setIcon(key)}
                        >
                          <Icon size={15} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </>
          )}
          <div className="editor-toolbar">
            <button className="btn btn-icon" title="Encabezado" onClick={() => applyFormat('heading')}>
              <Heading size={16} />
            </button>
            <button className="btn btn-icon" title="Negrita" onClick={() => applyFormat('bold')}>
              <Bold size={16} />
            </button>
            <button className="btn btn-icon" title="Cursiva" onClick={() => applyFormat('italic')}>
              <Italic size={16} />
            </button>
            <button className="btn btn-icon" title="Lista" onClick={() => applyFormat('list')}>
              <List size={16} />
            </button>
            <button className="btn btn-icon" title="Enlace" onClick={() => applyFormat('link')}>
              <Link2 size={16} />
            </button>
            <button
              className="btn btn-icon"
              title="Insertar imagen (archivo; también puedes pegar o arrastrar)"
              onClick={() => fileInputRef.current?.click()}
            >
              <Paperclip size={16} />
            </button>
            <button
              className="btn btn-icon"
              title="Insertar imagen desde URL"
              onClick={() => {
                const u = window.prompt('URL de la imagen (http/https):');
                if (u && u.trim()) insertMd(`![imagen](${u.trim()})`);
              }}
            >
              <ImagePlus size={16} />
            </button>
            <span className="card-words">{wordCount(content)} palabras</span>
          </div>
          <textarea
            ref={taRef}
            className={`input editor-textarea${focus ? ' focus' : ''}`}
            value={content}
            placeholder="Escribe en markdown…"
            onChange={(e) => setContent(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files ?? []);
              if (files.some(isImageFile)) {
                e.preventDefault();
                void insertImages(files);
              }
            }}
            onDragOver={(e) => {
              if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
            }}
            onDrop={(e) => {
              if (!Array.from(e.dataTransfer.types).includes('Files')) return;
              e.preventDefault();
              const files = Array.from(e.dataTransfer.files ?? []);
              if (files.some(isImageFile)) void insertImages(files);
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const fs = Array.from(e.target.files ?? []);
              e.target.value = '';
              if (fs.length) void insertImages(fs);
            }}
          />
        </div>
        <div className="modal-footer">
          {!focus && (
            <span className="footer-actions">
              {inFlow && (
                <button
                  className="btn btn-icon"
                  title="Quitar del flujo"
                  onClick={() => { save(); onRequestRemoveFromFlow(card.id); }}
                >
                  <Unlink size={16} />
                </button>
              )}
              {card.groupId && (
                <button
                  className="btn btn-icon"
                  title="Quitar del grupo"
                  onClick={() => { save(); setCardGroup(card.id, null); onChanged(); }}
                >
                  <Ungroup size={16} />
                </button>
              )}
              <button
                className="btn btn-icon"
                title="Historial de revisiones"
                onClick={() => { save(); setShowRevisions(true); }}
              >
                <RotateCcw size={16} />
              </button>
              {card.type !== 'start' && (
                <button
                  className="btn btn-icon"
                  title="Duplicar tarjeta"
                  onClick={() => { save(); const copy = duplicateCard(card.id); if (copy) onDuplicated(copy); onChanged(); }}
                >
                  <Copy size={16} />
                </button>
              )}
              {card.type !== 'start' && (
                <button
                  className="btn btn-icon btn-danger"
                  title="Eliminar tarjeta"
                  onClick={() => { trashCard(card.id); onChanged(); onFlowChanged(); onClose(); }}
                >
                  <Trash size={16} />
                </button>
              )}
            </span>
          )}
          <span className="spacer" />
          <button className="btn btn-secondary" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" onClick={done}>Guardar</button>
        </div>
        {showRevisions && (
          <RevisionsModal
            cardId={card.id}
            onClose={() => setShowRevisions(false)}
            onRestored={() => {
              const fresh = currentProject(useStore.getState())?.cards.find((c) => c.id === card.id);
              if (fresh) {
                setTitle(fresh.title);
                setSummary(fresh.summary);
                setContent(fresh.content);
              }
              onChanged();
            }}
          />
        )}
      </div>
    </div>
  );
}

/* ---------------- revisiones ---------------- */

function RevisionsModal({
  cardId,
  onClose,
  onRestored,
}: {
  cardId: string;
  onClose: () => void;
  onRestored: () => void;
}) {
  const allRevisions = useStore((s) => currentProject(s)?.revisions);
  const revisions = useMemo(
    () => (allRevisions ?? []).filter((r) => r.cardId === cardId),
    [allRevisions, cardId],
  );
  const restoreRevision = useStore((s) => s.restoreRevision);
  const [selectedId, setSelectedId] = useState<string | null>(revisions[0]?.id ?? null);
  const selected = revisions.find((r) => r.id === selectedId) ?? null;

  return (
    <div className="modal-overlay" onMouseDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal revision-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Historial de revisiones</h2>
          <button className="btn btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="revision-layout">
          <div className="revision-list">
            {revisions.length === 0 && (
              <p className="muted">Sin versiones aún: aparecen al guardar cambios.</p>
            )}
            {revisions.map((r) => (
              <button
                key={r.id}
                className={`revision-row${r.id === selectedId ? ' active' : ''}`}
                onClick={() => setSelectedId(r.id)}
              >
                <span>{relativeTime(r.createdAt)}</span>
                <span className="muted">{(r.content || r.summary || '').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Vacío'}</span>
              </button>
            ))}
          </div>
          <div className="revision-detail">
            {selected ? (
              <>
                <div className="revision-content">{selected.content || <em>Vacío</em>}</div>
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    if (window.confirm('¿Restaurar esta versión? La actual se guarda primero en el historial.')) {
                      restoreRevision(cardId, selected.id);
                      onRestored();
                      onClose();
                    }
                  }}
                >
                  Restaurar esta versión
                </button>
              </>
            ) : (
              <p className="muted">Elige una versión para verla.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- codex ---------------- */

function CodexModal({
  initialId,
  onClose,
  onJump,
}: {
  initialId: string | null;
  onClose: () => void;
  onJump: (cardId: string) => void;
}) {
  const project = useStore((s) => currentProject(s));
  const addCodex = useStore((s) => s.addCodex);
  const updateCodex = useStore((s) => s.updateCodex);
  const deleteCodex = useStore((s) => s.deleteCodex);
  const [filter, setFilter] = useState<'all' | CodexType>('all');
  const [selectedId, setSelectedId] = useState<string | null>(initialId ?? project?.codex[0]?.id ?? null);
  const [name, setName] = useState('');
  const [aliases, setAliases] = useState('');
  const [notes, setNotes] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  const focusNameRef = useRef(false);

  const entries = project?.codex ?? [];
  const cards = useMemo(() => project?.cards.filter((c) => !c.deletedAt) ?? [], [project]);
  const selected = entries.find((e) => e.id === selectedId) ?? null;

  useEffect(() => {
    setName(selected?.name ?? '');
    setAliases(selected?.aliases.join(', ') ?? '');
    setNotes(selected?.notes ?? '');
    if (focusNameRef.current) {
      focusNameRef.current = false;
      requestAnimationFrame(() => nameRef.current?.focus());
    }
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = useMemo(
    () =>
      (filter === 'all' ? entries : entries.filter((e) => e.type === filter)).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    [entries, filter],
  );
  const appearsIn = selected ? cardsMentioning(selected, cards) : [];

  function commit(field: 'name' | 'aliases' | 'notes') {
    if (!selected) return;
    if (field === 'name') {
      const v = name.trim();
      if (v && v !== selected.name) updateCodex(selected.id, { name: v });
      else setName(selected.name);
    } else if (field === 'aliases') {
      const v = aliases.split(',').map((a) => a.trim()).filter(Boolean);
      if (JSON.stringify(v) !== JSON.stringify(selected.aliases)) updateCodex(selected.id, { aliases: v });
    } else {
      if (notes !== selected.notes) updateCodex(selected.id, { notes });
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal codex-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Codex de historia</h2>
          <button className="btn btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="codex-layout">
          <div className="codex-list">
            <div className="codex-filters">
              {(['all', ...CODEX_TYPES.map((t) => t.key)] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`codex-filter${filter === f ? ' active' : ''}`}
                  onClick={() => setFilter(f)}
                >
                  {f === 'all' ? 'Todos' : CODEX_TYPES.find((t) => t.key === f)?.label ?? f}
                </button>
              ))}
            </div>
            <div className="codex-entries">
              {visible.length === 0 && <p className="muted">Sin entradas.</p>}
              {visible.map((e) => {
                const EntryIcon = iconFor(e.icon);
                return (
                  <button
                    key={e.id}
                    type="button"
                    className={`codex-row${e.id === selectedId ? ' active' : ''}`}
                    onClick={() => setSelectedId(e.id)}
                  >
                    {EntryIcon ? (
                      <span className="codex-row-icon" style={{ color: e.color }}>
                        <EntryIcon size={15} />
                      </span>
                    ) : (
                      <span className="mention-dot" style={{ background: e.color }} />
                    )}
                    <span className={e.name.trim() ? undefined : 'muted'}>{codexLabel(e)}</span>
                  </button>
                );
              })}
            </div>
            <button
              className="btn btn-secondary"
              onClick={() => {
                const e = addCodex(filter === 'all' ? 'character' : filter);
                if (e) {
                  focusNameRef.current = true;
                  setSelectedId(e.id);
                }
              }}
            >
              + Nueva entrada
            </button>
          </div>
          <div className="codex-detail">
            {selected ? (
              <>
                <div className="codex-name-row">
                  <input
                    ref={nameRef}
                    className="input"
                    value={name}
                    placeholder={codexPlaceholder(selected.type)}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => commit('name')}
                  />
                  <select
                    className="input codex-type"
                    value={selected.type}
                    onChange={(e) => updateCodex(selected.id, { type: e.target.value as CodexType })}
                  >
                    {CODEX_TYPES.map((t) => (
                      <option key={t.key} value={t.key}>{t.label}</option>
                    ))}
                  </select>
                </div>
                <label className="field-label">También conocido como</label>
                <input
                  className="input"
                  value={aliases}
                  placeholder="Apodos, separados por coma"
                  onChange={(e) => setAliases(e.target.value)}
                  onBlur={() => commit('aliases')}
                />
                <label className="field-label">Color</label>
                <div className="swatches">
                  {CODEX_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`swatch${selected.color === c ? ' active' : ''}`}
                      style={{ background: c }}
                      aria-label={c}
                      onClick={() => updateCodex(selected.id, { color: c })}
                    />
                  ))}
                  <label
                    className={`swatch swatch-custom${CODEX_COLORS.includes(selected.color) ? '' : ' active'}`}
                    title="Color personalizado"
                  >
                    <input
                      type="color"
                      value={selected.color}
                      onChange={(e) => updateCodex(selected.id, { color: e.target.value.toUpperCase() })}
                    />
                  </label>
                </div>
                <label className="field-label">Icono</label>
                <div className="icon-grid">
                  <button
                    type="button"
                    className={`icon-btn${!selected.icon ? ' active' : ''}`}
                    title="Sin icono"
                    onClick={() => updateCodex(selected.id, { icon: null })}
                  >
                    <Ban size={15} />
                  </button>
                  {CARD_ICONS.map(({ key, label }) => {
                    const Icon = iconFor(key);
                    return (
                      <button
                        key={key}
                        type="button"
                        className={`icon-btn${selected.icon === key ? ' active' : ''}`}
                        title={label}
                        onClick={() => updateCodex(selected.id, { icon: key })}
                      >
                        {Icon && <Icon size={15} />}
                      </button>
                    );
                  })}
                </div>
                <label className="field-label">Notas</label>
                <textarea
                  className="input"
                  rows={3}
                  value={notes}
                  placeholder="Apariencia, motivaciones, lo que sea…"
                  onChange={(e) => setNotes(e.target.value)}
                  onBlur={() => commit('notes')}
                />
                {appearsIn.length > 0 && (
                  <>
                    <h4>Aparece en {appearsIn.length} tarjeta{appearsIn.length === 1 ? '' : 's'}</h4>
                    <ul className="appears-list">
                      {appearsIn.map((c) => (
                        <li key={c.id}>
                          <button
                            type="button"
                            className="link-btn"
                            onClick={() => { onJump(c.id); onClose(); }}
                          >
                            {cardLabel(c)}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                <button
                  className="btn btn-icon btn-danger"
                  title="Eliminar entrada"
                  onClick={() => {
                    if (window.confirm(`¿Eliminar "${codexLabel(selected)}"?`)) {
                      deleteCodex(selected.id);
                      setSelectedId(null);
                    }
                  }}
                >
                  <Trash size={16} />
                </button>
              </>
            ) : (
              <div className="codex-detail-empty">
                <BookOpen size={32} />
                <p>Elige una entrada, o crea una nueva para empezar tu codex.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- papelera ---------------- */

function TrashPanel({ onClose, onRestored }: { onClose: () => void; onRestored: (id: string) => void }) {
  const project = useStore((s) => currentProject(s));
  const restoreCard = useStore((s) => s.restoreCard);
  const deleteCardForever = useStore((s) => s.deleteCardForever);
  const emptyTrash = useStore((s) => s.emptyTrash);
  const trashed = useMemo(
    () => (project?.cards ?? []).filter((c) => c.deletedAt),
    [project],
  );

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal trash-modal" onClick={(e) => e.stopPropagation()}>
      <div className="modal-header">
        <h2>Papelera</h2>
        <button className="btn btn-icon" onClick={onClose} title="Cerrar">
          <X size={18} />
        </button>
      </div>
      <div className="modal-body">
        <p className="trash-note">
          Las tarjetas eliminadas se guardan {TRASH_RETENTION_DAYS} días antes de borrarse del todo. (En local no se auto-borran).
        </p>
        {trashed.length === 0 && <p className="trash-empty">La papelera está vacía.</p>}
        <ul className="trash-list">
          {trashed.map((c) => (
            <li key={c.id} className="trash-row">
              <span className="trash-row-dot" style={{ background: c.color }} />
              <div className="trash-row-info">
                <span className="trash-row-label">{cardLabel(c)}</span>
                <span className="trash-row-meta">
                  Eliminada {c.deletedAt ? new Date(c.deletedAt).toLocaleDateString('es-ES') : ''}
                </span>
              </div>
              <div className="trash-row-actions">
              <button
                className="btn btn-icon"
                title="Restaurar"
                onClick={() => { restoreCard(c.id); onRestored(c.id); }}
              >
                <Undo2 size={16} />
              </button>
              <button
                className="btn btn-icon btn-danger"
                title="Borrar para siempre"
                onClick={() => {
                  if (window.confirm(`¿Borrar "${cardLabel(c)}" para siempre?`)) deleteCardForever(c.id);
                }}
              >
                <Trash size={16} />
              </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <div className="modal-footer">
        <button
          className="btn btn-danger trash-empty-btn"
          disabled={trashed.length === 0}
          onClick={() => {
            if (window.confirm(`¿Vaciar la papelera (${trashed.length})? No se puede deshacer.`)) emptyTrash();
          }}
        >
          Vaciar papelera
        </button>
        <button className="btn btn-secondary" onClick={onClose}>Cerrar</button>
      </div>
      </div>
    </div>
  );
}

/* ---------------- búsqueda ---------------- */

function SearchPalette({
  onJump,
  onClose,
  activeTags,
  onToggleTag,
  onClearTags,
}: {
  onJump: (cardId: string) => void;
  onClose: () => void;
  activeTags: string[];
  onToggleTag: (t: string) => void;
  onClearTags: () => void;
}) {
  const project = useStore((s) => currentProject(s));
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const cards = useMemo(() => project?.cards.filter((c) => !c.deletedAt && c.type !== 'start') ?? [], [project]);
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const c of cards) for (const t of cardTags(c.tags)) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [cards]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = cards.filter((c) =>
      activeTags.length === 0 || cardTags(c.tags).some((t) => activeTags.includes(t)),
    );
    if (!needle) return list.slice(0, 50);
    return list.filter((c) =>
      `${c.title} ${c.summary} ${c.content} ${cardTags(c.tags).join(' ')}`.toLowerCase().includes(needle),
    );
  }, [cards, q, activeTags]);

  useEffect(() => setIdx(0), [q, activeTags]);

  function go(id: string) {
    onJump(id);
    onClose();
  }

  return (
    <div className="modal-overlay palette-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, results.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
          if (e.key === 'Enter' && results[idx]) go(results[idx].id);
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="palette-input-row">
          <Search size={17} />
          <input
            autoFocus
            className="input palette-input"
            placeholder="Buscar por título, contenido o etiqueta…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <kbd className="palette-hint">Esc</kbd>
        </div>
        {allTags.length > 0 && (
          <div className="palette-tags">
            {allTags.map((t) => (
              <button
                key={t}
                type="button"
                className={`palette-tag${activeTags.includes(t) ? ' active' : ''}`}
                onClick={() => onToggleTag(t)}
              >
                {t}
              </button>
            ))}
            {activeTags.length > 0 && (
              <button type="button" className="palette-clear" onClick={onClearTags}>
                Limpiar ✕
              </button>
            )}
          </div>
        )}
        <div className="palette-results">
          {results.length === 0 && <p className="muted">Sin resultados</p>}
          {results.map((c, i) => (
            <button
              key={c.id}
              type="button"
              className={`palette-row${i === idx ? ' active' : ''}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => go(c.id)}
            >
              <span className="mention-dot" style={{ background: c.color }} />
              {cardLabel(c)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------- exportar ---------------- */

function ExportModal({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => currentProject(s));
  const [tab, setTab] = useState<'preview' | 'sequence' | 'export'>('preview');
  const [withSummaries, setWithSummaries] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyZip, setBusyZip] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<Record<string, string>>({});
  const seq = useMemo(
    () => (project ? orderFromStart(project.cards, project.connections) : []),
    [project],
  );
  const body = useMemo(() => seq.filter((c) => c.type !== 'start'), [seq]);
  useEffect(() => {
    if (tab !== 'preview') return;
    let alive = true;
    (async () => {
      const out: Record<string, string> = {};
      for (const c of body) out[c.id] = await resolveImgRefs(markdownToHtml(c.content));
      if (alive) setPreviewHtml(out);
    })();
    return () => { alive = false; };
  }, [tab, body]);
  if (!project) return null;
  const totalWords = body.reduce((n, c) => n + wordCount(c.content), 0);

  async function downloadEpub() {
    setBusy(true);
    try {
      const blob = await buildEpub(project!.name, project!.id, seq, withSummaries);
      downloadBlob(`${project!.name}.epub`, blob);
    } finally {
      setBusy(false);
    }
  }

  async function downloadZip() {
    setBusyZip(true);
    try {
      const ids = new Set(project!.cards.flatMap((c) => collectImgIds(c.content)));
      const images = await getImages([...ids]);
      const blob = await exportBackupZip(project!, images);
      downloadBlob(`${project!.name}.storygraph.zip`, blob);
    } finally {
      setBusyZip(false);
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal export-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Vista previa y exportación — {project.name}</h2>
          <button className="btn btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="export-tabs">
          {(['preview', 'sequence', 'export'] as const).map((t) => (
            <button
              key={t}
              className={`export-tab${tab === t ? ' active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t === 'preview' ? 'Vista previa' : t === 'sequence' ? 'Secuencia' : 'Exportar'}
            </button>
          ))}
        </div>
        <div className="modal-body">
          {body.length === 0 && (
            <p className="muted">Aún no hay tarjetas en el flujo: conecta alguna al nodo Start.</p>
          )}
          {tab === 'preview' && (
            <div className="prose">
              {body.map((c) => (
                <div key={c.id} className="prose-block">
                  {withSummaries && c.summary && <p className="prose-summary">{c.summary}</p>}
                  <div
                    dangerouslySetInnerHTML={{
                      __html:
                        previewHtml[c.id] ??
                        (c.content.includes('img://') ? '' : markdownToHtml(c.content)),
                    }}
                  />
                </div>
              ))}
            </div>
          )}
          {tab === 'sequence' && (
            <ol className="seq-list">
              {body.map((c) => (
                <li key={c.id}>
                  <strong>{cardLabel(c)}</strong>
                  <span className="muted"> · {wordCount(c.content)} palabras</span>
                </li>
              ))}
            </ol>
          )}
          {tab === 'export' && (
            <>
              <p className="muted">{body.length} tarjeta{body.length === 1 ? '' : 's'} · {totalWords} palabras</p>
              <label className="check-row">
                <input type="checkbox" checked={withSummaries} onChange={(e) => setWithSummaries(e.target.checked)} />
                Incluir resúmenes en la exportación
              </label>
              <div className="export-buttons">
                <button
                  className="btn btn-secondary"
                  onClick={() => download(`${project.name}.md`, sequenceMarkdown(project.name, seq, withSummaries), 'text/markdown')}
                >
                  <FileDown size={16} /> Markdown
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => download(`${project.name}.txt`, sequenceMarkdown(project.name, seq, withSummaries), 'text/plain')}
                >
                  <FileText size={16} /> Texto plano
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => printDocument(project.name, seq, withSummaries)}
                >
                  <Printer size={16} /> PDF (imprimir)
                </button>
                <button className="btn btn-secondary" disabled={busy} onClick={downloadEpub}>
                  <BookOpen size={16} /> {busy ? 'Generando…' : 'EPUB'}
                </button>
                <button className="btn btn-secondary" disabled={busyZip} onClick={downloadZip}>
                  <FileArchive size={16} /> {busyZip ? 'Generando…' : 'Backup .zip'}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => download(`${project.name}.storygraph.json`, exportBackup(project), 'application/json')}
                >
                  <Download size={16} /> JSON (sin imágenes)
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- ayuda ---------------- */

function HelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Cómo funciona StoryGraph</h2>
          <button className="btn btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body help-body">
          <h3>El tablero</h3>
          <p>Cada proyecto es un lienzo infinito. Rueda o pellizca para zoom, arrastra el fondo para moverte.</p>
          <h3>Tarjetas</h3>
          <p>Cada tarjeta es una escena o capítulo. Doble-click para editar resumen y contenido markdown. Click derecho para más opciones: duplicar, color, icono, quitar del flujo o eliminar. Mantén <kbd>Alt</kbd> al arrastrar para dejar una copia en el destino.</p>
          <h3>Conexiones</h3>
          <p>Arrastra desde el borde de una tarjeta o de un grupo hasta otra tarjeta o grupo. Suelta una tarjeta sobre una línea para insertarla en esa conexión, o sobre otra tarjeta para enlazarlas.</p>
          <h3>Start</h3>
          <p>Todo proyecto tiene un Start verde. La exportación empieza ahí; en bifurcaciones, la rama más alta va primero.</p>
          <h3>Grupos</h3>
          <p>Selecciona varias tarjetas y pulsa Grupo (o Ctrl+G) para crear un grupo alrededor de ellas. También puedes añadir un grupo vacío con el mismo botón. Arrastra tarjetas dentro o fuera para agrupar, y usa la flecha de la cabecera para plegarlo. Los grupos se pueden conectar entre sí o con tarjetas arrastrando desde su borde.</p>
          <h3>Codex</h3>
          <p>Personajes, lugares y demás se detectan solos en tu texto. "Aparece en" lista las tarjetas que lo mencionan.</p>
          <h3>Atajos</h3>
          <ul className="help-shortcuts">
            <li><kbd>Ctrl+K</kbd> buscar / saltar a tarjeta</li>
            <li><kbd>Ctrl+D</kbd> duplicar la tarjeta seleccionada</li>
            <li><kbd>Ctrl+G</kbd> agrupar las tarjetas seleccionadas</li>
            <li><kbd>Ctrl+Enter</kbd> guardar y cerrar el editor</li>
            <li><kbd>Supr</kbd> mandar la tarjeta a la papelera</li>
            <li><kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Mayús+Z</kbd> deshacer / rehacer</li>
            <li><kbd>Ctrl</kbd>+click o arrastrar con <kbd>Mayús</kbd> seleccionar varias tarjetas y moverlas juntas</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

/* ---------------- tablero ---------------- */

type CtxMenu =
  | { x: number; y: number; nodeId: string }
  | { x: number; y: number; edgeId: string }
  | null;

type PendingEdgeDelete = { edgeIds: string[]; cardId?: string } | null;

function Board({ projectId }: { projectId: string }) {
  const project = useStore((s) => (s.currentId === projectId ? s.projects.find((p) => p.id === projectId) ?? null : null));
  const renameProject = useStore((s) => s.renameProject);
  const openProject = useStore((s) => s.openProject);
  const addCard = useStore((s) => s.addCard);
  const addIdea = useStore((s) => s.addIdea);
  const updateCard = useStore((s) => s.updateCard);
  const duplicateCard = useStore((s) => s.duplicateCard);
  const trashCard = useStore((s) => s.trashCard);
  const restoreCard = useStore((s) => s.restoreCard);
  const setCardGroup = useStore((s) => s.setCardGroup);
  const addConnection = useStore((s) => s.addConnection);
  const insertCardInto = useStore((s) => s.insertCardInto);
  const deleteConnection = useStore((s) => s.deleteConnection);
  const addGroup = useStore((s) => s.addGroup);
  const createGroupFromCards = useStore((s) => s.createGroupFromCards);
  const updateGroup = useStore((s) => s.updateGroup);
  const deleteGroup = useStore((s) => s.deleteGroup);
  const ungroupAll = useStore((s) => s.ungroupAll);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const glass = useStore((s) => s.style);
  const setGlass = useStore((s) => s.setStyle);
  const linkStyle = useStore((s) => s.linkStyle);
  const setLinkStyle = useStore((s) => s.setLinkStyle);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);

  const { screenToFlowPosition, setCenter, getNodes, getIntersectingNodes } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();

  const [nodes, setNodes, onNodesChange] = useNodesState(
    (project?.groups.map((g) =>
      toGroupNode(g, {
        cardCount: project.cards.filter((c) => c.groupId === g.id && !c.deletedAt).length,
        onRename: () => undefined,
        onResizeEnd: () => undefined,
        onToggleLock: () => undefined,
        onToggleCollapse: () => undefined,
      }),
    ) ?? []).concat(
      (project?.cards ?? []).filter((c) => !c.deletedAt).map((c) => toCardNode(c, project!.groups, project!.codex, false)),
    ),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState(project ? buildBoardEdges(project) : []);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [codexOpen, setCodexOpen] = useState(false);
  const [codexSelected, setCodexSelected] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [ctx, setCtx] = useState<CtxMenu>(null);
  const [pendingEdgeDelete, setPendingEdgeDelete] = useState<PendingEdgeDelete>(null);
  const [pendingCardDrop, setPendingCardDrop] = useState<CardDropAction | null>(null);
  const [loopWarn, setLoopWarn] = useState(false);
  const [notice, setNotice] = useState('');
  const [nameDraft, setNameDraft] = useState<string | null>(null);

  const activeTagsRef = useRef<string[]>([]);
  activeTagsRef.current = activeTags;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const altDragRef = useRef(false);
  const freshGroupsRef = useRef(new Set<string>());
  const noticeTimerRef = useRef(0);
  const groupSelectionRef = useRef<() => void>(() => undefined);

  const cards = useMemo(() => project?.cards.filter((c) => !c.deletedAt) ?? [], [project]);
  const trashedCount = (project?.cards ?? []).filter((c) => c.deletedAt).length;
  const selectedCardNodes = nodes.filter((n) => n.type === 'card' && n.selected);
  const groupableSelectedCards = selectedCardNodes.filter((n) => {
    const card = (n.data as { card?: Card } | undefined)?.card;
    return !!card && !card.deletedAt && !card.groupId;
  });

  /* Datos del modal de borrado de conexiones: nombres legibles de origen y destino. */
  const pendingConnections = useMemo(() => {
    if (!pendingEdgeDelete || !project) return [];
    const conns = new Map(project.connections.map((cn) => [cn.id, cn]));
    const byCard = new Map(project.cards.map((c) => [c.id, c]));
    const byGroup = new Map(project.groups.map((g) => [g.id, g]));
    const labelOf = (nodeId: string): string => {
      if (isGroupNodeId(nodeId)) {
        const group = byGroup.get(groupSourceId(nodeId));
        return group?.name || 'Grupo eliminado';
      }
      const card = byCard.get(nodeId);
      return card ? cardLabel(card) : 'Tarjeta eliminada';
    };
    return pendingEdgeDelete.edgeIds.flatMap((id) => {
      const cn = conns.get(id);
      if (!cn) return [];
      return [{ source: labelOf(cn.source), target: labelOf(cn.target) }];
    });
  }, [pendingEdgeDelete, project]);

  const pendingCardName = useMemo(() => {
    if (!pendingEdgeDelete?.cardId || !project) return undefined;
    const card = project.cards.find((c) => c.id === pendingEdgeDelete.cardId);
    return card ? cardLabel(card) : undefined;
  }, [pendingEdgeDelete, project]);

  const isDimmed = useCallback(
    (card: Card) => {
      if (activeTagsRef.current.length === 0 || card.type === 'start') return false;
      return !cardTags(card.tags).some((t) => activeTagsRef.current.includes(t));
    },
    [],
  );

  /* Refresca datos de nodos (contenido, colores, grupos, dim) preservando
     posiciones, y añade/elimina nodos según el proyecto (deshacer, papelera).
     También sincroniza las aristas con las conexiones del store. */
  useEffect(() => {
    if (!project) return;
    const groupHandlers = (g: Group) => ({
      cardCount: project.cards.filter((c) => c.groupId === g.id && !c.deletedAt).length,
      fresh: freshGroupsRef.current.has(g.id),
      onRename: (name: string) => updateGroupRef.current(g.id, { name }),
      onResizeEnd: (rect: { x: number; y: number; width: number; height: number }) =>
        handleGroupResize(g.id, rect),
      onToggleLock: () => updateGroupRef.current(g.id, { locked: !g.locked }),
      onToggleCollapse: () => updateGroupRef.current(g.id, { collapsed: g.collapsed !== true }),
    });
    setNodes((nds) => {
      const byId = new Map(nds.map((n) => [n.id, n]));
      const next: Node[] = [];
      for (const g of project.groups) {
        const n = byId.get(groupNodeId(g.id));
        const collapsed = g.collapsed === true;
        if (n) {
          const width = collapsed ? Math.min(g.width, GROUP_COLLAPSED_WIDTH) : g.width;
          const height = collapsed ? GROUP_COLLAPSED_HEIGHT : g.height;
          next.push({
            ...n,
            position: { x: g.x, y: g.y },
            draggable: !g.locked,
            width,
            height,
            style: { ...n.style, width, height },
            data: { ...n.data, group: g, ...groupHandlers(g) },
          });
        } else {
          next.push(toGroupNode(g, groupHandlers(g)));
        }
      }
      for (const c of project.cards) {
        if (c.deletedAt) continue;
        const n = byId.get(c.id);
        const group = c.groupId ? project.groups.find((g) => g.id === c.groupId) : undefined;
        const hidden = group?.collapsed === true;
        if (n) {
          next.push({
            ...n,
            position: group
              ? { x: c.x - group.x, y: c.y - group.y }
              : { x: c.x, y: c.y },
            parentId: group ? groupNodeId(group.id) : undefined,
            extent: group ? ('parent' as const) : undefined,
            hidden,
            selectable: !hidden,
            selected: hidden ? false : n.selected,
            data: { ...n.data, card: c, codex: project.codex, dimmed: isDimmed(c) },
          });
        } else {
          next.push(toCardNode(c, project.groups, project.codex, isDimmed(c)));
        }
      }
      return next;
    });
    syncEdges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  const updateGroupRef = useRef(updateGroup);
  updateGroupRef.current = updateGroup;

  function syncEdges() {
    const p = currentProject(useStore.getState());
    if (!p) return;
    setEdges((prev) => {
      const sel = new Set(prev.filter((e) => e.selected).map((e) => e.id));
      return buildBoardEdges(p, sel);
    });
  }

  const requestDeleteEdges = useCallback((edgeIds: string[], cardId?: string) => {
    const unique = [...new Set(edgeIds)];
    if (!unique.length) return;
    setPendingEdgeDelete({ edgeIds: unique, cardId });
  }, []);

  function confirmPendingEdgeDelete() {
    if (!pendingEdgeDelete) return;
    const ids = pendingEdgeDelete.edgeIds;
    runHistoryBatch(() => {
      for (const id of ids) deleteConnection(id);
    });
    setPendingEdgeDelete(null);
    syncEdges();
  }

  function confirmPendingCardDrop() {
    if (!pendingCardDrop) return;
    if (pendingCardDrop.kind === 'insert') {
      insertCardInto(pendingCardDrop.connectionId, pendingCardDrop.cardId);
    } else {
      addConnection(pendingCardDrop.sourceId, pendingCardDrop.targetId);
    }
    setPendingCardDrop(null);
    syncEdges();
  }

  function refreshCardNode(id: string) {
    const p = currentProject(useStore.getState());
    if (!p) return;
    const c = p.cards.find((x) => x.id === id);
    if (!c || c.deletedAt) {
      setNodes((nds) => nds.filter((n) => n.id !== id));
      return;
    }
    setNodes((nds) => nds.map((n) => (n.id === id ? toCardNode(c, p.groups, p.codex, isDimmed(c)) : n)));
  }

  function absOf(node: Node, all: Node[]): { x: number; y: number } {
    let x = node.position.x;
    let y = node.position.y;
    let parent = node.parentId ? all.find((n) => n.id === node.parentId) : undefined;
    while (parent) {
      x += parent.position.x;
      y += parent.position.y;
      parent = parent.parentId ? all.find((n) => n.id === parent!.parentId) : undefined;
    }
    return { x, y };
  }

  function centerOfCard(nodeId: string, all: Node[]): { x: number; y: number } | null {
    const n = all.find((x) => x.id === nodeId);
    if (!n) return null;
    const abs = absOf(n, all);
    return { x: abs.x + 110, y: abs.y + 40 };
  }

  function handleCardDrop(node: Node, all: Node[]) {
    const st = useStore.getState();
    const p = currentProject(st);
    if (!p) return;
    const card = p.cards.find((c) => c.id === node.id);
    if (!card || card.type === 'start') return;

    // 1) Insertar en arista cercana
    const me = centerOfCard(node.id, all);
    if (me) {
      for (const cn of p.connections) {
        if (cn.source === node.id || cn.target === node.id) continue;
        if (isGroupNodeId(cn.source) || isGroupNodeId(cn.target)) continue;
        const s = centerOfCard(cn.source, all);
        const t = centerOfCard(cn.target, all);
        if (!s || !t) continue;
        const { dist, t: tt } = pointSegDist(me.x, me.y, s.x, s.y, t.x, t.y);
        if (dist < 50 && tt > 0.08 && tt < 0.92) {
          const source = p.cards.find((c) => c.id === cn.source);
          const target = p.cards.find((c) => c.id === cn.target);
          setPendingCardDrop({
            kind: 'insert',
            connectionId: cn.id,
            cardId: node.id,
            cardName: cardLabel(card),
            sourceName: source ? cardLabel(source) : 'Tarjeta eliminada',
            targetName: target ? cardLabel(target) : 'Tarjeta eliminada',
          });
          return;
        }
      }
      // 2) Conectar por proximidad a otra tarjeta poco conectada
      for (const other of all) {
        if (other.type !== 'card' || other.id === node.id) continue;
        const o = centerOfCard(other.id, all);
        if (!o) continue;
        if (Math.hypot(me.x - o.x, me.y - o.y) < 70 && degreeOf(other.id, p.connections) <= 1) {
          if (wouldCreateLoop(other.id, node.id, p.connections)) continue;
          const otherCard = p.cards.find((c) => c.id === other.id);
          setPendingCardDrop({
            kind: 'connect',
            sourceId: other.id,
            targetId: node.id,
            cardName: cardLabel(card),
            otherName: otherCard ? cardLabel(otherCard) : 'Tarjeta',
          });
          return;
        }
      }
    }
  }

  function handleGroupResize(
    groupId: string,
    rect: { x: number; y: number; width: number; height: number },
  ) {
    runHistoryBatch(() => {
      updateGroup(groupId, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      const all = getNodes();
      for (const n of all) {
        if (n.parentId === groupNodeId(groupId)) {
          updateCard(n.id, { x: rect.x + n.position.x, y: rect.y + n.position.y });
        }
      }
    });
  }

  const isValidConnection = useCallback((conn: RFConnection | Edge) => {
    const { source, target } = conn;
    if (!source || !target || source === target) return false;
    const p = currentProject(useStore.getState());
    if (!p) return false;
    if (p.connections.some((cn) => cn.source === source && cn.target === target)) return false;
    // Los enlaces con grupos son visuales: no entran en el cálculo de ciclos.
    if (isGroupNodeId(source) || isGroupNodeId(target)) return true;
    return !wouldCreateLoop(source, target, p.connections);
  }, []);

  const onConnect = useCallback(
    (params: RFConnection) => {
      const { source, target } = params;
      if (!source || !target || source === target) return;
      const p = currentProject(useStore.getState());
      if (!p) return;
      if (
        !isGroupNodeId(source) &&
        !isGroupNodeId(target) &&
        wouldCreateLoop(source, target, p.connections)
      ) {
        setLoopWarn(true);
        setTimeout(() => setLoopWarn(false), 2500);
        return;
      }
      /* En Loose el arrastre define la dirección (de donde empiezas → donde
         sueltas); guardamos los bordes para que la línea salga por el mismo
         borde por el que se agarró, como en el prototipo. */
      const created = addConnection(source, target, params.sourceHandle, params.targetHandle);
      if (created) {
        setEdges((eds) =>
          addEdge({ ...params, id: created.id, type: 'thread', sourceHandle: params.sourceHandle, targetHandle: params.targetHandle, animated: true }, eds),
        );
      }
    },
    [addConnection, setEdges],
  );

  const onBeforeDelete = useCallback(
    async ({ nodes: deletedNodes, edges: deletedEdges }: { nodes: Node[]; edges: Edge[] }) => {
      // Borrado indirecto al eliminar tarjetas/grupos: no pregunta por las conexiones.
      if (deletedNodes.length > 0) return true;
      if (deletedEdges.length === 0) return true;
      requestDeleteEdges(deletedEdges.map((e) => e.id));
      return false;
    },
    [requestDeleteEdges],
  );

  const onNodesDelete = useCallback(
    (deleted: Node[]) => {
      runHistoryBatch(() => {
        for (const n of deleted) {
          if (n.type === 'card') trashCard(n.id);
        }
      });
      syncEdges();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trashCard],
  );

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      for (const e of deleted) deleteConnection(e.id);
      syncEdges();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deleteConnection],
  );

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node | null) => {
      if (!node) return;
      const all = getNodes();
      const st = useStore.getState();
      const p = currentProject(st);
      if (!p) return;
      if (node.type === 'group') {
        const gid = groupSourceId(node.id);
        runHistoryBatch(() => {
          st.updateGroup(gid, { x: node.position.x, y: node.position.y });
          for (const n of all) {
            if (n.parentId === node.id) {
              st.updateCard(n.id, { x: node.position.x + n.position.x, y: node.position.y + n.position.y });
            }
          }
        });
        return;
      }
      const abs = absOf(node, all);
      const card = p.cards.find((c) => c.id === node.id);

      /* Alt+arrastrar: la original queda donde estaba (el nodo vuelve a su
         posición) y la copia aparece donde se soltó, sin grupo. */
      if (altDragRef.current && card && card.type !== 'start') {
        altDragRef.current = false;
        const revert = (id: string, x: number, y: number) => {
          setNodes((nds) =>
            nds.map((n) => {
              if (n.id !== id) return n;
              if (n.parentId) {
                const gp = all.find((g) => g.id === n.parentId);
                return { ...n, position: { x: x - (gp?.position.x ?? 0), y: y - (gp?.position.y ?? 0) } };
              }
              return { ...n, position: { x, y } };
            }),
          );
        };
        revert(node.id, card.x, card.y);
        for (const n of all) {
          if (n.id === node.id || n.type !== 'card' || !n.selected) continue;
          const c2 = p.cards.find((c) => c.id === n.id);
          if (c2 && !c2.deletedAt) revert(n.id, c2.x, c2.y);
        }
        if (Math.abs(abs.x - card.x) > 3 || Math.abs(abs.y - card.y) > 3) {
          runHistoryBatch(() => {
            const copy = st.duplicateCard(node.id);
            if (!copy) return;
            const positioned = { ...copy, groupId: null, x: abs.x, y: abs.y };
            st.setCardGroup(copy.id, null, abs.x, abs.y);
            const p2 = currentProject(useStore.getState());
            if (p2) {
              setNodes((nds) => [...nds, toCardNode(positioned, p2.groups, p2.codex, isDimmed(positioned))]);
            }
          });
        }
        return;
      }
      altDragRef.current = false;

      /* Persistencia: nodo arrastrado + resto de selección (mover en lote),
         agrupar/desagrupar por intersección y caídas especiales. */
      runHistoryBatch(() => {
        st.updateCard(node.id, { x: abs.x, y: abs.y });
        for (const n of all) {
          if (n.id === node.id || n.type !== 'card' || !n.selected) continue;
          const c2 = p.cards.find((c) => c.id === n.id);
          if (!c2 || c2.deletedAt) continue;
          const pos = absOf(n, all);
          if (Math.abs(pos.x - c2.x) < 0.5 && Math.abs(pos.y - c2.y) < 0.5) continue;
          st.updateCard(n.id, { x: pos.x, y: pos.y });
        }
        // Agrupar / desagrupar por intersección
        const hit = getIntersectingNodes(node).filter((n) => n.type === 'group');
        const target = hit.length > 0 ? hit[hit.length - 1] : undefined;
        const targetGid = target ? groupSourceId(target.id) : null;
        if (targetGid !== (card?.groupId ?? null)) {
          const g = targetGid ? p.groups.find((gr) => gr.id === targetGid) : undefined;
          if (g) {
            // Soltar sobre un grupo plegado lo despliega para mostrar el resultado.
            if (g.collapsed) st.updateGroup(g.id, { collapsed: false });
            st.setCardGroup(node.id, g.id, abs.x, abs.y);
            setNodes((nds) =>
              nds.map((n) =>
                n.id === node.id
                  ? { ...n, parentId: groupNodeId(g.id), extent: 'parent' as const, position: { x: abs.x - g.x, y: abs.y - g.y } }
                  : n,
              ),
            );
          } else {
            st.setCardGroup(node.id, null, abs.x, abs.y);
            setNodes((nds) =>
              nds.map((n) =>
                n.id === node.id
                  ? { ...n, parentId: undefined, extent: undefined, position: abs }
                  : n,
              ),
            );
          }
          return;
        }
        handleCardDrop(node, all);
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getNodes, getIntersectingNodes, setNodes],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const modalOpen =
        editingId ||
        exportOpen ||
        codexOpen ||
        trashOpen ||
        helpOpen ||
        paletteOpen ||
        !!pendingEdgeDelete ||
        !!pendingCardDrop;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.key.toLowerCase() === 'g'
      ) {
        if (modalOpen) return;
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        e.preventDefault();
        groupSelectionRef.current();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') {
        if (modalOpen) return;
        const sel = nodesRef.current.find((n) => n.type === 'card' && n.selected);
        if (sel) {
          e.preventDefault();
          const copy = duplicateCard(sel.id);
          if (copy) {
            const p = currentProject(useStore.getState());
            if (p) {
              setNodes((nds) => [...nds, toCardNode(copy, p.groups, p.codex, isDimmed(copy))]);
            }
          }
        }
      }
      if (e.key === 'Escape') setCtx(null);
      // Deshacer / rehacer globales (si el foco está en un campo de texto,
      // se deja el deshacer nativo del navegador).
      if ((e.metaKey || e.ctrlKey) && !e.altKey) {
        const t = e.target as HTMLElement | null;
        const typing =
          !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) {
          if (typing) return;
          e.preventDefault();
          useStore.getState().undo();
          return;
        }
        if (k === 'y' || (k === 'z' && e.shiftKey)) {
          if (typing) return;
          e.preventDefault();
          useStore.getState().redo();
          return;
        }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [
    editingId,
    exportOpen,
    codexOpen,
    trashOpen,
    helpOpen,
    paletteOpen,
    pendingEdgeDelete,
    pendingCardDrop,
    duplicateCard,
    setNodes,
    isDimmed,
  ]);

  function liveProject(): NonNullable<ReturnType<typeof currentProject>> | null {
    return currentProject(useStore.getState());
  }

  function addCardAt(x: number, y: number) {
    const card = addCard(x, y);
    if (!card) return;
    const p = liveProject();
    if (p) setNodes((nds) => [...nds, toCardNode(card, p.groups, p.codex, isDimmed(card))]);
    setEditingId(card.id);
  }

  function addCardCenter() {
    const pos = screenToFlowPosition({
      x: window.innerWidth / 2 + (Math.random() - 0.5) * 200,
      y: window.innerHeight / 2 + (Math.random() - 0.5) * 200,
    });
    addCardAt(pos.x, pos.y);
  }

  /* Idea del composer: aparece justo encima del composer y halada hacia el
     centro del lienzo; se elige la posición menos concurrida de un puñado de
     candidatas muy próximas. */
  function createIdea(text: string, originScreen: { x: number; y: number }) {
    const origin = screenToFlowPosition(originScreen);
    const center = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    // Punto de partida: encima del composer, tirando 30% hacia el centro.
    const base = {
      x: origin.x + (center.x - origin.x) * 0.3,
      y: origin.y - 220,
    };
    const busy = nodes
      .filter((n) => n.type === 'card')
      .map((n) => ({ x: n.position.x, y: n.position.y }));
    let best = { x: base.x, y: base.y, score: -1 };
    for (let i = 0; i < 12; i++) {
      const x = base.x + (Math.random() - 0.5) * 340;
      const y = base.y + (Math.random() - 0.5) * 150;
      const score = busy.length
        ? Math.min(...busy.map((c) => Math.hypot(c.x - x, c.y - y)))
        : 999;
      if (score > best.score) best = { x, y, score };
    }
    const card = addIdea(best.x, best.y, text);
    if (!card) return;
    const p = liveProject();
    if (!p) return;
    const node = toCardNode(card, p.groups, p.codex, isDimmed(card));
    node.data = { ...node.data, fresh: true, dx: origin.x - best.x, dy: origin.y - best.y };
    setNodes((nds) => [...nds, node]);
    /* La animación sg-deal transforma el nodo mientras xyflow mide los
       handles: re-medimos al terminar para que las líneas no queden
       desplazadas (antes solo se corregían al recargar). */
    window.setTimeout(() => updateNodeInternals(card.id), 950);
    window.setTimeout(() => {
      setNodes((nds) => nds.map((n) => (n.id === card.id ? { ...n, data: { ...n.data, fresh: false } } : n)));
    }, 1500);
  }

  function flashNotice(message: string) {
    setNotice(message);
    window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(''), 2800);
  }

  function markGroupFresh(groupId: string) {
    freshGroupsRef.current.add(groupId);
    window.setTimeout(() => {
      freshGroupsRef.current.delete(groupId);
      setNodes((nds) =>
        nds.map((n) =>
          n.id === groupNodeId(groupId) && n.data.fresh
            ? { ...n, data: { ...n.data, fresh: false } }
            : n,
        ),
      );
    }, 1600);
  }

  function groupHandlersFor(g: Group, cardCount: number, fresh: boolean) {
    return {
      cardCount,
      fresh,
      onRename: (name: string) => updateGroup(g.id, { name }),
      onResizeEnd: (rect: { x: number; y: number; width: number; height: number }) =>
        handleGroupResize(g.id, rect),
      onToggleLock: () => updateGroup(g.id, { locked: !g.locked }),
      onToggleCollapse: () => updateGroup(g.id, { collapsed: g.collapsed !== true }),
    };
  }

  function groupSelectedCards() {
    const all = nodesRef.current;
    const selected = all.filter((n) => n.type === 'card' && n.selected);
    if (selected.length === 0) {
      addGroupCenter();
      return;
    }
    const eligible = selected.filter((n) => {
      const card = (n.data as { card?: Card } | undefined)?.card;
      return !!card && !card.deletedAt && !card.groupId;
    });
    if (eligible.length === 0) {
      flashNotice('Las tarjetas seleccionadas ya están en un grupo.');
      return;
    }

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    const positions = new Map<string, { x: number; y: number }>();
    for (const node of eligible) {
      const abs = absOf(node, all);
      const card = (node.data as { card: Card }).card;
      const width = node.measured?.width ?? 220;
      const height = node.measured?.height ?? (card.type === 'start' ? 40 : 120);
      positions.set(node.id, abs);
      minX = Math.min(minX, abs.x);
      minY = Math.min(minY, abs.y);
      maxX = Math.max(maxX, abs.x + width);
      maxY = Math.max(maxY, abs.y + height);
    }

    const padX = 28;
    const padTop = 46;
    const padBottom = 28;
    const rect = {
      x: minX - padX,
      y: minY - padTop,
      width: maxX - minX + padX * 2,
      height: maxY - minY + padTop + padBottom,
    };
    const ids = new Set(eligible.map((n) => n.id));
    const g = createGroupFromCards([...ids], rect);
    if (!g) return;

    const groupNode: Node = {
      ...toGroupNode(g, groupHandlersFor(g, eligible.length, true)),
      selected: true,
    };
    setNodes((nds) => {
      const next = nds.map((n) => {
        if (ids.has(n.id)) {
          const abs = positions.get(n.id) ?? absOf(n, nds);
          return {
            ...n,
            parentId: groupNodeId(g.id),
            extent: 'parent' as const,
            position: { x: abs.x - rect.x, y: abs.y - rect.y },
            selected: false,
          };
        }
        return n;
      });
      return [groupNode, ...next];
    });
    markGroupFresh(g.id);
    if (eligible.length < selected.length) {
      flashNotice('Se agruparon solo las tarjetas que no pertenecían a otro grupo.');
    }
  }

  groupSelectionRef.current = groupSelectedCards;

  function addGroupCenter() {
    const pos = screenToFlowPosition({ x: window.innerWidth / 2 - 160, y: window.innerHeight / 2 - 110 });
    const g = addGroup(pos.x, pos.y);
    if (!g) return;
    markGroupFresh(g.id);
    setNodes((nds) => [
      ...nds,
      toGroupNode(g, groupHandlersFor(g, 0, true)),
    ]);
  }

  const jumpTo = useCallback(
    (cardId: string) => {
      const p = liveProject();
      const card = p?.cards.find((c) => c.id === cardId);
      if (!card) return;
      setCenter(card.x + 110, card.y + 60, { zoom: 1.1, duration: 300 });
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === cardId })));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setCenter, setNodes],
  );

  const jumpToGroup = useCallback(
    (groupId: string) => {
      const p = liveProject();
      const group = p?.groups.find((g) => g.id === groupId);
      if (!group) return;
      const width = group.collapsed ? Math.min(group.width, GROUP_COLLAPSED_WIDTH) : group.width;
      const height = group.collapsed ? GROUP_COLLAPSED_HEIGHT : group.height;
      setCenter(group.x + width / 2, group.y + height / 2, { zoom: 1.1, duration: 300 });
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === groupNodeId(groupId) })));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [setCenter, setNodes],
  );

  function toggleTag(t: string) {
    setActiveTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  function openCodex(entryId: string | null) {
    setEditingId(null);
    setCodexSelected(entryId);
    setCodexOpen(true);
  }

  if (!project) return null;
  const editingCard = editingId ? cards.find((c) => c.id === editingId) ?? null : null;
  const ctxNode = ctx && 'nodeId' in ctx ? nodes.find((n) => n.id === ctx.nodeId) ?? null : null;
  const ctxCard = ctxNode?.type === 'card'
    ? (ctxNode.data as unknown as { card: Card }).card
    : null;
  const ctxGroup = ctxNode?.type === 'group'
    ? (ctxNode.data as unknown as { group: Group }).group
    : null;

  function paintCard(id: string, patch: Partial<Card>) {
    updateCard(id, patch);
    refreshCardNode(id);
  }

  return (
    <div
      className="board"
      onDoubleClick={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest('.react-flow__node') || t.closest('.react-flow__edge')) return;
        if (!t.closest('.react-flow__pane')) return;
        const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        addCardAt(pos.x, pos.y);
      }}
    >
      <div className="toolbar">
        <button className="btn btn-icon" title="Volver a proyectos" onClick={() => openProject(null)}>
          <ArrowLeft size={18} />
        </button>
        {nameDraft === null ? (
          <button className="project-name" onClick={() => setNameDraft(project.name)}>
            {project.name}
          </button>
        ) : (
          <input
            autoFocus
            className="input project-name-input"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => {
              if (nameDraft.trim() && nameDraft !== project.name) renameProject(project.id, nameDraft);
              setNameDraft(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setNameDraft(null);
            }}
            aria-label="Nombre del proyecto"
          />
        )}
        <span className="toolbar-spacer" />
        {loopWarn && <span className="warn">Esa conexión crearía un ciclo</span>}
        {notice && <span className="warn">{notice}</span>}
        <button
          className="btn btn-icon toolbar-search"
          title={activeTags.length > 0 ? `Buscar (${activeTags.length} filtros)` : 'Buscar (Ctrl+K)'}
          onClick={() => setPaletteOpen(true)}
        >
          <Search size={18} />
          {activeTags.length > 0 && <span className="toolbar-search-badge">{activeTags.length}</span>}
        </button>
        <button className="btn btn-secondary" onClick={addCardCenter}>
          <Plus size={16} /> Tarjeta
        </button>
        <button
          className="btn btn-secondary"
          title={
            groupableSelectedCards.length > 0
              ? `Agrupar ${groupableSelectedCards.length} tarjeta${groupableSelectedCards.length === 1 ? '' : 's'} seleccionada${groupableSelectedCards.length === 1 ? '' : 's'} (Ctrl+G)`
              : 'Añadir grupo'
          }
          onClick={groupSelectedCards}
        >
          <GroupIcon size={16} /> Grupo
          {groupableSelectedCards.length > 0 && <span className="btn-count">{groupableSelectedCards.length}</span>}
        </button>
        <button className="btn btn-secondary" title="Codex de historia" onClick={() => openCodex(null)}>
          <BookOpen size={16} /> Codex
        </button>
        <button className="btn btn-secondary" title="Vista grafo" onClick={() => setGraphOpen(true)}>
          <Network size={16} /> Grafo
        </button>
        <button className="btn btn-primary" onClick={() => setExportOpen(true)}>
          <FileDown size={16} /> Vista previa
        </button>
        <button className="btn btn-icon" title="Deshacer (Ctrl+Z)" onClick={undo} disabled={!canUndo}>
          <Undo2 size={18} />
        </button>
        <button className="btn btn-icon" title="Rehacer (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo}>
          <Redo2 size={18} />
        </button>
        <div className="seg" role="group" aria-label="Tema">
          <span className="seg-thumb" style={{ transform: `translateX(${theme === 'dark' ? 100 : 0}%)` }} />
          <button className={theme === 'light' ? 'on' : ''} onClick={() => theme === 'dark' && toggleTheme()}>
            Claro
          </button>
          <button className={theme === 'dark' ? 'on' : ''} onClick={() => theme === 'light' && toggleTheme()}>
            Oscuro
          </button>
        </div>
        <div className="seg" role="group" aria-label="Estilo de superficie" title="Estilo de superficie">
          <span className="seg-thumb" style={{ transform: `translateX(${glass === 'liquid' ? 100 : 0}%)` }} />
          <button className={glass === 'normal' ? 'on' : ''} onClick={() => setGlass('normal')}>
            Normal
          </button>
          <button className={glass === 'liquid' ? 'on' : ''} onClick={() => setGlass('liquid')}>
            Liquid glass
          </button>
        </div>
        <div className="seg-wrap">
          <span className="seg-label">Hilos</span>
          <div className="seg" role="group" aria-label="Estilo de hilos" title="Estilo de hilos">
            <span className="seg-thumb" style={{ transform: `translateX(${linkStyle === 'prototipo' ? 100 : 0}%)` }} />
            <button className={linkStyle === 'anclado' ? 'on' : ''} onClick={() => setLinkStyle('anclado')}>
              Anclado
            </button>
            <button className={linkStyle === 'prototipo' ? 'on' : ''} onClick={() => setLinkStyle('prototipo')}>
              Prototipo
            </button>
          </div>
        </div>
        <button className="btn btn-icon" title="Papelera" onClick={() => setTrashOpen(true)}>
          <Trash size={18} />
          {trashedCount > 0 && <span className="badge">{trashedCount}</span>}
        </button>
        <button className="btn btn-icon" title="Ayuda" onClick={() => setHelpOpen(true)}>
          <CircleQuestionMark size={18} />
        </button>
      </div>

      <svg className="sg-defs" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="sg-edge-grad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#8a76ff" />
            <stop offset="100%" stopColor="#25bfb2" />
          </linearGradient>
          <marker
            id="sg-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#25bfb2" />
          </marker>
        </defs>
      </svg>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionLineComponent={linkStyle === 'prototipo' ? PrototypeConnectionLine : undefined}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        connectionMode={ConnectionMode.Loose}
        connectionRadius={32}
        onNodesDelete={onNodesDelete}
        onEdgesDelete={onEdgesDelete}
        onBeforeDelete={onBeforeDelete}
        onNodeDragStop={onNodeDragStop}
        onNodeDoubleClick={(_, node) => {
          if (node.type === 'card') setEditingId(node.id);
        }}
        onNodeContextMenu={(e, node) => {
          e.preventDefault();
          setCtx({ x: e.clientX, y: e.clientY, nodeId: node.id });
        }}
        onEdgeContextMenu={(e, edge) => {
          e.preventDefault();
          if (edge.id.startsWith(SUMMARY_PREFIX)) {
            flashNotice('Despliega el grupo para editar sus conexiones.');
            return;
          }
          setCtx({ x: e.clientX, y: e.clientY, edgeId: edge.id });
        }}
        onEdgeDoubleClick={(e, edge) => {
          e.preventDefault();
          if (edge.id.startsWith(SUMMARY_PREFIX)) {
            flashNotice('Despliega el grupo para editar sus conexiones.');
            return;
          }
          requestDeleteEdges([edge.id]);
        }}
        onPaneClick={() => setCtx(null)}
        onMoveStart={() => setCtx(null)}
        onNodeDragStart={(e, node) => {
          setCtx(null);
          altDragRef.current = e.altKey && node.type === 'card';
        }}
        defaultEdgeOptions={{ type: 'thread', animated: true }}
        deleteKeyCode={['Backspace', 'Delete']}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
        zoomOnDoubleClick={false}
        minZoom={0.2}
        maxZoom={2.5}
        fitView
        colorMode={theme}
      >
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => {
            const d = n.data as unknown as { card?: Card; group?: Group } | undefined;
            return d?.card?.color ?? d?.group?.color ?? '#888';
          }}
        />
      </ReactFlow>

      <IdeaComposer onCreate={createIdea} />

      {ctx && (
        <div className="ctx-menu" style={{ left: ctx.x, top: ctx.y }} onClick={(e) => e.stopPropagation()}>
          {ctxCard && ctxCard.type === 'start' && (
            <button className="ctx-item" disabled>Punto de inicio</button>
          )}
          {ctxCard && ctxCard.type !== 'start' && (
            <>
              <button
                className="ctx-item"
                onClick={() => { setEditingId(ctxCard.id); setCtx(null); }}
              >
                <SquarePen size={14} /> Editar
              </button>
              <button
                className="ctx-item"
                onClick={() => {
                  const copy = duplicateCard(ctxCard.id);
                  const p = liveProject();
                  if (copy && p) setNodes((nds) => [...nds, toCardNode(copy, p.groups, p.codex, isDimmed(copy))]);
                  setCtx(null);
                }}
              >
                <Copy size={14} /> Duplicar
              </button>
              {ctxNode?.selected === true && groupableSelectedCards.length > 0 && (
                <button
                  className="ctx-item"
                  onClick={() => { groupSelectedCards(); setCtx(null); }}
                >
                  <GroupIcon size={14} /> Agrupar {groupableSelectedCards.length} seleccionada{groupableSelectedCards.length === 1 ? '' : 's'}
                </button>
              )}
              <div className="ctx-label">Color</div>
              <div className="ctx-swatches">
                {CARD_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`swatch${ctxCard.color === c ? ' active' : ''}`}
                    style={{ background: c }}
                    aria-label={c}
                    onClick={() => { paintCard(ctxCard.id, { color: c }); setCtx(null); }}
                  />
                ))}
                <label
                  className={`swatch swatch-custom${CARD_COLORS.includes(ctxCard.color) ? '' : ' active'}`}
                  title="Color personalizado"
                >
                  <input
                    type="color"
                    value={ctxCard.color}
                    onChange={(e) => paintCard(ctxCard.id, { color: e.target.value.toUpperCase() })}
                  />
                </label>
              </div>
              <div className="ctx-label">Icono</div>
              <div className="ctx-icons">
                <button
                  className={`icon-btn${!ctxCard.icon ? ' active' : ''}`}
                  title="Sin icono"
                  onClick={() => { paintCard(ctxCard.id, { icon: null }); setCtx(null); }}
                >
                  <Ban size={15} />
                </button>
                {CARD_ICONS.map(({ key, label }) => {
                  const Icon = iconFor(key);
                  if (!Icon) return null;
                  return (
                    <button
                      key={key}
                      className={`icon-btn${ctxCard.icon === key ? ' active' : ''}`}
                      title={label}
                      onClick={() => { paintCard(ctxCard.id, { icon: key }); setCtx(null); }}
                    >
                      <Icon size={15} />
                    </button>
                  );
                })}
              </div>
              {degreeOf(ctxCard.id, project.connections) > 0 && (
                <button
                  className="ctx-item"
                  onClick={() => {
                    const ids = project.connections
                      .filter((cn) => cn.source === ctxCard.id || cn.target === ctxCard.id)
                      .map((cn) => cn.id);
                    setCtx(null);
                    requestDeleteEdges(ids, ctxCard.id);
                  }}
                >
                  Quitar del flujo
                </button>
              )}
              {ctxCard.groupId && (
                <button
                  className="ctx-item"
                  onClick={() => {
                    setCardGroup(ctxCard.id, null);
                    const fresh = currentProject(useStore.getState())?.cards.find((c) => c.id === ctxCard.id);
                    const abs = fresh ? { x: fresh.x, y: fresh.y } : { x: ctxCard.x, y: ctxCard.y };
                    setNodes((nds) =>
                      nds.map((n) =>
                        n.id === ctxCard.id ? { ...n, parentId: undefined, extent: undefined, position: abs } : n,
                      ),
                    );
                    setCtx(null);
                  }}
                >
                  Quitar del grupo
                </button>
              )}
              <div className="ctx-sep" />
              <button
                className="ctx-item danger"
                onClick={() => {
                  trashCard(ctxCard.id);
                  setNodes((nds) => nds.filter((n) => n.id !== ctxCard.id));
                  syncEdges();
                  setCtx(null);
                }}
              >
                <Trash size={14} /> Eliminar
              </button>
            </>
          )}
          {ctxGroup && (
            <>
              <button
                className="ctx-item"
                onClick={() => {
                  updateGroup(ctxGroup.id, { collapsed: ctxGroup.collapsed !== true });
                  setCtx(null);
                }}
              >
                {ctxGroup.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                {ctxGroup.collapsed ? ' Desplegar grupo' : ' Plegar grupo'}
              </button>
              <button
                className="ctx-item"
                onClick={() => {
                  const name = window.prompt('Nombre del grupo', ctxGroup.name);
                  if (name && name.trim()) updateGroup(ctxGroup.id, { name: name.trim() });
                  setCtx(null);
                }}
              >
                <SquarePen size={14} /> Renombrar
              </button>
              <div className="ctx-label">Color</div>
              <div className="ctx-swatches">
                {GROUP_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`swatch${ctxGroup.color === c ? ' active' : ''}`}
                    style={{ background: c }}
                    aria-label={c}
                    onClick={() => { updateGroup(ctxGroup.id, { color: c }); setCtx(null); }}
                  />
                ))}
              </div>
              <button
                className="ctx-item"
                onClick={() => { updateGroup(ctxGroup.id, { locked: !ctxGroup.locked }); setCtx(null); }}
              >
                {ctxGroup.locked ? <Unlock size={14} /> : <Lock size={14} />}
                {ctxGroup.locked ? ' Desbloquear posición' : ' Bloquear posición'}
              </button>
              <button
                className="ctx-item"
                onClick={() => {
                  const gid = ctxGroup.id;
                  ungroupAll(gid);
                  setNodes((nds) =>
                    nds.map((n) => {
                      if (n.parentId !== groupNodeId(gid)) return n;
                      const abs = absOf(n, nodesRef.current);
                      return { ...n, parentId: undefined, extent: undefined, position: abs };
                    }),
                  );
                  setCtx(null);
                }}
              >
                Desagrupar todo
              </button>
              <div className="ctx-sep" />
              <button
                className="ctx-item danger"
                onClick={() => {
                  if (window.confirm('¿Eliminar el grupo? Las tarjetas se quedan en el tablero.')) {
                    const gid = ctxGroup.id;
                    deleteGroup(gid, true);
                    setNodes((nds) =>
                      nds
                        .filter((n) => n.id !== groupNodeId(gid))
                        .map((n) => {
                          if (n.parentId !== groupNodeId(gid)) return n;
                          const abs = absOf(n, nodesRef.current);
                          return { ...n, parentId: undefined, extent: undefined, position: abs };
                        }),
                    );
                    syncEdges();
                  }
                  setCtx(null);
                }}
              >
                <Trash size={14} /> Eliminar grupo
              </button>
            </>
          )}
          {ctx && 'edgeId' in ctx && (
            <button
              className="ctx-item danger"
              onClick={() => {
                requestDeleteEdges([ctx.edgeId]);
                setCtx(null);
              }}
            >
              <Trash size={14} /> Eliminar conexión
            </button>
          )}
        </div>
      )}

      {editingCard && (
        <CardEditor
          key={editingCard.id}
          cardId={editingCard.id}
          onClose={() => setEditingId(null)}
          onOpenCodexEntry={openCodex}
          onChanged={() => refreshCardNode(editingCard.id)}
          onDuplicated={(copy) => {
            const p = liveProject();
            if (p) setNodes((nds) => [...nds, toCardNode(copy, p.groups, p.codex, isDimmed(copy))]);
          }}
          onFlowChanged={() => syncEdges()}
          onRequestRemoveFromFlow={(id) => {
            const p = liveProject();
            if (!p) return;
            const ids = p.connections
              .filter((cn) => cn.source === id || cn.target === id)
              .map((cn) => cn.id);
            requestDeleteEdges(ids, id);
          }}
        />
      )}
      {pendingCardDrop && (
        <ConfirmCardDropModal
          action={pendingCardDrop}
          onCancel={() => setPendingCardDrop(null)}
          onConfirm={confirmPendingCardDrop}
        />
      )}
      {pendingEdgeDelete && pendingConnections.length > 0 && (
        <ConfirmDeleteConnectionsModal
          connections={pendingConnections}
          cardName={pendingCardName}
          onCancel={() => setPendingEdgeDelete(null)}
          onConfirm={confirmPendingEdgeDelete}
        />
      )}
      {codexOpen && (
        <CodexModal initialId={codexSelected} onClose={() => setCodexOpen(false)} onJump={jumpTo} />
      )}
      {exportOpen && <ExportModal onClose={() => setExportOpen(false)} />}
      {trashOpen && (
        <TrashPanel
          onClose={() => setTrashOpen(false)}
          onRestored={(id) => {
            const p = liveProject();
            const c = p?.cards.find((x) => x.id === id);
            if (c && p) {
              restoreCard(id);
              setNodes((nds) => [...nds.filter((n) => n.id !== id), toCardNode({ ...c, deletedAt: null }, p.groups, p.codex, isDimmed({ ...c, deletedAt: null }))]);
            }
          }}
        />
      )}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      {paletteOpen && (
        <SearchPalette
          onJump={jumpTo}
          onClose={() => setPaletteOpen(false)}
          activeTags={activeTags}
          onToggleTag={toggleTag}
          onClearTags={() => setActiveTags([])}
        />
      )}
      {graphOpen && (
        <GraphView
          onClose={() => setGraphOpen(false)}
          onJumpCard={(id) => { setGraphOpen(false); jumpTo(id); }}
          onJumpGroup={(id) => { setGraphOpen(false); jumpToGroup(id); }}
          onOpenCodex={(id) => { setGraphOpen(false); openCodex(id); }}
          onConnectNodes={(a: GraphEndpoint, b: GraphEndpoint) => {
            const p = liveProject();
            if (!p) return 'self';
            const source = a.kind === 'group' ? groupNodeId(a.id) : a.id;
            const target = b.kind === 'group' ? groupNodeId(b.id) : b.id;
            if (source === target) return 'self';
            if (p.connections.some((cn) => cn.source === source && cn.target === target)) return 'dup';
            if (
              a.kind === 'card' &&
              b.kind === 'card' &&
              wouldCreateLoop(source, target, p.connections)
            ) {
              return 'loop';
            }
            addConnection(source, target);
            return 'ok';
          }}
        />
      )}
    </div>
  );
}

/* ---------------- app ---------------- */

function Shell() {
  const currentId = useStore((s) => s.currentId);
  const project = useStore((s) =>
    s.currentId ? s.projects.find((p) => p.id === s.currentId) ?? null : null,
  );
  if (!currentId || !project) return <ProjectsPage />;
  return <Board key={project.id} projectId={project.id} />;
}

export default function App() {
  const theme = useStore((s) => s.theme);
  const style = useStore((s) => s.style);
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('data-style', style);
  }, [theme, style]);
  return (
    <ReactFlowProvider>
      <div className="backdrop" aria-hidden="true">
        <svg className="liquid-filter" focusable="false">
          <filter id="liquid" x="-10%" y="-10%" width="120%" height="120%">
            <feTurbulence type="fractalNoise" baseFrequency="0.012 0.018" numOctaves="2" seed="4" result="n" />
            <feGaussianBlur in="n" stdDeviation="2" result="nb" />
            <feDisplacementMap in="SourceGraphic" in2="nb" scale="38" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </svg>
        <div className="bg-gradient" />
        <div className="blob blob-a" />
        <div className="blob blob-b" />
        <div className="blob blob-c" />
        <div className="canvas-grid" />
      </div>
      <Shell />
    </ReactFlowProvider>
  );
}
