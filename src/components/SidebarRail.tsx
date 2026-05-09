import { useRef } from 'react';
import { useUI, type SidebarMode } from '../lib/ui';
import { MessagesIcon, SpecIcon } from './icons';
import { useScopedTheme } from './ThemeApplier';

/** Stato collassato della sidebar sinistra: striscia thin con icone per le
 *  modalità disponibili. Click espande la sidebar nella modalità scelta.
 *  Modalità OpenSpec compare solo se il progetto attivo ha `openspec/`. */
export function SidebarRail() {
  const ref = useRef<HTMLDivElement>(null);
  useScopedTheme(ref, 'sidebar');
  const setSidebarMode = useUI((s) => s.setSidebarMode);
  const toggle = useUI((s) => s.toggleSidebar);
  const hasOpenspec = useUI((s) => s.hasOpenspec);

  const open = (mode: SidebarMode) => {
    setSidebarMode(mode);
    toggle();
  };

  return (
    <div className="rail" ref={ref}>
      <button
        className="rail__item rail__item--sessions"
        onClick={() => open('sessions')}
        title="expand sessions"
      >
        <MessagesIcon size={18} />
      </button>
      {hasOpenspec === true && (
        <button
          className="rail__item rail__item--openspec"
          onClick={() => open('openspec')}
          title="OpenSpec editor"
        >
          <SpecIcon size={18} />
        </button>
      )}
    </div>
  );
}
