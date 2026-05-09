import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { sendPrompt } from '../lib/ws';
import { useUI, SESSION_TAB_ID } from '../lib/ui';
import { useOpenspecState, type OpenspecChange } from '../lib/openspecState';
import { buildArchivePrompt } from '../lib/openspecPrompts';
import { CheckIcon } from './icons';

/** Archive picker: lista delle change attive da `openspec list --json` con
 *  multi-select. Sostituisce la vecchia ArchiveConfirmModal (ora rimossa) per
 *  permettere archiviazione batch. Le change con `status: complete` sono
 *  pre-selezionate (sono quelle "naturalmente pronte").
 *
 *  Quando l'utente conferma: facciamo il primo `/opsx:archive <name>` e
 *  settiamo pendingOpsx = archive-batch. Il done hook su WS fa avanzare la
 *  coda (vedi src/lib/ws.ts handleOpsxDone). */
export function ArchivePickerModal({ onClose }: { onClose: () => void }) {
  const claudeBusy = useStore((s) => s.isStreaming);
  const setActiveCenterTab = useUI((s) => s.setActiveCenterTab);
  const setPending = useOpenspecState((s) => s.setPending);
  const fetchChanges = useOpenspecState((s) => s.fetchChanges);
  const applied = useOpenspecState((s) => s.applied);

  const [changes, setChanges] = useState<OpenspecChange[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** autoSync=true → Claude prende automaticamente "Sync now" senza fermarsi.
   *  Tipico quando si archivia in batch in CI o ci si fida del default.
   *  autoSync=false → Claude mette il SYNC_SENTINEL e aspetta una modale Si/No
   *  per ogni change che presenta delta-spec da sincronizzare. */
  const [autoSync, setAutoSync] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await fetchChanges();
      if (cancelled) return;
      setChanges(r.changes);
      setLoadError(r.error ?? null);
      // Pre-select: prima le change `complete`, poi (in fallback se nessuna è
      // complete) quelle marcate applied nel nostro state file. Così l'utente
      // tipico clicca subito "archive" senza ulteriore selezione.
      const completeNames = r.changes.filter((c) => c.status === 'complete').map((c) => c.name);
      if (completeNames.length > 0) {
        setSelected(new Set(completeNames));
      } else {
        const appliedNames = r.changes
          .filter((c) => Boolean(applied[`openspec/changes/${c.name}`]))
          .map((c) => c.name);
        setSelected(new Set(appliedNames));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { setTimeout(() => dialogRef.current?.focus(), 0); }, []);

  const toggle = (name: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const orderedChanges = useMemo(() => {
    if (!changes) return [];
    // Ordine: complete prima (in ordine di lastModified desc), poi in-progress
    // desc. Così vede subito cosa è "ready".
    return [...changes].sort((a, b) => {
      if (a.status === 'complete' && b.status !== 'complete') return -1;
      if (b.status === 'complete' && a.status !== 'complete') return 1;
      return (b.lastModified ?? '').localeCompare(a.lastModified ?? '');
    });
  }, [changes]);

  const canSubmit = !claudeBusy && selected.size > 0;

  const submit = () => {
    if (!canSubmit) return;
    const names = orderedChanges.map((c) => c.name).filter((n) => selected.has(n));
    if (names.length === 0) return;
    const [first, ...rest] = names;
    sendPrompt(buildArchivePrompt(first, autoSync));
    setPending({
      kind: 'archive-batch',
      queue: rest,
      current: first,
      total: names.length,
      done: 1,
      autoSync,
      awaitingSync: false,
    });
    setActiveCenterTab(SESSION_TAB_ID);
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal modal--archive-picker"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
      >
        <div className="modal__head">
          <h3 className="modal__title">archive changes</h3>
          <span className="modal__spacer" />
          <button className="header__btn" onClick={onClose} title="close">✕</button>
        </div>

        <div className="modal__body">
          {!changes && !loadError && (
            <div className="ftree__msg">loading changes…</div>
          )}
          {loadError && (
            <div className="modal__error">
              <strong>openspec list failed:</strong>
              <pre style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', fontSize: 11 }}>{loadError}</pre>
              <p style={{ margin: '6px 0 0', fontSize: 11, opacity: 0.8 }}>
                Make sure the <code>openspec</code> CLI is on PATH and the project has an <code>openspec/</code> dir.
              </p>
            </div>
          )}
          {changes && changes.length === 0 && !loadError && (
            <div className="ftree__msg">no active changes — nothing to archive</div>
          )}
          {changes && changes.length > 0 && (
            <div className="archive-picker__list">
              {orderedChanges.map((c) => {
                const isSel = selected.has(c.name);
                const progress = c.totalTasks > 0
                  ? `${c.completedTasks}/${c.totalTasks}`
                  : '—';
                return (
                  <button
                    key={c.name}
                    type="button"
                    className={`archive-picker__item ${isSel ? 'archive-picker__item--selected' : ''}`}
                    onClick={() => toggle(c.name)}
                  >
                    <span className={`archive-picker__check ${isSel ? 'archive-picker__check--on' : ''}`}>
                      {isSel && <CheckIcon size={11} />}
                    </span>
                    <span className="archive-picker__name">{c.name}</span>
                    <span className={`archive-picker__status archive-picker__status--${c.status}`}>
                      {c.status}
                    </span>
                    <span className="archive-picker__progress">{progress} tasks</span>
                  </button>
                );
              })}
            </div>
          )}
          {changes && changes.length > 0 && (
            <label className="archive-picker__autosync">
              <input
                type="checkbox"
                checked={autoSync}
                onChange={(e) => setAutoSync(e.target.checked)}
              />
              <span className="archive-picker__autosync-label">
                <strong>auto-sync delta specs</strong>
                <span className="archive-picker__autosync-hint">
                  Claude pre-conferma "Sync now" senza fermarsi. Lascia spuntato
                  per archiviare in serie senza interventi manuali.
                </span>
              </span>
            </label>
          )}
          {changes && changes.length > 0 && (
            <span className="modal__hint">
              {selected.size} of {changes.length} selected · ⌘/Ctrl+Enter to archive · esc to cancel
            </span>
          )}
        </div>

        <div className="modal__foot">
          <button className="header__btn" onClick={onClose}>cancel</button>
          <button
            className="composer__send"
            onClick={submit}
            disabled={!canSubmit}
            title={
              claudeBusy
                ? 'claude is busy — wait for the current response'
                : selected.size === 0
                  ? 'select at least one change'
                  : `archive ${selected.size} change${selected.size === 1 ? '' : 's'} sequentially`
            }
          >
            archive {selected.size > 0 ? `(${selected.size})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
