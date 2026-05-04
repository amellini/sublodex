import { create } from 'zustand';
import type { Project, Settings } from './types';

type State = {
  settings: Settings | null;
  loading: boolean;
  error?: string;
  load: () => Promise<void>;
  save: (s: Settings) => Promise<boolean>;
};

export const useSettings = create<State>((set) => ({
  settings: null,
  loading: false,

  load: async () => {
    set({ loading: true });
    try {
      const r = await fetch('/api/settings');
      const data = (await r.json()) as Settings;
      set({ settings: data, loading: false, error: undefined });
    } catch (err) {
      set({ loading: false, error: String(err) });
    }
  },

  save: async (full) => {
    set({ loading: true });
    try {
      const r = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(full),
      });
      if (!r.ok) {
        set({ loading: false, error: await r.text() });
        return false;
      }
      const data = (await r.json()) as Settings;
      set({ settings: data, loading: false, error: undefined });
      return true;
    } catch (err) {
      set({ loading: false, error: String(err) });
      return false;
    }
  },
}));

export function activeProject(s: Settings | null): Project | null {
  if (!s) return null;
  return s.projects.find((p) => p.id === s.activeId) ?? s.projects[0] ?? null;
}

/** Cambia il progetto attivo e bumpa `lastUsedAt` sul progetto scelto.
 *  Centralizza la persistenza: ProjectSwitcher e SettingsModal devono
 *  passare di qui per garantire che l'ordine "recenti" si mantenga. */
export async function setActiveProject(id: string): Promise<boolean> {
  const cur = useSettings.getState().settings;
  if (!cur) return false;
  const next: Settings = {
    ...cur,
    activeId: id,
    projects: cur.projects.map((p) =>
      p.id === id ? { ...p, lastUsedAt: Date.now() } : p,
    ),
  };
  return useSettings.getState().save(next);
}
