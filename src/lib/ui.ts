import { create } from 'zustand';

/** Quale sezione è aperta nel pannello destro. `null` = tutto chiuso (rail soltanto). */
export type RightPanelMode = 'files' | 'git' | 'editor' | null;

type UIState = {
  settingsOpen: boolean;
  /** Sidebar sinistra (sessions list) — espansa o collassata in rail. */
  sidebarOpen: boolean;
  terminalOpen: boolean;
  themePickerOpen: boolean;
  /** quick-open modal (fuzzy finder file, ⌘P) */
  quickOpenOpen: boolean;
  /** project-switcher modal (fuzzy finder progetti, ⌘O) */
  projectSwitcherOpen: boolean;
  /** Pannello destro: quale sezione è visibile. `null` = solo rail icone. */
  rightPanelMode: RightPanelMode;
  setRightPanelMode: (mode: RightPanelMode) => void;
  /** Toggle: se mode è già attivo → chiude (`null`); altrimenti apre quel mode. */
  toggleRightPanel: (mode: Exclude<RightPanelMode, null>) => void;
  /** Apre il pannello destro su 'editor' (usato dopo un setActiveFile programmatico). */
  openEditorPanel: () => void;
  /** true/false dopo il primo poll di /api/git/status per il progetto attivo;
   *  null = non ancora controllato. Usato per nascondere l'icona git se non
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
  terminalOpen: false,
  rightPanelMode: null,
  setRightPanelMode: (mode) => set({ rightPanelMode: mode }),
  toggleRightPanel: (mode) =>
    set((s) => ({ rightPanelMode: s.rightPanelMode === mode ? null : mode })),
  openEditorPanel: () => set({ rightPanelMode: 'editor' }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
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
