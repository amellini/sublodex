import { create } from 'zustand';

/** Quale sezione è aperta nel pannello destro. `null` = tutto chiuso (rail soltanto). */
export type RightPanelMode = 'files' | 'git' | 'editor' | null;

/** Modalità della sidebar sinistra (espansa). 'sessions' = lista sessioni di chat;
 *  'openspec' = albero della cartella `openspec/` con editor Milkdown nel center.
 *  Visibile solo se il progetto ha effettivamente una cartella `openspec/`. */
export type SidebarMode = 'sessions' | 'openspec';

/** Tab del center pane. La tab "session" è sempre presente e non chiudibile.
 *  Le tab "spec" si aggiungono on-demand quando l'utente apre un file dal
 *  tree OpenSpec. `id` è derivato (vedi `centerTabId`). */
export type CenterTab =
  | { kind: 'session' }
  | { kind: 'spec'; path: string };

export const SESSION_TAB_ID = 'session';
export function centerTabId(t: CenterTab): string {
  return t.kind === 'session' ? SESSION_TAB_ID : `spec:${t.path}`;
}

type UIState = {
  settingsOpen: boolean;
  /** Sidebar sinistra (sessions list / openspec tree) — espansa o collassata in rail. */
  sidebarOpen: boolean;
  /** Quale "vista" mostra la sidebar sinistra quando è espansa. */
  sidebarMode: SidebarMode;
  setSidebarMode: (m: SidebarMode) => void;
  /** true/false dopo il primo poll di /api/openspec/status per il progetto attivo;
   *  null = non ancora controllato. Quando true, abilita rail icon + mode-tab. */
  hasOpenspec: boolean | null;
  setHasOpenspec: (v: boolean | null) => void;
  /** Tabs del center pane. La prima è SEMPRE { kind: 'session' }. */
  centerTabs: CenterTab[];
  /** id (`session` | `spec:<path>`) della tab attualmente visibile. */
  activeCenterTab: string;
  setActiveCenterTab: (id: string) => void;
  /** Apre (o riattiva) una tab spec. Path relativo al project root, es.
   *  `openspec/changes/foo/proposal.md`. */
  openSpecTab: (specPath: string) => void;
  /** Chiude una tab spec. Se era attiva, fallback alla session. */
  closeSpecTab: (specPath: string) => void;
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
  sidebarMode: 'sessions',
  setSidebarMode: (m) => set({ sidebarMode: m }),
  hasOpenspec: null,
  setHasOpenspec: (v) => set({ hasOpenspec: v }),
  centerTabs: [{ kind: 'session' }],
  activeCenterTab: SESSION_TAB_ID,
  setActiveCenterTab: (id) => set({ activeCenterTab: id }),
  openSpecTab: (specPath) =>
    set((s) => {
      const id = `spec:${specPath}`;
      const exists = s.centerTabs.some((t) => t.kind === 'spec' && t.path === specPath);
      const tabs = exists ? s.centerTabs : [...s.centerTabs, { kind: 'spec', path: specPath } as CenterTab];
      return { centerTabs: tabs, activeCenterTab: id };
    }),
  closeSpecTab: (specPath) =>
    set((s) => {
      const id = `spec:${specPath}`;
      const tabs = s.centerTabs.filter((t) => !(t.kind === 'spec' && t.path === specPath));
      const active = s.activeCenterTab === id ? SESSION_TAB_ID : s.activeCenterTab;
      return { centerTabs: tabs, activeCenterTab: active };
    }),
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
