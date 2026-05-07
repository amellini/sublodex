/**
 * Menu dropdown ancorato a destra dell'header.
 *
 * Centralizza le azioni "secondarie" dell'header (find, export, terminal,
 * extensions, theme, projects) per evitare l'overflow dei pulsanti su
 * viewport stretti. Il trigger è un singolo button con icona hamburger
 * al click apre un dropdown ancorato a destra (così il
 * menu non esce mai dalla viewport, né a sinistra né a destra).
 *
 * Le voci sono passate come `items: HeaderMenuItem[]` — l'union discriminata
 * `kind` consente di intercalare divider (→ separatori visuali) tra gruppi
 * logici di azioni senza dover wrappare ogni gruppo in un sotto-array.
 *
 * Pattern coerente con `composer__model-drop` e `git-commit-btn__menu`:
 *   - `useRef` sul wrapper + listener `mousedown` su document → close on
 *     outside click
 *   - `Escape` su window → close keyboard-friendly
 */

import { useEffect, useRef, useState } from 'react';

export type HeaderMenuItem =
  | {
      kind: 'action';
      id: string;
      label: string;
      /** Glyph/emoji prefisso (es. "🔍", "⇣"). Stringa libera per non
       *  vincolare a un set di icone. Lasciato undefined → niente glyph. */
      icon?: string;
      /** Tooltip nativo (`title`). Mostra anche shortcut se presente. */
      title?: string;
      /** Stato "attivo" (es. terminale aperto): la voce viene evidenziata. */
      active?: boolean;
      disabled?: boolean;
      onClick: () => void;
    }
  | { kind: 'divider' };

export function HeaderMenu({ items }: { items: HeaderMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Click esterno → close. Pattern identico al model-picker e al
  // commit-button menu (Composer/GitPanel) per uniformità del codebase.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Esc → close. Listener su window (non su wrapRef): il menu non ha focus
  // intrinseco, vogliamo chiuderlo anche se il focus è altrove dopo l'apertura.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  const handleClick = (item: Extract<HeaderMenuItem, { kind: 'action' }>) => {
    if (item.disabled) return;
    item.onClick();
    setOpen(false);
  };

  return (
    <div className="header-menu" ref={wrapRef}>
      <button
        className={`header__btn header-menu__trigger${open ? ' header-menu__trigger--open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="menu"
      >
        <span className="header-menu__glyph" aria-hidden="true">☰</span>
      </button>
      {open && (
        <div className="header-menu__drop" role="menu">
          {items.map((it, i) => {
            if (it.kind === 'divider') {
              return <div key={`div-${i}`} className="header-menu__divider" role="separator" />;
            }
            return (
              <button
                key={it.id}
                role="menuitem"
                className={
                  'header-menu__item' +
                  (it.active ? ' header-menu__item--active' : '') +
                  (it.disabled ? ' header-menu__item--disabled' : '')
                }
                onClick={() => handleClick(it)}
                disabled={it.disabled}
                title={it.title}
              >
                {it.icon && <span className="header-menu__item-icon" aria-hidden="true">{it.icon}</span>}
                <span className="header-menu__item-label">{it.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
