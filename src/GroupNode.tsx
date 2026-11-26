import { memo, useState } from 'react';
import {
  Handle,
  NodeResizer,
  Position,
  type NodeProps,
} from '@xyflow/react';
import {
  ChevronDown,
  ChevronRight,
  Lock,
  Pencil,
  Unlock,
} from 'lucide-react';
import type { Group } from './types';

export interface GroupNodeData extends Record<string, unknown> {
  group: Group;
  cardCount: number;
  fresh?: boolean;
  onRename: (name: string) => void;
  onResizeEnd: (rect: { x: number; y: number; width: number; height: number }) => void;
  onToggleLock: () => void;
  onToggleCollapse: () => void;
}

function hexToRgba(hex: string, alpha: number): string {
  const h = (hex || '').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n) || full.length !== 6) return `rgba(148, 163, 184, ${alpha})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/* Igual que las tarjetas: cuatro handles invisibles para conectar el grupo. */
function GroupHandles() {
  return (
    <>
      <Handle id="t" type="source" position={Position.Top} />
      <Handle id="r" type="source" position={Position.Right} />
      <Handle id="b" type="source" position={Position.Bottom} />
      <Handle id="l" type="source" position={Position.Left} />
    </>
  );
}

function GroupNodeComponent({ data, selected }: NodeProps) {
  const {
    group,
    cardCount,
    fresh,
    onRename,
    onResizeEnd,
    onToggleLock,
    onToggleCollapse,
  } = data as unknown as GroupNodeData;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.name);
  const collapsed = group.collapsed === true;

  function commit() {
    setEditing(false);
    const name = draft.trim();
    if (name && name !== group.name) onRename(name);
    else setDraft(group.name);
  }

  return (
    <div
      className={`group-node${group.locked ? ' locked' : ''}${collapsed ? ' collapsed' : ''}${fresh ? ' fresh' : ''}`}
      style={{
        borderColor: group.color,
        background: hexToRgba(group.color, 0.07),
        ['--group-color' as string]: group.color,
      }}
    >
      {!collapsed && (
        <NodeResizer
          color={group.color}
          isVisible={selected && !group.locked}
          minWidth={220}
          minHeight={160}
          onResizeEnd={(_, params) => onResizeEnd(params)}
        />
      )}
      <div className="group-header" style={{ borderColor: group.color }}>
        <button
          type="button"
          className="group-icon-btn group-collapse-btn nodrag"
          title={collapsed ? 'Desplegar grupo' : 'Plegar grupo'}
          aria-label={collapsed ? 'Desplegar grupo' : 'Plegar grupo'}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onToggleCollapse}
        >
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        </button>
        {editing ? (
          <input
            autoFocus
            className="group-name-input nodrag"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') { setDraft(group.name); setEditing(false); }
            }}
            onMouseDown={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="group-name" onDoubleClick={() => { setDraft(group.name); setEditing(true); }}>
            {group.name}
          </span>
        )}
        <span className="group-count" title={`${cardCount} tarjeta${cardCount === 1 ? '' : 's'}`}>
          {cardCount}
        </span>
        {!editing && (
          <button
            type="button"
            className="group-icon-btn nodrag"
            title="Renombrar"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => { setDraft(group.name); setEditing(true); }}
          >
            <Pencil size={11} />
          </button>
        )}
        <button
          type="button"
          className="group-icon-btn nodrag"
          title={group.locked ? 'Desbloquear posición' : 'Bloquear posición'}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onToggleLock}
        >
          {group.locked ? <Lock size={11} /> : <Unlock size={11} />}
        </button>
      </div>
      <GroupHandles />
    </div>
  );
}

const GroupNode = memo(GroupNodeComponent);
export default GroupNode;
