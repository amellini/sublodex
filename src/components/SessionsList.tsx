import { useCallback, useEffect, useState } from 'react';
import { useUI } from '../lib/ui';
import { useStore } from '../lib/store';
import { useSettings, activeProject, setActiveProject } from '../lib/settings';
import {
  createNewSession,
  deleteConversation,
  listAllSessions,
  loadConversation,
  renameSession,
  type ProjectSessionGroup,
  type SessionMeta,
} from '../lib/conversation';
import { ChevronRight, PencilIcon, TrashIcon } from './icons';

/** Sidebar tab: lista sessioni di TUTTI i progetti, raggruppata per progetto.
 *  - Progetti ordinati: quello con interazione più recente in alto.
 *  - Sessioni ordinate per `updatedAt` desc all'interno del gruppo.
 *  - Progetto attivo: nome in accent.
 *  - Sessione attiva (del progetto attivo): bullet verde pieno.
 *  - Click su sessione di un altro progetto → switch project + switch session. */
export function SessionsList() {
  const settings = useSettings((s) => s.settings);
  const active = activeProject(settings);
  const activeSessionByProject = useUI((s) => s.activeSessionByProject);
  const setActiveSession = useUI((s) => s.setActiveSession);

  const [groups, setGroups] = useState<ProjectSessionGroup[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<{ projectId: string; sessionId: string } | null>(null);
  const [editing, setEditing] = useState<{ projectId: string; sessionId: string } | null>(null);
  const [draftName, setDraftName] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const isStreaming = useStore((s) => s.isStreaming);
  const turns = useStore((s) => s.turns);

  const refresh = useCallback(async () => {
    const list = await listAllSessions();
    setGroups(list);
  }, []);

  useEffect(() => { void refresh(); }, [refresh, turns, settings?.projects.length, settings?.activeId]);

  const toggleCollapsed = (projectId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const switchToSession = async (projectId: string, sessionId: string) => {
    if (isStreaming) return;
    if (active?.id !== projectId) {
      // Cross-project: cambia prima il progetto attivo, poi la sua session.
      setActiveSession(projectId, sessionId);
      await setActiveProject(projectId);
      // L'effect in App.tsx caricherà la conversation della nuova session.
    } else if (sessionId !== activeSessionByProject[projectId]) {
      setActiveSession(projectId, sessionId);
    }
  };

  const createNewIn = async (projectId: string) => {
    if (isStreaming) return;
    const id = await createNewSession(projectId);
    if (!id) return;
    if (active?.id !== projectId) {
      setActiveSession(projectId, id);
      await setActiveProject(projectId);
    } else {
      setActiveSession(projectId, id);
      useStore.getState().resetSession();
    }
    void refresh();
  };

  const startRename = (projectId: string, s: SessionMeta) => {
    setEditing({ projectId, sessionId: s.id });
    setDraftName(s.name ?? '');
  };

  const commitRename = async () => {
    if (!editing) return;
    const { projectId, sessionId } = editing;
    const name = draftName.trim();
    setEditing(null);
    await renameSession(projectId, sessionId, name);
    void refresh();
  };

  const cancelRename = () => setEditing(null);

  const requestDelete = (projectId: string, sessionId: string) => {
    setConfirmDelete({ projectId, sessionId });
  };

  const doDelete = async (projectId: string, sessionId: string) => {
    const wasActive =
      active?.id === projectId && activeSessionByProject[projectId] === sessionId;
    await deleteConversation(projectId, sessionId);
    setConfirmDelete(null);
    if (wasActive) {
      setActiveSession(projectId, undefined);
      useStore.getState().resetSession();
      const fresh = await listAllSessions();
      setGroups(fresh);
      const grp = fresh.find((g) => g.projectId === projectId);
      const fallback = grp?.sessions[0]?.id;
      if (fallback) {
        setActiveSession(projectId, fallback);
        const snap = await loadConversation(projectId, fallback);
        if (snap) useStore.getState().hydrateConversation(snap);
      }
    } else {
      void refresh();
    }
  };

  if (groups.length === 0) {
    return <div className="sessions-list__empty">no projects yet</div>;
  }

  return (
    <div className="sessions-list">
      <div className="sessions-list__rows">
        {groups.map((g) => {
          const isActiveProject = active?.id === g.projectId;
          const isCollapsed = collapsed.has(g.projectId);
          const activeSidForProject = isActiveProject
            ? activeSessionByProject[g.projectId]
            : undefined;
          return (
            <div key={g.projectId} className="sessions-group">
              <div className="sessions-group__head">
                <button
                  className="sessions-group__toggle"
                  onClick={() => toggleCollapsed(g.projectId)}
                  title={isCollapsed ? 'expand' : 'collapse'}
                >
                  <ChevronRight
                    size={10}
                    className={`sessions-group__chev ${isCollapsed ? '' : 'sessions-group__chev--open'}`}
                  />
                </button>
                <span
                  className={`sessions-group__name ${isActiveProject ? 'sessions-group__name--active' : ''}`}
                  title={g.projectName}
                >
                  {g.projectName}
                </span>
                <button
                  className="sessions-group__add"
                  onClick={() => void createNewIn(g.projectId)}
                  disabled={isStreaming}
                  title="new session in this project"
                >
                  +
                </button>
              </div>

              {!isCollapsed && g.sessions.length === 0 && (
                <div className="sessions-group__empty">no sessions yet</div>
              )}

              {!isCollapsed && g.sessions.map((s) => {
                const isActiveSession = s.id === activeSidForProject;
                const isEditing =
                  editing?.projectId === g.projectId && editing.sessionId === s.id;
                const isConfirming =
                  confirmDelete?.projectId === g.projectId && confirmDelete.sessionId === s.id;
                return (
                  <div
                    key={s.id}
                    className={`sessions-list__row ${isActiveSession ? 'sessions-list__row--active' : ''}`}
                    onClick={() => !isEditing && void switchToSession(g.projectId, s.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (isEditing) return;
                      if (e.key === 'Enter' || e.key === ' ') void switchToSession(g.projectId, s.id);
                    }}
                    title={s.id}
                  >
                    <span
                      className={`sessions-list__dot ${isActiveSession ? 'sessions-list__dot--on' : ''}`}
                    />

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
                      />
                    ) : (
                      <span className="sessions-list__name">{displayName(s)}</span>
                    )}

                    {!isEditing && !isConfirming && (
                      <>
                        <button
                          type="button"
                          className="sessions-list__rename"
                          title="rename"
                          onClick={(e) => { e.stopPropagation(); startRename(g.projectId, s); }}
                        >
                          <PencilIcon size={14} />
                        </button>
                        <button
                          type="button"
                          className="sessions-list__delete"
                          title="delete session"
                          onClick={(e) => { e.stopPropagation(); requestDelete(g.projectId, s.id); }}
                          disabled={isStreaming}
                        >
                          <TrashIcon size={14} />
                        </button>
                      </>
                    )}

                    {isConfirming && (
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
                          onClick={() => void doDelete(g.projectId, s.id)}
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
          );
        })}
      </div>
    </div>
  );
}

function displayName(s: SessionMeta): string {
  if (s.name?.trim()) return s.name;
  if (s.summary) return s.summary.slice(0, 60);
  return formatDate(s.updatedAt);
}

function formatDate(t: number): string {
  if (!t) return '';
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
