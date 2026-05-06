import type { UIMessage } from './types';

export type ConversationSnapshot = {
  messages: UIMessage[];
  sessionId?: string | null;
  /** Nome user-editable della sessione (default: "<NomeProgetto> N"). */
  name?: string;
  totalCost?: number;
  totalInput?: number;
  totalOutput?: number;
  turns?: number;
  /** id del file su disco usato per questa sessione (server-side) */
  __sessionFsId?: string;
};

export type SessionMeta = {
  id: string;
  /** Nome user-editable. Se assente, la UI mostra `summary` o data. */
  name?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  summary: string;
};

function withSession(projectId: string, sessionId?: string | null): string {
  const base = `projectId=${encodeURIComponent(projectId)}`;
  return sessionId ? `${base}&sessionId=${encodeURIComponent(sessionId)}` : base;
}

export async function loadConversation(
  projectId: string,
  sessionId?: string | null,
): Promise<ConversationSnapshot | null> {
  try {
    const r = await fetch(`/api/conversation?${withSession(projectId, sessionId)}`);
    if (!r.ok) return null;
    return (await r.json()) as ConversationSnapshot;
  } catch {
    return null;
  }
}

export async function saveConversation(
  projectId: string,
  snap: ConversationSnapshot,
  sessionId?: string | null,
): Promise<void> {
  try {
    await fetch(`/api/conversation?${withSession(projectId, sessionId)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snap),
    });
  } catch { /* best effort */ }
}

export async function deleteConversation(
  projectId: string,
  sessionId?: string | null,
): Promise<void> {
  try {
    await fetch(`/api/conversation?${withSession(projectId, sessionId)}`, {
      method: 'DELETE',
    });
  } catch { /* best effort */ }
}

export type ProjectSessionGroup = {
  projectId: string;
  projectName: string;
  lastUsedAt: number;
  /** max(updatedAt sessioni, lastUsedAt) — usato dal backend per ordinare. */
  sortKey: number;
  sessions: SessionMeta[];
};

export async function listAllSessions(): Promise<ProjectSessionGroup[]> {
  try {
    const r = await fetch('/api/conversation/sessions/all');
    if (!r.ok) return [];
    const j = (await r.json()) as { groups: ProjectSessionGroup[] };
    return j.groups ?? [];
  } catch {
    return [];
  }
}

export async function listSessions(projectId: string): Promise<SessionMeta[]> {
  try {
    const r = await fetch(`/api/conversation/sessions?projectId=${encodeURIComponent(projectId)}`);
    if (!r.ok) return [];
    const j = (await r.json()) as { sessions: SessionMeta[] };
    return j.sessions ?? [];
  } catch {
    return [];
  }
}

export async function createNewSession(projectId: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/conversation/sessions?projectId=${encodeURIComponent(projectId)}`, {
      method: 'POST',
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { id: string };
    return j.id ?? null;
  } catch {
    return null;
  }
}

export async function renameSession(
  projectId: string,
  sessionId: string,
  name: string,
): Promise<boolean> {
  try {
    const r = await fetch(
      `/api/conversation/sessions?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionId)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      },
    );
    return r.ok;
  } catch {
    return false;
  }
}
