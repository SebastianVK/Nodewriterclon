import { useEffect, useRef } from 'react';

export interface ConnectionLabel {
  source: string;
  target: string;
}

/* Confirmación para borrados directos de conexiones.
   Cubre arista única, selección múltiple y “Quitar del flujo”. */
export default function ConfirmDeleteConnectionsModal({
  connections,
  cardName,
  onCancel,
  onConfirm,
}: {
  connections: ConnectionLabel[];
  /** Si viene de “Quitar del flujo”, nombre de la tarjeta. */
  cardName?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const count = connections.length;
  const visible = connections.slice(0, 6);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  const title = cardName
    ? 'Quitar del flujo'
    : count === 1
      ? 'Eliminar conexión'
      : `Eliminar ${count} conexiones`;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="modal modal-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-connections-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="confirm-connections-title">{title}</h2>
          <button className="btn btn-icon" onClick={onCancel} aria-label="Cerrar">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p>
            {cardName ? (
              <>
                Se eliminarán todas las conexiones de <strong>{cardName}</strong>.
              </>
            ) : count === 1 ? (
              '¿Seguro que quieres eliminar esta conexión?'
            ) : (
              `¿Seguro que quieres eliminar estas ${count} conexiones?`
            )}
          </p>
          <ul className="conn-delete-list">
            {visible.map((c, i) => (
              <li key={`${c.source}-${c.target}-${i}`}>
                <span className="conn-name" title={c.source}>{c.source}</span>
                <span className="conn-arrow">→</span>
                <span className="conn-name" title={c.target}>{c.target}</span>
              </li>
            ))}
            {count > visible.length && (
              <li className="conn-more">y {count - visible.length} más…</li>
            )}
          </ul>
          <p className="muted">Podrás deshacerlo con Ctrl+Z.</p>
        </div>
        <div className="modal-footer">
          <button ref={cancelRef} className="btn btn-secondary" onClick={onCancel}>
            Cancelar
          </button>
          <button className="btn btn-danger-solid" onClick={onConfirm}>
            Eliminar
          </button>
        </div>
      </div>
    </div>
  );
}
