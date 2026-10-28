import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Flag } from 'lucide-react';
import type { Card, CodexEntry } from './types';
import { CODEX_TYPES, cardTags, wordCount } from './types';
import { cardText, findMentions } from './mentions';
import { iconFor } from './icons';

export interface CardNodeData extends Record<string, unknown> {
  card: Card;
  codex: CodexEntry[];
  dimmed: boolean;
  /** Recién creada por el composer: animación de entrada (deal). */
  fresh?: boolean;
  dx?: number;
  dy?: number;
}

const MAX_TAGS = 3;

function CardNodeComponent({ data, selected }: NodeProps) {
  const { card, codex, dimmed, fresh, dx = 0, dy = 0 } = data as unknown as CardNodeData;
  if (card.type === 'start') {
    return (
      <div className="card-node card-start">
        <Handle type="target" position={Position.Left} style={{ visibility: 'hidden' }} />
        <Flag size={16} />
        <span>Start</span>
        <Handle type="source" position={Position.Right} />
      </div>
    );
  }
  const tags = cardTags(card.tags);
  const words = wordCount(card.content);
  const mentionIds = findMentions(cardText(card), codex);
  const mentioned = codex.filter((e) => mentionIds.includes(e.id));
  const Icon = iconFor(card.icon);
  const badgeType = mentioned[0];
  const badgeLabel = badgeType
    ? CODEX_TYPES.find((t) => t.key === badgeType.type)?.label ?? badgeType.type
    : null;
  return (
    <div
      className={`card-node${selected ? ' selected' : ''}${dimmed ? ' dimmed' : ''}${fresh ? ' fresh' : ''}`}
      style={{ ['--card-color' as string]: card.color, ['--dx' as string]: `${dx}px`, ['--dy' as string]: `${dy}px` }}
      onPointerMove={(e) => {
        const el = e.currentTarget;
        const r = el.getBoundingClientRect();
        el.style.setProperty('--mx', `${e.clientX - r.left}px`);
        el.style.setProperty('--my', `${e.clientY - r.top}px`);
      }}
    >
      <div className="card-shine" />
      <Handle type="target" position={Position.Left} />
      <div className="card-bar" />
      <div className="card-body">
        {badgeLabel && (
          <span className={`card-type type-${badgeType.type}`}>{badgeLabel}</span>
        )}
        <div className="card-head">
          {Icon && (
            <span className="card-icon">
              <Icon size={13} />
            </span>
          )}
          <p className="card-title">{card.title.trim() || 'Nueva tarjeta'}</p>
        </div>
        {card.summary && <p className="card-summary">{card.summary}</p>}
        {tags.length > 0 && (
          <div className="card-tags">
            {tags.slice(0, MAX_TAGS).map((t) => (
              <span key={t} className="card-tag">{t}</span>
            ))}
            {tags.length > MAX_TAGS && (
              <span className="card-tag more">+{tags.length - MAX_TAGS}</span>
            )}
          </div>
        )}
        <div className="card-meta">
          {words > 0 && <span className="card-words">{words} palabras</span>}
          {mentioned.map((m) => {
            const MentionIcon = iconFor(m.icon);
            return MentionIcon ? (
              <span key={m.id} className="mention-dot mention-icon" style={{ color: m.color }} title={m.name}>
                <MentionIcon size={12} />
              </span>
            ) : (
              <span key={m.id} className="mention-dot" style={{ background: m.color }} title={m.name} />
            );
          })}
        </div>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const CardNode = memo(CardNodeComponent);
export default CardNode;
