import { useCallback, useEffect, useRef, useState } from 'react';
import { SpecMilkdownEditor } from './SpecMilkdownEditor';
import { useStore } from '../lib/store';

/** Pannello editor per una singola spec OpenSpec. Una istanza per tab
 *  (parent passa `key={filePath}`) → niente bisogno di un global store
 *  per dirty/loading/saving.
 *
 *  Niente useScopedTheme qui: il pane vive dentro `.center` che già applica
 *  lo scope 'center', ed eredita le stesse CSS variables del pannello chat.
 *  Sovrascrivere con scope 'editor' farebbe divergere lo sfondo. */
export function SpecEditorPane({ filePath }: { filePath: string }) {
  const ref = useRef<HTMLElement | null>(null);

  const [diskContent, setDiskContent] = useState('');
  const [editorContent, setEditorContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Versione del file rifetchata dal disco DOPO che Claude ha finito di scrivere
   *  questo file. Se diversa da editorContent, mostriamo il bottone reload.
   *  null = niente da mostrare. */
  const [latestDisk, setLatestDisk] = useState<string | null>(null);
  const [reloadConfirm, setReloadConfirm] = useState(false);

  const isDirty = editorContent !== diskContent;
  const fileName = filePath.split('/').pop() ?? filePath;

  // Carica contenuto al mount / cambio file. Riusa /api/file di sublodex.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLatestDisk(null);
    setReloadConfirm(false);
    fetch(`/api/file?path=${encodeURIComponent(filePath)}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((text) => {
        if (cancelled) return;
        setDiskContent(text);
        setEditorContent(text);
      })
      .catch((e) => { if (!cancelled) setError(String(e?.message ?? e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filePath]);

  // Subscribe a "claude ha finito di scrivere QUESTO file". streamingFiles è
  // un Record per path normalizzato; quando l'entry ha finished=true vuol dire
  // che il tool-call (Write/Edit) è completato.
  const finishedFull = useStore((s) => {
    const sf = s.streamingFiles[filePath];
    return sf?.finished ? sf.full : null;
  });

  useEffect(() => {
    if (finishedFull === null) return;
    // Re-fetch dal disco e confronta col buffer corrente. Se diverge, attiva
    // l'avviso reload. Usiamo finishedFull come dep stabile (string) così
    // ogni nuova scrittura completata triggera una rifetch indipendente.
    let cancelled = false;
    fetch(`/api/file?path=${encodeURIComponent(filePath)}`)
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((text) => { if (!cancelled) setLatestDisk(text); })
      .catch(() => { /* silenzioso: non vogliamo bloccare l'editing */ });
    return () => { cancelled = true; };
  }, [finishedFull, filePath]);

  const diskChanged = latestDisk !== null && latestDisk !== editorContent;

  const reloadFromDisk = useCallback(() => {
    if (latestDisk === null) return;
    setDiskContent(latestDisk);
    setEditorContent(latestDisk);
    setLatestDisk(null);
    setReloadConfirm(false);
  }, [latestDisk]);

  const onReloadClick = () => {
    if (isDirty) setReloadConfirm(true);
    else reloadFromDisk();
  };

  const save = useCallback(async () => {
    if (!isDirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`, {
        method: 'PUT',
        body: editorContent,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setDiskContent(editorContent);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [filePath, editorContent, isDirty, saving]);

  // Ctrl/Cmd+S → save. Listener globale ma `e.target` ristretto al pane
  // evita di rubare lo shortcut quando il focus è altrove (composer, monaco).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key !== 's' && e.key !== 'S') return;
      const root = ref.current;
      if (!root) return;
      if (!root.contains(e.target as Node)) return;
      e.preventDefault();
      void save();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  return (
    <aside className="spec-editor" ref={ref}>
      <div className="spec-editor__head">
        <span className="spec-editor__name">{fileName}</span>
        <span className="spec-editor__path" title={filePath}>{filePath}</span>
        {isDirty && <span className="spec-editor__dirty">Modified</span>}
        {saving && <span className="spec-editor__saving">Saving…</span>}
        {error && <span className="spec-editor__error" title={error}>Error</span>}
        <span className="spec-editor__spacer" />
        {diskChanged && !reloadConfirm && (
          <button
            className="header__btn spec-editor__reload"
            onClick={onReloadClick}
            title="Claude updated this file on disk — click to load the new version"
          >
            ↻ Reload
          </button>
        )}
        {diskChanged && reloadConfirm && (
          <span className="spec-editor__reload-confirm">
            <span>Discard your changes?</span>
            <button className="header__btn" onClick={() => setReloadConfirm(false)}>
              Cancel
            </button>
            <button className="header__btn header__btn--danger" onClick={reloadFromDisk}>
              Discard &amp; reload
            </button>
          </span>
        )}
        <button
          className="header__btn"
          onClick={() => void save()}
          disabled={!isDirty || saving || loading}
          title="Save (⌘S)"
        >
          Save
        </button>
      </div>
      <div className="spec-editor__body">
        {loading ? (
          <div className="spec-editor__loading">Loading…</div>
        ) : (
          <SpecMilkdownEditor
            content={diskContent}
            activeFile={filePath}
            onContentChange={setEditorContent}
          />
        )}
      </div>
    </aside>
  );
}
