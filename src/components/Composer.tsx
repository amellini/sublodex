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
import { useSettings, activeProject } from '../lib/settings';
import { MODELS } from '../lib/commands';
import {
  type PendingAttachment,
  imagesFromFileList,
  imagesFromDataTransfer,
  imagesFromDataTransferItems,
  ImageValidationError,
  processAndUpload,
  revokePending,
  validateImageFile,
} from '../lib/attachments';
import { ComposerAttachmentChip } from './ComposerAttachments';

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

/** Plugin ProseMirror che intercetta il paste di immagini.
 *  Se la clipboard ha file immagine, chiama `onImages(files)` e blocca il
 *  paste default (che altrimenti tenterebbe di inserire un nodo image
 *  nell'editor). Altrimenti lascia passare → paste di testo/markdown normale. */
function makeImagePastePlugin(onImages: (files: File[]) => void) {
  return new Plugin({
    props: {
      handlePaste(_view, event) {
        const cd = (event as ClipboardEvent).clipboardData;
        if (!cd) return false;
        const imgs = imagesFromDataTransferItems(cd.items);
        if (imgs.length === 0) return false;
        onImages(imgs);
        return true; // consume
      },
    },
  });
}

function MilkdownEditor({
  submitRef,
  resetRef,
  mdRef,
  onContentChange,
  placeholder,
  onPasteImages,
}: {
  submitRef: React.MutableRefObject<() => void>;
  /** Settato dal MilkdownEditor: il parent lo invoca dopo sendPrompt per
   *  svuotare visivamente l'editor (replaceAll('')). */
  resetRef: React.MutableRefObject<() => void>;
  mdRef: React.MutableRefObject<string>;
  onContentChange: (has: boolean) => void;
  placeholder: string;
  onPasteImages: (files: File[]) => void;
}) {
  // Tieni un ref al callback paste per evitare di rigenerare il plugin ad ogni
  // re-render (Milkdown ricrea l'editor solo al primo mount).
  const onPasteRef = useRef(onPasteImages);
  useEffect(() => { onPasteRef.current = onPasteImages; }, [onPasteImages]);

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
          makeImagePastePlugin((files) => onPasteRef.current(files)),
          ...ps,
        ]);
      })
      .use(commonmark)
      .use(history)
      .use(listener),
  );

  // Esponiamo al parent una callback per resettare l'editor (svuotare il
  // markdown). Il parent gestisce tutto il submit (sendPrompt + attachments)
  // e poi invoca resetRef.current() per pulire la UI.
  useEffect(() => {
    resetRef.current = () => {
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
  const settings     = useSettings((s) => s.settings);
  const project      = activeProject(settings);

  const [hasContent, setHasContent] = useState(false);
  const [modelOpen, setModelOpen]   = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);

  const isStreamingRef = useRef(isStreaming);
  const mdRef          = useRef('');
  const submitRef      = useRef<() => void>(() => {});
  const resetEditorRef = useRef<() => void>(() => {});
  const modelRef       = useRef<HTMLDivElement>(null);
  const fileInputRef   = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<PendingAttachment[]>([]);

  useEffect(() => { isStreamingRef.current = isStreaming; }, [isStreaming]);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);

  useEffect(() => {
    if (!modelOpen) return;
    const handler = (e: MouseEvent) => {
      if (!modelRef.current?.contains(e.target as Node)) setModelOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modelOpen]);

  // Cleanup al unmount: revoca tutti gli objectURL pendenti.
  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach(revokePending);
    };
  }, []);

  /** Gestisce N file immagine: validazione + thumbnail + upload async. */
  const handleFiles = (files: File[]) => {
    if (!project) {
      console.warn('[composer] no active project, ignoring drop/paste');
      return;
    }
    const projectId = project.id;
    const accepted: PendingAttachment[] = [];
    for (const file of files) {
      try {
        validateImageFile(file);
      } catch (err) {
        if (err instanceof ImageValidationError) {
          // Mostriamo come pending in errore così l'utente vede cosa è stato
          // scartato. Il chip si può rimuovere con la X.
          const localId = crypto.randomUUID();
          // Non generiamo thumbnail per file invalidi: previewUrl vuoto.
          accepted.push({
            localId,
            file,
            thumbnailBlob: new Blob(),
            previewUrl: '',
            width: 0, height: 0,
            status: 'error',
            errorMsg: err.message,
          });
        } else {
          console.warn('[composer] unexpected validation error', err);
        }
        continue;
      }
      const localId = crypto.randomUUID();
      // Inseriamo subito un placeholder con uno previewUrl temporaneo
      // (l'originale stesso) → l'utente vede qualcosa mentre la thumbnail
      // si genera. Verrà sostituito a generation completata.
      const tempPreview = URL.createObjectURL(file);
      accepted.push({
        localId,
        file,
        thumbnailBlob: new Blob(),
        previewUrl: tempPreview,
        width: 0, height: 0,
        status: 'uploading',
      });
    }
    if (accepted.length === 0) return;
    setAttachments((prev) => [...prev, ...accepted]);

    // Avvia thumbnail + upload per ognuno (in parallelo).
    for (const pending of accepted) {
      if (pending.status === 'error') continue;
      void (async () => {
        try {
          const { uploaded, thumbnail, width, height } = await processAndUpload(projectId, pending.file);
          // Sostituisci la preview temporanea (originale) con la thumbnail vera
          // → meno memoria e più rapida da renderizzare.
          const newPreview = URL.createObjectURL(thumbnail);
          setAttachments((prev) => prev.map((a) => {
            if (a.localId !== pending.localId) return a;
            try { URL.revokeObjectURL(a.previewUrl); } catch { /* */ }
            return {
              ...a,
              status: 'done',
              uploaded,
              thumbnailBlob: thumbnail,
              previewUrl: newPreview,
              width, height,
            };
          }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setAttachments((prev) => prev.map((a) =>
            a.localId === pending.localId ? { ...a, status: 'error', errorMsg: msg } : a
          ));
        }
      })();
    }
  };

  const removeAttachment = (localId: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.localId === localId);
      if (target) revokePending(target);
      return prev.filter((a) => a.localId !== localId);
    });
  };

  /* ---------- drag & drop ---------- */

  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer) return;
    // Mostriamo l'overlay solo se ci sono file nel drag (non per testo selezionato).
    const hasFiles = Array.from(e.dataTransfer.types || []).includes('Files');
    if (!hasFiles) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!isDragOver) setIsDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    // Lo state gestisce il caso del drag che esce dal box. Usiamo
    // relatedTarget perché dragleave fa fire anche per i figli interni.
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragOver(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = imagesFromDataTransfer(e.dataTransfer);
    if (files.length > 0) handleFiles(files);
  };

  /* ---------- file picker ---------- */

  const onPickClick = () => fileInputRef.current?.click();
  const onPickChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = imagesFromFileList(e.target.files);
    if (files.length > 0) handleFiles(files);
    // Reset così re-selezionare lo stesso file ri-firma onChange.
    e.target.value = '';
  };

  /* ---------- submit gating ---------- */

  const readyAttachments = attachments.filter((a) => a.status === 'done');
  const uploadingCount = attachments.filter((a) => a.status === 'uploading').length;
  const errorCount = attachments.filter((a) => a.status === 'error').length;

  // Submit: gestito interamente qui per avere accesso ad attachments.
  // Il MilkdownEditor invoca submitRef.current() dal keymap Enter; il bottone
  // "send" idem.
  useEffect(() => {
    submitRef.current = () => {
      const text = mdRef.current.trim();
      const ready = attachmentsRef.current.filter((a) => a.status === 'done');
      const uploading = attachmentsRef.current.some((a) => a.status === 'uploading');
      // Permetti send se c'è testo OPPURE almeno un allegato pronto.
      if ((!text && ready.length === 0) || isStreamingRef.current || uploading) return;
      sendPrompt(text, ready.map((a) => a.uploaded!));
      attachmentsRef.current.forEach(revokePending);
      setAttachments([]);
      resetEditorRef.current();
    };
  }, []);

  const sendDisabled =
    isStreaming ||
    uploadingCount > 0 ||
    (!hasContent && readyAttachments.length === 0);

  return (
    <div
      className={'composer' + (isDragOver ? ' composer--dragover' : '')}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="composer__box">
        {attachments.length > 0 && (
          <div className="composer__attachments">
            {attachments.map((a) => (
              <ComposerAttachmentChip
                key={a.localId}
                att={a}
                onRemove={() => removeAttachment(a.localId)}
              />
            ))}
          </div>
        )}
        <MilkdownProvider>
          <MilkdownEditor
            submitRef={submitRef}
            resetRef={resetEditorRef}
            mdRef={mdRef}
            onContentChange={setHasContent}
            placeholder={isStreaming ? 'claude is working…' : 'talk to claude…'}
            onPasteImages={handleFiles}
          />
        </MilkdownProvider>
        <div className="composer__bar">
          <span className="composer__hint">
            {uploadingCount > 0 ? (
              <>caricamento {uploadingCount} immagin{uploadingCount === 1 ? 'e' : 'i'}…</>
            ) : errorCount > 0 ? (
              <span className="composer__hint-err">
                {errorCount} allegat{errorCount === 1 ? 'o' : 'i'} non valid{errorCount === 1 ? 'o' : 'i'}
              </span>
            ) : (
              <>
                <kbd>↵</kbd> send · <kbd>⇧↵</kbd> newline · <kbd>📎</kbd> trascina, incolla o clicca
              </>
            )}
          </span>

          {/* file picker nascosto */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            hidden
            onChange={onPickChange}
          />
          <button
            className="composer__attach"
            onClick={onPickClick}
            title="allega immagine"
            type="button"
          >
            📎
          </button>

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
              disabled={sendDisabled}
            >
              send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
