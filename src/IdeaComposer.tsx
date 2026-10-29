import { useEffect, useRef, useState } from 'react';

/* Composer inferior (UI 2.0): píldora "Atrapa una idea" que se expande al
   acercar el cursor. Solo crea la tarjeta en el lienzo; no abre editor ni
   conecta nada. Complementa al botón "+", doble clic y Ctrl+K. */

export interface IdeaComposerProps {
  onCreate: (text: string, origin: { x: number; y: number }) => void;
}

export function IdeaComposer({ onCreate }: IdeaComposerProps) {
  const [active, setActive] = useState(false);
  const [text, setText] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const timerRef = useRef<number | null>(null);

  /* Cierre diferido: al salir del ratón sin texto escrito, espera 1s y
     cierra; si el cursor vuelve (o hay texto) se cancela. */
  const cancelClose = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (!wrapRef.current?.matches(':hover') && !text.trim()) setActive(false);
    }, 1000);
  };

  /* Clic fuera cierra (tarjeta o lienzo vacio: cualquier mousedown fuera).
     Fase capture: xyflow corta la propagacion del mousedown en las tarjetas
     (d3-drag), asi que en bubble nunca llegaria. El texto se conserva. */
  useEffect(() => {
    if (!active) return;
    const close = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        cancelClose();
        setActive(false);
      }
    };
    window.addEventListener('mousedown', close, true);
    return () => window.removeEventListener('mousedown', close, true);
  }, [active]);

  /* Limpieza del temporizador al desmontar. */
  useEffect(() => cancelClose, []);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    const r = wrapRef.current?.getBoundingClientRect();
    onCreate(t, r ? { x: r.left + r.width / 2, y: r.top } : { x: window.innerWidth / 2, y: window.innerHeight - 90 });
    setText('');
    cancelClose();
    setActive(false);
  };

  return (
    <div
      ref={wrapRef}
      className={`composer${active ? ' active' : ''}`}
      onMouseEnter={() => {
        cancelClose();
        setActive(true);
      }}
      onMouseLeave={scheduleClose}
    >
      <div className="prism-border" aria-hidden="true">
        <i />
      </div>
      <div className="composer-inner">
        <div className="composer-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M12 2l1.45 5.55L19 9l-5.55 1.45L12 16l-1.45-5.55L5 9l5.55-1.45L12 2zM19 15l.75 2.25L22 18l-2.25.75L19 21l-.75-2.25L16 18l2.25-.75L19 15z" />
          </svg>
        </div>
        {active ? (
          <div className="composer-input-wrap">
            <textarea
              ref={areaRef}
              autoFocus
              value={text}
              rows={2}
              placeholder="¿Y si…?"
              onChange={(e) => {
                setText(e.target.value);
                /* Si se vacía el texto con el cursor fuera, empezar a cerrar. */
                if (!e.target.value.trim()) scheduleClose();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
                if (e.key === 'Escape') {
                  cancelClose();
                  setActive(false);
                }
              }}
            />
            <div className="composer-footer">
              <span>Enter para añadir · Shift+Enter para una línea nueva</span>
              <button type="button" onClick={submit} className={text.trim() ? 'ready' : ''}>
                ENTER
              </button>
            </div>
          </div>
        ) : (
          <div className="composer-idle">
            <strong>Atrapa una idea</strong>
            <span>Acerca el cursor para empezar</span>
          </div>
        )}
      </div>
    </div>
  );
}
