import { useEffect, useRef, useState } from 'react';
import { Editor, rootCtx, defaultValueCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { history } from '@milkdown/plugin-history';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { useEditor, MilkdownProvider, Milkdown } from '@milkdown/react';
import { replaceAll } from '@milkdown/utils';
import { MarkdownContextMenu } from './MarkdownContextMenu';

type Props = {
  content: string;
  activeFile: string | null;
  onContentChange: (md: string) => void;
};

type MenuPos = { x: number; y: number } | null;

/** Editor Milkdown WYSIWYG per le spec OpenSpec. Portato da Specificator
 *  rimuovendo il theme `nord`: il look è guidato da `.spec-editor` in
 *  styles.css con i token sublodex (`--bg`, `--fg`, ...). */
function MilkdownInner({ content, activeFile, onContentChange }: Props) {
  const suppressRef = useRef(false);
  const contentRef = useRef(content);
  const onChangeRef = useRef(onContentChange);
  onChangeRef.current = onContentChange;
  const [menuPos, setMenuPos] = useState<MenuPos>(null);

  const { get } = useEditor((root) =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, content);
        ctx.get(listenerCtx).markdownUpdated((_ctx, md) => {
          if (suppressRef.current) {
            suppressRef.current = false;
            return;
          }
          onChangeRef.current(md ?? '');
        });
      })
      .use(commonmark)
      .use(history)
      .use(listener),
  );

  const editorRef = useRef(get);
  editorRef.current = get;

  useEffect(() => {
    if (contentRef.current !== content) {
      contentRef.current = content;
      suppressRef.current = true;
      editorRef.current()?.action(replaceAll(content));
    }
  }, [content, activeFile]);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
  };

  return (
    <div onContextMenu={handleContextMenu} style={{ height: '100%' }}>
      <Milkdown />
      {menuPos && (
        <MarkdownContextMenu
          x={menuPos.x}
          y={menuPos.y}
          getEditor={get}
          onClose={() => setMenuPos(null)}
        />
      )}
    </div>
  );
}

export function SpecMilkdownEditor(props: Props) {
  return (
    <MilkdownProvider>
      <MilkdownInner {...props} />
    </MilkdownProvider>
  );
}
