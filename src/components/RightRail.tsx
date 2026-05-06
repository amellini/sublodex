import { useRef } from 'react';
import { useUI, type RightPanelMode } from '../lib/ui';
import { useStore } from '../lib/store';
import { FolderIcon, GitBranchIcon, FileIcon } from './icons';
import { useScopedTheme } from './ThemeApplier';

/** Activity-bar style icon column al margine destro dello schermo.
 *  Click su un'icona → apre quella sezione nel pannello destro;
 *  click di nuovo sulla stessa → chiude tutto (`rightPanelMode = null`). */
export function RightRail() {
  const ref = useRef<HTMLDivElement>(null);
  useScopedTheme(ref, 'sidebar');

  const mode = useUI((s) => s.rightPanelMode);
  const toggle = useUI((s) => s.toggleRightPanel);
  const isGitRepo = useUI((s) => s.isGitRepo);
  const openFiles = useStore((s) => s.openFiles);

  const items: Array<{
    id: Exclude<RightPanelMode, null>;
    title: string;
    icon: React.ReactNode;
    badge?: string | number;
    visible?: boolean;
  }> = [
    { id: 'files', title: 'project files', icon: <FolderIcon size={18} /> },
    { id: 'git',   title: 'git status',    icon: <GitBranchIcon size={18} />, visible: isGitRepo === true },
    { id: 'editor', title: 'open files',   icon: <FileIcon size={18} />, badge: openFiles.length || undefined },
  ];

  return (
    <div className="right-rail" ref={ref}>
      {items.map((item) => {
        if (item.visible === false) return null;
        const active = mode === item.id;
        return (
          <button
            key={item.id}
            className={`right-rail__item ${active ? 'right-rail__item--active' : ''}`}
            onClick={() => toggle(item.id)}
            title={item.title}
          >
            {item.icon}
            {item.badge !== undefined && <span className="right-rail__badge">{item.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}
