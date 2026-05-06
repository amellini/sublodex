import { useEffect, useRef } from 'react';
import { FileTree } from './FileTree';
import { GitPanel } from './GitPanel';
import { SessionsList } from './SessionsList';
import { useUI } from '../lib/ui';
import { useScopedTheme } from './ThemeApplier';

export function SidebarLeft() {
  const ref = useRef<HTMLDivElement>(null);
  useScopedTheme(ref, 'sidebar');
  const toggle = useUI((s) => s.toggleSidebar);
  const mode = useUI((s) => s.sidebarMode);
  const setMode = useUI((s) => s.setSidebarMode);
  const isGitRepo = useUI((s) => s.isGitRepo);

  // Se siamo sul tab git ma il progetto non è un repo, fallback su sessions.
  useEffect(() => {
    if (mode === 'git' && isGitRepo === false) setMode('sessions');
  }, [mode, isGitRepo, setMode]);

  return (
    <div className="sidebar" ref={ref}>
      <div className="sidebar__head">
        <div className="sidebar__tabs">
          <button
            className={`sidebar__tab ${mode === 'sessions' ? 'sidebar__tab--active' : ''}`}
            onClick={() => setMode('sessions')}
          >
            sessions
          </button>
          <button
            className={`sidebar__tab ${mode === 'files' ? 'sidebar__tab--active' : ''}`}
            onClick={() => setMode('files')}
          >
            files
          </button>
          {isGitRepo === true && (
            <button
              className={`sidebar__tab ${mode === 'git' ? 'sidebar__tab--active' : ''}`}
              onClick={() => setMode('git')}
            >
              git
            </button>
          )}
        </div>
        <button className="sidebar__collapse" onClick={toggle} title="collapse">
          ‹
        </button>
      </div>
      {mode === 'sessions' && <SessionsList />}
      {mode === 'files' && <FileTree />}
      {mode === 'git' && <GitPanel />}
      <div className="sidebar__foot" title="SubLodeX — by Amani Andrea aka The Pirate Pinperepette">
        <span className="sidebar__foot-name">SubLodeX</span>
        <span className="sidebar__foot-by">by Amani Andrea</span>
        <span className="sidebar__foot-alias">aka <em>The Pirate Pinperepette</em></span>
      </div>
    </div>
  );
}
