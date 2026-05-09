import { useEffect, useRef } from 'react';
import { sendPrompt } from '../lib/ws';
import { useUI, SESSION_TAB_ID } from '../lib/ui';
import { useOpenspecState } from '../lib/openspecState';
import { buildSyncReplyPrompt } from '../lib/openspecPrompts';

/** Modale Si/No che appare quando un /opsx:archive in batch ha emesso il
 *  SYNC_SENTINEL e si è fermato. L'utente decide se sincronizzare le
 *  delta-spec prima del mv archive. La risposta viene inviata come prompt
 *  di continuazione; la macchina a stati del batch (vedi handleOpsxDone)
 *  aggiornerà awaitingSync=false così il prossimo done avanza la queue.
 *
 *  Mostriamo solo se `pending.kind === 'archive-batch' && awaitingSync`.
 *  Il render avviene fuori da OpenspecTree per essere top-level (così non
 *  scompare nemmeno se l'utente collassa la sidebar). */
export function SyncDecisionModal() {
  const setActiveCenterTab = useUI((s) => s.setActiveCenterTab);
  const pending = useOpenspecState((s) => s.pending);
  const setPending = useOpenspecState((s) => s.setPending);
  const yesRef = useRef<HTMLButtonElement>(null);

  const visible = pending?.kind === 'archive-batch' && pending.awaitingSync;
  useEffect(() => {
    if (visible) setTimeout(() => yesRef.current?.focus(), 0);
  }, [visible]);

  if (!visible) return null;
  // Narrowing per TS: dopo `visible` so che pending è archive-batch awaiting.
  if (pending?.kind !== 'archive-batch') return null;

  const reply = (answer: 'yes' | 'no') => {
    const name = pending.current;
    // Prima azzeriamo awaitingSync, poi inviamo: garantisce che il prossimo
    // `done` venga letto come "archive completato", non come "sentinella".
    setPending({ ...pending, awaitingSync: false });
    sendPrompt(buildSyncReplyPrompt(answer, name));
    setActiveCenterTab(SESSION_TAB_ID);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      reply('no');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      reply('yes');
    }
  };

  return (
    <div className="modal-backdrop" onClick={(e) => e.stopPropagation()}>
      <div
        className="modal modal--confirm"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal__head">
          <h3 className="modal__title">sync delta specs for "{pending.current}"?</h3>
        </div>
        <div className="modal__body">
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
            Claude is about to archive <code>{pending.current}</code> and is
            asking whether to first sync the delta specs into the canonical
            <code> openspec/specs/</code>.
          </p>
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--fg-mute)' }}>
            <strong>Yes</strong> — sync now (recommended for completed changes).
            <br />
            <strong>No</strong> — skip sync, archive only.
            <br />
            Either way, archiving will then proceed for {pending.current}
            {pending.queue.length > 0 ? ` and ${pending.queue.length} more queued.` : '.'}
          </p>
        </div>
        <div className="modal__foot">
          <button className="header__btn" onClick={() => reply('no')} title="skip sync (esc)">
            no, skip
          </button>
          <button
            ref={yesRef}
            className="composer__send"
            onClick={() => reply('yes')}
            title="sync delta specs then archive (enter)"
          >
            yes, sync
          </button>
        </div>
      </div>
    </div>
  );
}
