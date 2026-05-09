import { useRef } from 'react';
import { SessionsList } from './SessionsList';
import { OpenspecTree } from './OpenspecTree';
import { useUI } from '../lib/ui';
import { useScopedTheme } from './ThemeApplier';

export function SidebarLeft() {
  const ref = useRef<HTMLDivElement>(null);
  useScopedTheme(ref, 'sidebar');
  const toggle = useUI((s) => s.toggleSidebar);
  const sidebarMode = useUI((s) => s.sidebarMode);
  const setSidebarMode = useUI((s) => s.setSidebarMode);
  const hasOpenspec = useUI((s) => s.hasOpenspec);

  // Quando il progetto non ha openspec/ ma la modalità era rimasta su 'openspec'
  // (es. switch progetto), forziamo il fallback a 'sessions'. Effetto secondario
  // banale, evita di renderizzare un tree vuoto senza contesto.
  const effectiveMode = sidebarMode === 'openspec' && hasOpenspec !== true ? 'sessions' : sidebarMode;

  return (
    <div className="sidebar" ref={ref}>
      <div className="sidebar__head">
        {hasOpenspec === true ? (
          <div className="sidebar__modetabs">
            <button
              className={`sidebar__modetab ${effectiveMode === 'sessions' ? 'sidebar__modetab--active' : ''}`}
              onClick={() => setSidebarMode('sessions')}
            >
              sessions
            </button>
            <button
              className={`sidebar__modetab ${effectiveMode === 'openspec' ? 'sidebar__modetab--active' : ''}`}
              onClick={() => setSidebarMode('openspec')}
            >
              openspec
            </button>
          </div>
        ) : (
          <span className="sidebar__title">sessions</span>
        )}
        <button className="sidebar__collapse" onClick={toggle} title="collapse">
          ‹
        </button>
      </div>
      {effectiveMode === 'sessions' ? <SessionsList /> : <OpenspecTree />}
      <div className="sidebar__foot" title="SubLodeX — by Amani Andrea aka The Pirate Pinperepette">
        <span className="sidebar__foot-name">SubLodeX</span>
        <span className="sidebar__foot-by">by Amani Andrea</span>
        <span className="sidebar__foot-alias">aka <em>The Pirate Pinperepette</em></span>
      </div>
    </div>
  );
}
