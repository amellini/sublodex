import { useRef } from 'react';
import { SessionsList } from './SessionsList';
import { useUI } from '../lib/ui';
import { useScopedTheme } from './ThemeApplier';

export function SidebarLeft() {
  const ref = useRef<HTMLDivElement>(null);
  useScopedTheme(ref, 'sidebar');
  const toggle = useUI((s) => s.toggleSidebar);

  return (
    <div className="sidebar" ref={ref}>
      <div className="sidebar__head">
        <span className="sidebar__title">sessions</span>
        <button className="sidebar__collapse" onClick={toggle} title="collapse">
          ‹
        </button>
      </div>
      <SessionsList />
      <div className="sidebar__foot" title="SubLodeX — by Amani Andrea aka The Pirate Pinperepette">
        <span className="sidebar__foot-name">SubLodeX</span>
        <span className="sidebar__foot-by">by Amani Andrea</span>
        <span className="sidebar__foot-alias">aka <em>The Pirate Pinperepette</em></span>
      </div>
    </div>
  );
}
