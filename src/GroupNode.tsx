import { memo, useState } from 'react';
import { NodeResizer, type NodeProps } from '@xyflow/react';
import { Lock, Unlock, Pencil } from 'lucide-react';
import type { Group } from './types';

export interface GroupNodeData extends Record<string, unknown> {
  group: Group;
  onRename: (name: string) => void;
  onResizeEnd: (rect: { x: number; y: number; width: number; height: number }) => void;
  onToggleLock: () => void;
}

function hexToRgba(hex: string, alpha: number): string {
  const h = (hex || '').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n) || full.length !== 6) return `rgba(148, 163, 184, ${alpha})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function GroupNodeComponent({ data, selected }: NodeProps) {
  const { group, onRename, onResizeEnd, onToggleLock } = data as unknown as GroupNodeData;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.name);

  function commit() {
    setEditing(false);
    const name = draft.trim();
    if (name && name !== group.name) onRename(name);
    else setDraft(group.name);
  }

  return (
    <div
      className={`group-node${group.locked ? ' locked' : ''}`}
      style={{ borderColor: group.color, background: hexToRgba(group.color, 0.07) }}
    >
      <NodeResizer
        color={group.color}
        isVisible={selected && !group.locked}
        minWidth={220}
        minHeight={160}
        onResizeEnd={(_, params) => onResizeEnd(params)}
      />
      <div className="group-header nodrag" style={{ borderColor: group.color }}>
        {editing ? (
          <input
            autoFocus
            className="group-name-input"
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
        {!editing && (
          <button
            type="button"
            className="group-icon-btn"
            title="Renombrar"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => { setDraft(group.name); setEditing(true); }}
          >
            <Pencil size={11} />
          </button>
        )}
        <button
          type="button"
          className="group-icon-btn"
          title={group.locked ? 'Desbloquear posición' : 'Bloquear posición'}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onToggleLock}
        >
          {group.locked ? <Lock size={11} /> : <Unlock size={11} />}
        </button>
      </div>
    </div>
  );
}

const GroupNode = memo(GroupNodeComponent);
export default GroupNode;
