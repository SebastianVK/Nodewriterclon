import { useEffect, useRef } from 'react';

export type CardDropAction =
  | {
      kind: 'insert';
      connectionId: string;
      cardId: string;
      cardName: string;
      sourceName: string;
      targetName: string;
    }
  | {
      kind: 'connect';
      sourceId: string;
      targetId: string;
      cardName: string;
      otherName: string;
    };

/* Confirmación al soltar una tarjeta sobre una conexión o cerca de otra
   tarjeta. Sustituye los window.confirm del arrastre por un modal propio. */
export default function ConfirmCardDropModal({
  action,
  onCancel,
  onConfirm,
}: {
  action: CardDropAction;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

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

  const title = action.kind === 'insert' ? 'Insertar en la conexión' : 'Crear conexión';

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
        aria-labelledby="confirm-card-drop-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id="confirm-card-drop-title">{title}</h2>
          <button className="btn btn-icon" onClick={onCancel} aria-label="Cerrar">
            ✕
          </button>
        </div>
        <div className="modal-body">
          {action.kind === 'insert' ? (
            <>
              <p>La tarjeta se insertará entre estas dos tarjetas:</p>
              <div className="drop-chain">
                <span className="conn-name" title={action.sourceName}>
                  {action.sourceName}
                </span>
                <span className="conn-arrow">→</span>
                <span className="drop-chain-card" title={action.cardName}>
                  {action.cardName}
                </span>
                <span className="conn-arrow">→</span>
                <span className="conn-name" title={action.targetName}>
                  {action.targetName}
                </span>
              </div>
              <p className="muted">
                La conexión actual se dividirá en dos. Podrás deshacerlo con Ctrl+Z.
              </p>
            </>
          ) : (
            <>
              <p>Se creará una conexión directa entre estas tarjetas:</p>
              <div className="drop-chain">
                <span className="conn-name" title={action.otherName}>
                  {action.otherName}
                </span>
                <span className="conn-arrow">→</span>
                <span className="drop-chain-card" title={action.cardName}>
                  {action.cardName}
                </span>
              </div>
              <p className="muted">Podrás deshacerlo con Ctrl+Z.</p>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button ref={cancelRef} className="btn btn-secondary" onClick={onCancel}>
            Cancelar
          </button>
          <button className="btn btn-primary" onClick={onConfirm}>
            {action.kind === 'insert' ? 'Insertar' : 'Conectar'}
          </button>
        </div>
      </div>
    </div>
  );
}
