import { useEffect, useRef, useState } from 'react';
import { callCommand } from '@milkdown/utils';
import { editorViewCtx } from '@milkdown/core';
import {
  toggleStrongCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  wrapInHeadingCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInOrderedListCommand,
  createCodeBlockCommand,
  insertHrCommand,
} from '@milkdown/preset-commonmark';

type Props = {
  x: number;
  y: number;
  getEditor: () => any;
  onClose: () => void;
};

/** Context menu markdown per l'editor delle spec. Portato da Specificator,
 *  classi CSS `.md-ctx-*` ridefinite in styles.css con i token sublodex. */
export function MarkdownContextMenu({ x, y, getEditor, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [subOpen, setSubOpen] = useState(false);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const item = (action: () => void) => (e: React.MouseEvent) => {
    e.preventDefault();
    action();
  };

  const cmd = (command: any, payload?: any) => {
    getEditor()?.action(callCommand(command.key, payload));
    onClose();
  };

  const insertRaw = (text: string) => {
    getEditor()?.action((ctx: any) => {
      const view = ctx.get(editorViewCtx);
      const { state, dispatch } = view;
      const { tr, selection } = state;
      dispatch(tr.insertText(text, selection.from, selection.to));
    });
    onClose();
  };

  const handleCopy = () => { document.execCommand('copy'); onClose(); };
  const handleCut = () => { document.execCommand('cut'); onClose(); };
  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      document.execCommand('insertText', false, text);
    } catch { /* permission denied */ }
    onClose();
  };

  const insertImage = () => {
    const src = window.prompt("URL dell'immagine:");
    if (!src) { onClose(); return; }
    const alt = window.prompt('Testo alternativo (opzionale):') ?? '';
    insertRaw(`![${alt}](${src})`);
  };

  const insertLink = () => {
    const href = window.prompt('URL del link:');
    if (!href) { onClose(); return; }
    const text = window.prompt('Testo del link:') ?? href;
    insertRaw(`[${text}](${href})`);
  };

  const insertTable = () => {
    insertRaw('\n| Colonna 1 | Colonna 2 | Colonna 3 |\n|-----------|-----------|----------|\n| A | B | C |\n| D | E | F |\n');
  };

  const menuW = 224;
  const menuH = 420;
  const adjX = x + menuW > window.innerWidth ? x - menuW : x;
  const adjY = y + menuH > window.innerHeight ? Math.max(0, y - menuH) : y;

  return (
    <div
      ref={menuRef}
      className="md-ctx-menu"
      style={{ left: adjX, top: adjY }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button className="md-ctx-item" onMouseDown={item(handleCut)}>
        <span className="md-ctx-icon">✂</span> Taglia
      </button>
      <button className="md-ctx-item" onMouseDown={item(handleCopy)}>
        <span className="md-ctx-icon">⎘</span> Copia
      </button>
      <button className="md-ctx-item" onMouseDown={item(handlePaste)}>
        <span className="md-ctx-icon">⌅</span> Incolla
      </button>

      <div className="md-ctx-sep" />

      <button className="md-ctx-item" onMouseDown={item(() => cmd(wrapInHeadingCommand, 1))}>
        <span className="md-ctx-tag">H1</span> Titolo 1
      </button>
      <button className="md-ctx-item" onMouseDown={item(() => cmd(wrapInHeadingCommand, 2))}>
        <span className="md-ctx-tag">H2</span> Titolo 2
      </button>
      <button className="md-ctx-item" onMouseDown={item(() => cmd(wrapInHeadingCommand, 3))}>
        <span className="md-ctx-tag">H3</span> Titolo 3
      </button>

      <div className="md-ctx-sep" />

      <button className="md-ctx-item" onMouseDown={item(() => cmd(toggleStrongCommand))}>
        <span className="md-ctx-tag"><b>B</b></span> Grassetto
      </button>
      <button className="md-ctx-item" onMouseDown={item(() => cmd(toggleEmphasisCommand))}>
        <span className="md-ctx-tag"><em>I</em></span> Corsivo
      </button>
      <button className="md-ctx-item" onMouseDown={item(() => cmd(toggleInlineCodeCommand))}>
        <span className="md-ctx-tag mono">`c`</span> Codice inline
      </button>
      <button className="md-ctx-item" onMouseDown={item(() => cmd(wrapInBlockquoteCommand))}>
        <span className="md-ctx-tag">❝</span> Citazione
      </button>

      <div className="md-ctx-sep" />

      <button className="md-ctx-item" onMouseDown={item(() => cmd(wrapInBulletListCommand))}>
        <span className="md-ctx-tag">•—</span> Lista puntata
      </button>
      <button className="md-ctx-item" onMouseDown={item(() => cmd(wrapInOrderedListCommand))}>
        <span className="md-ctx-tag">1.</span> Lista numerata
      </button>

      <div className="md-ctx-sep" />

      <div
        className={`md-ctx-item md-ctx-sub-trigger${subOpen ? ' open' : ''}`}
        onMouseEnter={() => setSubOpen(true)}
        onMouseLeave={() => setSubOpen(false)}
        onMouseDown={(e) => e.preventDefault()}
      >
        <span className="md-ctx-tag">+</span>
        <span>Inserisci…</span>
        <span className="md-ctx-arrow">▶</span>

        {subOpen && (
          <div className="md-ctx-submenu">
            <button className="md-ctx-item" onMouseDown={item(() => cmd(createCodeBlockCommand))}>
              <span className="md-ctx-tag mono">```</span> Blocco codice
            </button>
            <button className="md-ctx-item" onMouseDown={item(() => cmd(insertHrCommand))}>
              <span className="md-ctx-tag">—</span> Separatore
            </button>
            <div className="md-ctx-sep" />
            <button className="md-ctx-item" onMouseDown={item(insertImage)}>
              <span className="md-ctx-tag">🖼</span> Immagine
            </button>
            <button className="md-ctx-item" onMouseDown={item(insertLink)}>
              <span className="md-ctx-tag">🔗</span> Link
            </button>
            <button className="md-ctx-item" onMouseDown={item(insertTable)}>
              <span className="md-ctx-tag">⊞</span> Tabella
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
