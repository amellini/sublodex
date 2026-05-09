import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { sendPrompt } from '../lib/ws';
import { useUI, SESSION_TAB_ID } from '../lib/ui';
import { useOpenspecState } from '../lib/openspecState';
import { buildProposePrompt } from '../lib/openspecPrompts';

/** Modale per lanciare `/opsx:propose <name> <context>`. Apertura dal bottone
 *  `+` accanto al refresh nel tree OpenSpec. Il name è kebab/snake-friendly,
 *  il context è una multiline che descrive cosa proporre. */
export function ProposeModal({ onClose }: { onClose: () => void }) {
  const claudeBusy = useStore((s) => s.isStreaming);
  const setActiveCenterTab = useUI((s) => s.setActiveCenterTab);
  const setPending = useOpenspecState((s) => s.setPending);
  const [name, setName] = useState('');
  const [context, setContext] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTimeout(() => nameRef.current?.focus(), 0); }, []);

  // Validazione minima: il name non deve avere spazi (verrebbe interpretato
  // come secondo argomento dal plugin), il context deve esistere.
  const nameTrimmed = name.trim();
  const ctxTrimmed = context.trim();
  const nameInvalid = nameTrimmed.length > 0 && /\s/.test(nameTrimmed);
  const canSubmit =
    nameTrimmed.length > 0 &&
    !nameInvalid &&
    ctxTrimmed.length >= 10 &&
    !claudeBusy;

  const submit = () => {
    if (!canSubmit) return;
    sendPrompt(buildProposePrompt(nameTrimmed, ctxTrimmed));
    setPending({ kind: 'propose' });
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
        className="modal modal--propose"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal__head">
          <h3 className="modal__title">new openspec proposal</h3>
          <span className="modal__spacer" />
          <button className="header__btn" onClick={onClose} title="close">✕</button>
        </div>
        <div className="modal__body">
          <div className="field">
            <label className="field__label">name</label>
            <input
              ref={nameRef}
              className="field__input"
              placeholder="kebab-case slug, e.g. add-export-csv"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            {nameInvalid && (
              <span className="modal__hint" style={{ color: 'var(--red)' }}>
                no spaces — use kebab-case or snake_case
              </span>
            )}
          </div>
          <div className="field">
            <label className="field__label">context</label>
            <textarea
              className="field__textarea"
              placeholder="describe what should change and why (min 10 chars)"
              value={context}
              onChange={(e) => setContext(e.target.value)}
              rows={8}
            />
            <span className="modal__hint">
              ⌘/Ctrl+Enter to submit · esc to cancel
            </span>
          </div>
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
                : !canSubmit
                  ? 'fill name (no spaces) and at least 10 chars of context'
                  : 'send /opsx:propose'
            }
          >
            propose
          </button>
        </div>
      </div>
    </div>
  );
}
