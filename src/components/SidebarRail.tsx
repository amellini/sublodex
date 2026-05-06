import { useRef } from 'react';
import { useUI } from '../lib/ui';
import { MessagesIcon } from './icons';
import { useScopedTheme } from './ThemeApplier';

/** Stato collassato della sidebar sinistra (solo sessions): striscia thin
 *  con un'icona "messages" che espande la lista delle sessioni. */
export function SidebarRail() {
  const ref = useRef<HTMLDivElement>(null);
  useScopedTheme(ref, 'sidebar');
  const toggle = useUI((s) => s.toggleSidebar);
  return (
    <div className="rail" ref={ref}>
      <button
        className="rail__item rail__item--sessions"
        onClick={toggle}
        title="expand sessions"
      >
        <MessagesIcon size={18} />
      </button>
    </div>
  );
}
