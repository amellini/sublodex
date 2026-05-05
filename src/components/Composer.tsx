import { defaultValueCtx, Editor, prosePluginsCtx, rootCtx } from '@milkdown/core';
import { history } from '@milkdown/plugin-history';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { commonmark } from '@milkdown/preset-commonmark';
import { DecorationSet } from '@milkdown/prose/view';
import { Decoration } from '@milkdown/prose/view';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import { splitBlock } from '@milkdown/prose/commands';
import { keymap } from '@milkdown/prose/keymap';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { replaceAll } from '@milkdown/utils';
import { useEffect, useRef, useState } from 'react';
import { cancel, sendPrompt } from '../lib/ws';
import { useStore } from '../lib/store';
import { MODELS } from '../lib/commands';

const placeholderKey = new PluginKey('composer-placeholder');

function makePlaceholderPlugin(text: string) {
  return new Plugin({
    key: placeholderKey,
    props: {
      decorations(state) {
        const doc = state.doc;
        if (doc.childCount === 1) {
          const first = doc.firstChild;
          if (first?.type.name === 'paragraph' && first.childCount === 0) {
            return DecorationSet.create(doc, [
              Decoration.node(0, doc.content.size, {
                class: 'composer-placeholder',
                'data-placeholder': text,
              }),
            ]);
          }
        }
        return DecorationSet.empty;
      },
    },
  });
}

function shortModel(m: string | undefined): string {
  if (!m) return 'model';
  if (m.includes('opus'))   return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku'))  return 'haiku';
  return m;
}

function MilkdownEditor({
  submitRef,
  mdRef,
  isStreamingRef,
  onContentChange,
  placeholder,
}: {
  submitRef: React.MutableRefObject<() => void>;
  mdRef: React.MutableRefObject<string>;
  isStreamingRef: React.MutableRefObject<boolean>;
  onContentChange: (has: boolean) => void;
  placeholder: string;
}) {
  const { get } = useEditor((root) =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, '');
        ctx.get(listenerCtx).markdownUpdated((_c, md) => {
          mdRef.current = md ?? '';
          onContentChange(!!md?.trim());
        });
        ctx.update(prosePluginsCtx, (ps) => [
          keymap({
            Enter: (state) => {
              const { $from } = state.selection;
              for (let d = $from.depth; d >= 0; d--) {
                if ($from.node(d).type.name === 'list_item') return false;
              }
              submitRef.current();
              return true;
            },
            'Shift-Enter': splitBlock,
          }),
          makePlaceholderPlugin(placeholder),
          ...ps,
        ]);
      })
      .use(commonmark)
      .use(history)
      .use(listener),
  );

  useEffect(() => {
    submitRef.current = () => {
      const text = mdRef.current.trim();
      if (!text || isStreamingRef.current) return;
      sendPrompt(text);
      get()?.action(replaceAll(''));
      onContentChange(false);
    };
  });

  return <Milkdown />;
}

export function Composer() {
  const isStreaming  = useStore((s) => s.isStreaming);
  const model        = useStore((s) => s.model);
  const runtimeModel = useStore((s) => s.runtimeModel);
  const setModel     = useStore((s) => s.setModel);
  const resetSession = useStore((s) => s.resetSession);

  const [hasContent, setHasContent] = useState(false);
  const [modelOpen, setModelOpen]   = useState(false);

  const isStreamingRef = useRef(isStreaming);
  const mdRef          = useRef('');
  const submitRef      = useRef<() => void>(() => {});
  const modelRef       = useRef<HTMLDivElement>(null);

  useEffect(() => { isStreamingRef.current = isStreaming; }, [isStreaming]);

  useEffect(() => {
    if (!modelOpen) return;
    const handler = (e: MouseEvent) => {
      if (!modelRef.current?.contains(e.target as Node)) setModelOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modelOpen]);

  return (
    <div className="composer">
      <div className="composer__box">
        <MilkdownProvider>
          <MilkdownEditor
            submitRef={submitRef}
            mdRef={mdRef}
            isStreamingRef={isStreamingRef}
            onContentChange={setHasContent}
            placeholder={isStreaming ? 'claude is working…' : 'talk to claude…'}
          />
        </MilkdownProvider>
        <div className="composer__bar">
          <span className="composer__hint">
            <kbd>↵</kbd> send · <kbd>⇧↵</kbd> newline
          </span>

          {!isStreaming && (
            <button
              className="composer__clear"
              onClick={() => resetSession()}
              title="clear conversation (/clear)"
            >
              ⌫ clear
            </button>
          )}

          <div className="composer__model-wrap" ref={modelRef}>
            <button
              className="composer__model"
              onClick={() => setModelOpen((o) => !o)}
              title="switch model"
            >
              {shortModel(model ?? runtimeModel)}
              <span className="composer__model-arrow">{modelOpen ? '▴' : '▾'}</span>
            </button>
            {modelOpen && (
              <div className="composer__model-drop">
                {MODELS.map((m) => (
                  <button
                    key={m}
                    className={`composer__model-opt${(model ?? runtimeModel) === m ? ' composer__model-opt--active' : ''}`}
                    onClick={() => { setModel(m); setModelOpen(false); }}
                  >
                    {shortModel(m)}
                    <span className="composer__model-opt-full">{m}</span>
                  </button>
                ))}
                {model && (
                  <button
                    className="composer__model-opt composer__model-opt--reset"
                    onClick={() => { setModel(undefined); setModelOpen(false); }}
                  >
                    reset to default
                  </button>
                )}
              </div>
            )}
          </div>

          {isStreaming ? (
            <button className="composer__cancel" onClick={cancel}>stop</button>
          ) : (
            <button
              className="composer__send"
              onClick={() => submitRef.current()}
              disabled={!hasContent}
            >
              send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
