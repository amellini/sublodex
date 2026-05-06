import { create } from 'zustand';

export type SidebarMode = 'sessions' | 'files' | 'git';

type UIState = {
  settingsOpen: boolean;
  sidebarOpen: boolean;
  sidebarMode: SidebarMode;
  terminalOpen: boolean;
  themePickerOpen: boolean;
  /** id del comando da espandere quando la sidebar viene aperta da una rail icon */
  pendingExpandCommand?: string;
  /** quick-open modal (fuzzy finder file, ⌘P) */
  quickOpenOpen: boolean;
  /** project-switcher modal (fuzzy finder progetti, ⌘O) */
  projectSwitcherOpen: boolean;
  /** true/false dopo il primo poll di /api/git/status per il progetto attivo;
   *  null = non ancora controllato. Usato per nascondere il tab git se non
   *  serve. Refreshato dal GitPanel ad ogni mount/refresh. */
  isGitRepo: boolean | null;
  setIsGitRepo: (v: boolean | null) => void;
  /** Sessione di chat attiva per ogni progetto. Persistito in localStorage
   *  così che riapriendo l'app si ricarica la session su cui eri. */
  activeSessionByProject: Record<string, string | undefined>;
  setActiveSession: (projectId: string, sessionId: string | undefined) => void;
  /** Modal "extensions" — plugin/MCP/hooks installati */
  extensionsOpen: boolean;
  openExtensions: () => void;
  closeExtensions: () => void;
  openSettings: () => void;
  closeSettings: () => void;
  toggleSidebar: () => void;
  openSidebarWith: (commandId?: string) => void;
  setSidebarMode: (mode: SidebarMode) => void;
  openFilesPanel: () => void;
  clearPendingExpand: () => void;
  toggleTerminal: () => void;
  openThemePicker: () => void;
  closeThemePicker: () => void;
  openQuickOpen: () => void;
  closeQuickOpen: () => void;
  openProjectSwitcher: () => void;
  closeProjectSwitcher: () => void;
};

export const useUI = create<UIState>((set) => ({
  settingsOpen: false,
  sidebarOpen: false,
  sidebarMode: 'sessions',
  terminalOpen: false,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  openSidebarWith: (commandId) =>
    set({ sidebarOpen: true, sidebarMode: 'files', pendingExpandCommand: commandId }),
  setSidebarMode: (mode) => set({ sidebarMode: mode }),
  openFilesPanel: () => set({ sidebarOpen: true, sidebarMode: 'files' }),
  clearPendingExpand: () => set({ pendingExpandCommand: undefined }),
  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
  themePickerOpen: false,
  openThemePicker: () => set({ themePickerOpen: true }),
  closeThemePicker: () => set({ themePickerOpen: false }),
  quickOpenOpen: false,
  openQuickOpen: () => set({ quickOpenOpen: true }),
  closeQuickOpen: () => set({ quickOpenOpen: false }),
  projectSwitcherOpen: false,
  openProjectSwitcher: () => set({ projectSwitcherOpen: true }),
  closeProjectSwitcher: () => set({ projectSwitcherOpen: false }),
  isGitRepo: null,
  setIsGitRepo: (v) => set({ isGitRepo: v }),
  activeSessionByProject: (() => {
    try {
      const raw = localStorage.getItem('sublodex.activeSessionByProject');
      if (raw) return JSON.parse(raw) as Record<string, string>;
    } catch { /* */ }
    return {};
  })(),
  setActiveSession: (projectId, sessionId) =>
    set((s) => {
      const next = { ...s.activeSessionByProject };
      if (sessionId === undefined) delete next[projectId];
      else next[projectId] = sessionId;
      try { localStorage.setItem('sublodex.activeSessionByProject', JSON.stringify(next)); } catch { /* */ }
      return { activeSessionByProject: next };
    }),
  extensionsOpen: false,
  openExtensions: () => set({ extensionsOpen: true }),
  closeExtensions: () => set({ extensionsOpen: false }),
}));
