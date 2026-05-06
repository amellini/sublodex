import { useCallback, useEffect, useState } from 'react';
import { useUI } from '../lib/ui';
import { useStore } from '../lib/store';
import { useSettings, activeProject } from '../lib/settings';
import {
  createNewSession,
  deleteConversation,
  listSessions,
  loadConversation,
  renameSession,
  type SessionMeta,
} from '../lib/conversation';
import { PencilIcon, TrashIcon } from './icons';

/** Sidebar tab: lista delle sessioni del progetto attivo.
 *  Click sulla riga → switch sessione. Pencil su hover → rename inline.
 *  Trash su hover → conferma + delete. Footer: "+ new session". */
export function SessionsList() {
  const settings = useSettings((s) => s.settings);
  const active = activeProject(settings);
  const activeSessionByProject = useUI((s) => s.activeSessionByProject);
  const setActiveSession = useUI((s) => s.setActiveSession);

  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  const isStreaming = useStore((s) => s.isStreaming);
  const turns = useStore((s) => s.turns);

  const refresh = useCallback(async () => {
    if (!active?.id) return;
    const list = await listSessions(active.id);
    setSessions(list);
  }, [active?.id]);

  useEffect(() => { void refresh(); }, [refresh, turns]);

  if (!active?.id) {
    return <div className="sessions-list__empty">no active project</div>;
  }

  const currentId = activeSessionByProject[active.id];

  const switchTo = (id: string) => {
    if (!active?.id || id === currentId || isStreaming) return;
    setActiveSession(active.id, id);
    // L'effect in App.tsx caricherà la nuova session.
  };

  const createNew = async () => {
    if (!active?.id || isStreaming) return;
    const id = await createNewSession(active.id);
    if (!id) return;
    // Niente auto-rename: la nuova sessione mostrerà summary (primo
    // messaggio dell'utente) o timestamp finché l'utente non clicca pencil.
    setActiveSession(active.id, id);
    useStore.getState().resetSession();
    void refresh();
  };

  const startRename = (s: SessionMeta) => {
    setEditingId(s.id);
    setDraftName(s.name ?? '');
  };

  const commitRename = async () => {
    if (!editingId || !active?.id) return;
    const id = editingId;
    const name = draftName.trim();
    setEditingId(null);
    await renameSession(active.id, id, name);
    void refresh();
  };

  const cancelRename = () => setEditingId(null);

  const requestDelete = (id: string) => setConfirmDelete(id);

  const doDelete = async (id: string) => {
    if (!active?.id) return;
    const wasActive = currentId === id;
    await deleteConversation(active.id, id);
    setConfirmDelete(null);
    // Se era la sessione attiva: fallback alla più recente rimasta.
    if (wasActive) {
      setActiveSession(active.id, undefined);
      useStore.getState().resetSession();
      const remaining = await listSessions(active.id);
      setSessions(remaining);
      const fallback = remaining[0]?.id;
      if (fallback) {
        setActiveSession(active.id, fallback);
        const snap = await loadConversation(active.id, fallback);
        if (snap) useStore.getState().hydrateConversation(snap);
      }
    } else {
      void refresh();
    }
  };

  return (
    <div className="sessions-list">
      <div className="sessions-list__rows">
        {sessions.length === 0 && (
          <div className="sessions-list__empty">no sessions yet</div>
        )}
        {sessions.map((s) => {
          const isActive = s.id === currentId;
          const isEditing = editingId === s.id;
          return (
            <div
              key={s.id}
              className={`sessions-list__row ${isActive ? 'sessions-list__row--active' : ''}`}
              onClick={() => !isEditing && switchTo(s.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (isEditing) return;
                if (e.key === 'Enter' || e.key === ' ') switchTo(s.id);
              }}
              title={s.id}
            >
              <span className={`sessions-list__dot ${isActive ? 'sessions-list__dot--on' : ''}`} />

              {isEditing ? (
                <input
                  autoFocus
                  className="sessions-list__name-input"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') void commitRename();
                    else if (e.key === 'Escape') cancelRename();
                  }}
                  onBlur={() => void commitRename()}
                  placeholder={`${active.name} N`}
                />
              ) : (
                <span className="sessions-list__name">{displayName(s)}</span>
              )}

              {!isEditing && confirmDelete !== s.id && (
                <>
                  <button
                    type="button"
                    className="sessions-list__rename"
                    title="rename"
                    onClick={(e) => { e.stopPropagation(); startRename(s); }}
                  >
                    <PencilIcon size={14} />
                  </button>
                  <button
                    type="button"
                    className="sessions-list__delete"
                    title="delete session"
                    onClick={(e) => { e.stopPropagation(); requestDelete(s.id); }}
                    disabled={isStreaming}
                  >
                    <TrashIcon size={14} />
                  </button>
                </>
              )}

              {confirmDelete === s.id && (
                <div className="sessions-list__confirm" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="sessions-list__confirm-cancel"
                    onClick={() => setConfirmDelete(null)}
                  >
                    cancel
                  </button>
                  <button
                    type="button"
                    className="sessions-list__confirm-delete"
                    onClick={() => void doDelete(s.id)}
                  >
                    delete
                  </button>
                </div>
              )}

              <span className="sessions-list__meta">
                {formatDate(s.updatedAt)} · {s.messageCount} msg
              </span>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="sessions-list__new"
        onClick={() => void createNew()}
        disabled={isStreaming}
        title="start a new conversation"
      >
        + new session
      </button>
    </div>
  );
}

function displayName(s: SessionMeta): string {
  if (s.name?.trim()) return s.name;
  if (s.summary) return s.summary.slice(0, 60);
  return formatDate(s.updatedAt);
}

function formatDate(t: number): string {
  const d = new Date(t);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
         ' ' +
         d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
