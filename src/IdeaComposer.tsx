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

  /* Clic fuera cierra (guardar el texto escrito mientras se escribe). */
  useEffect(() => {
    if (!active) return;
    const close = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setActive(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [active]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    const r = wrapRef.current?.getBoundingClientRect();
    onCreate(t, r ? { x: r.left + r.width / 2, y: r.top } : { x: window.innerWidth / 2, y: window.innerHeight - 90 });
    setText('');
    setActive(false);
  };

  return (
    <div
      ref={wrapRef}
      className={`composer${active ? ' active' : ''}`}
      onMouseEnter={() => setActive(true)}
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
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
                if (e.key === 'Escape') setActive(false);
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
