import { useRef } from 'react';
import { useUI } from '../lib/ui';
import { FileTree } from './FileTree';
import { GitPanel } from './GitPanel';
import { Editor } from './Editor';
import { useScopedTheme } from './ThemeApplier';

/** Container per la sezione corrente del pannello destro.
 *  Renderizza FileTree, GitPanel o Editor in base a `rightPanelMode`.
 *  Se `mode === null` non viene renderizzato (gestito dal Layout). */
export function RightPanel() {
  const ref = useRef<HTMLDivElement>(null);
  useScopedTheme(ref, 'editor');

  const mode = useUI((s) => s.rightPanelMode);
  const setMode = useUI((s) => s.setRightPanelMode);

  if (!mode) return null;

  const titles: Record<NonNullable<typeof mode>, string> = {
    files: 'Files',
    git: 'Git',
    editor: 'Open files',
  };

  return (
    <div className="right-panel" ref={ref}>
      <div className="right-panel__head">
        <span className="right-panel__title">{titles[mode]}</span>
        <button
          className="right-panel__close"
          onClick={() => setMode(null)}
          title="Close panel"
        >
          ✕
        </button>
      </div>
      <div className="right-panel__body">
        {mode === 'files'  && <FileTree />}
        {mode === 'git'    && <GitPanel />}
        {mode === 'editor' && <Editor />}
      </div>
    </div>
  );
}
