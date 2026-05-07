import { useEffect, useRef } from 'react';
import { connect } from './lib/ws';
import { useStore } from './lib/store';
import { useSettings, activeProject } from './lib/settings';
import { useUI } from './lib/ui';
import { createNewSession, loadConversation } from './lib/conversation';
import { Layout } from './components/Layout';
import { Logo } from './components/Logo';
import { SettingsModal } from './components/Settings';
import { ThemePicker } from './components/ThemePicker';
import { QuickOpen } from './components/QuickOpen';
import { ProjectSwitcher } from './components/ProjectSwitcher';
import { Extensions } from './components/Extensions';
import { HeaderCommandPalette } from './components/HeaderCommandPalette';
import { HeaderMenu, type HeaderMenuItem } from './components/HeaderMenu';
import { useScopedTheme } from './components/ThemeApplier';
import { conversationToMarkdown, downloadMarkdown } from './lib/exportConversation';

/** Costruisce le voci del menu header in base allo stato corrente.
 *  Estratta come funzione pura (fuori dal component) per chiarezza:
 *  l'array è "data" e tenerlo separato dal JSX rende ovvio cosa è
 *  configurazione vs cosa è layout. */
function buildHeaderMenuItems(args: {
  openQuickOpen: () => void;
  messageCount: number;
  activeName?: string;
  terminalOpen: boolean;
  toggleTerminal: () => void;
  openExtensions: () => void;
  openThemePicker: () => void;
  openSettings: () => void;
}): HeaderMenuItem[] {
  const {
    openQuickOpen, messageCount, activeName,
    terminalOpen, toggleTerminal,
    openExtensions, openThemePicker, openSettings,
  } = args;

  const items: (HeaderMenuItem | null)[] = [
    {
      kind: 'action',
      id: 'find',
      label: 'find',
      icon: '🔍',
      title: 'find file (⌘P or ⌘K)',
      onClick: openQuickOpen,
    },
    // Export è condizionale: se non ci sono messaggi, l'azione è priva di senso.
    // Coerente col comportamento precedente (button completamente nascosto).
    messageCount > 0
      ? {
          kind: 'action' as const,
          id: 'export',
          label: 'export',
          icon: '⇣',
          title: 'export conversation as markdown',
          onClick: () => {
            const msgs = useStore.getState().messages;
            if (msgs.length === 0) return;
            const slug = (activeName ?? 'conversation').toLowerCase().replace(/[^a-z0-9]+/g, '-');
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            downloadMarkdown(`${slug}-${stamp}.md`, conversationToMarkdown(msgs, activeName));
          },
        }
      : null,
    { kind: 'divider' },
    {
      kind: 'action',
      id: 'terminal',
      label: terminalOpen ? 'close terminal' : 'terminal',
      icon: '>_',
      active: terminalOpen,
      title: terminalOpen ? 'close terminal' : 'open terminal in project root',
      onClick: toggleTerminal,
    },
    {
      kind: 'action',
      id: 'extensions',
      label: 'extensions',
      icon: '🔌',
      title: 'installed plugins, MCP servers, hooks',
      onClick: openExtensions,
    },
    {
      kind: 'action',
      id: 'theme',
      label: 'theme',
      icon: '🎨',
      title: 'theme',
      onClick: openThemePicker,
    },
    { kind: 'divider' },
    {
      kind: 'action',
      id: 'projects',
      label: 'projects',
      icon: '📁',
      title: 'manage projects & settings',
      onClick: openSettings,
    },
  ];
  // Filter dei null (export quando assente) preservando il narrowing del type.
  return items.filter((x): x is HeaderMenuItem => x !== null);
}

export default function App() {
  const appRef = useRef<HTMLDivElement>(null);
  useScopedTheme(appRef, 'global');

  const sessionId = useStore((s) => s.sessionId);
  const isStreaming = useStore((s) => s.isStreaming);
  const lastError = useStore((s) => s.lastError);
  const resetSession = useStore((s) => s.resetSession);

  const settings = useSettings((s) => s.settings);
  const loadSettings = useSettings((s) => s.load);
  const active = activeProject(settings);

  const messageCount = useStore((s) => s.messages.length);
  const setIsGitRepo = useUI((s) => s.setIsGitRepo);
  const activeSessionByProject = useUI((s) => s.activeSessionByProject);
  const setActiveSession = useUI((s) => s.setActiveSession);

  const settingsOpen = useUI((s) => s.settingsOpen);
  const openSettings = useUI((s) => s.openSettings);
  const closeSettings = useUI((s) => s.closeSettings);
  const terminalOpen = useUI((s) => s.terminalOpen);
  const toggleTerminal = useUI((s) => s.toggleTerminal);
  const themePickerOpen = useUI((s) => s.themePickerOpen);
  const openThemePicker = useUI((s) => s.openThemePicker);
  const closeThemePicker = useUI((s) => s.closeThemePicker);
  const extensionsOpen = useUI((s) => s.extensionsOpen);
  const openExtensions = useUI((s) => s.openExtensions);
  const closeExtensions = useUI((s) => s.closeExtensions);

  useEffect(() => {
    connect();
    void loadSettings();
  }, [loadSettings]);

  // ⌘P / ⌘K (Ctrl+P / Ctrl+K) → fuzzy file finder. Listener su window in
  // capture phase così precediamo eventuali handler della WebView Tauri.
  // Doppio shortcut: ⌘P per chi viene da VS Code, ⌘K come fallback se l'OS
  // intercetta ⌘P (Print). Inoltre c'è un bottone "find" nell'header.
  const openQuickOpen = useUI((s) => s.openQuickOpen);
  const openProjectSwitcher = useUI((s) => s.openProjectSwitcher);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey || e.altKey) return;
      if (e.key === 'p' || e.key === 'P' || e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        e.stopPropagation();
        openQuickOpen();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [openQuickOpen]);

  // ⌘O / Ctrl+O → ProjectSwitcher. Capture phase + preventDefault per
  // bypassare l'azione browser "open file" e l'eventuale handler della
  // WebView Tauri.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey || e.altKey) return;
      if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        e.stopPropagation();
        openProjectSwitcher();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [openProjectSwitcher]);

  // Quando il progetto attivo o la session cambiano, carica la conversazione
  // corrispondente. Se la session su localStorage non esiste più sul disco,
  // il backend ricade sulla più recente.
  const lastLoadedRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!active) return;
    const wantSession = activeSessionByProject[active.id];
    const key = `${active.id}::${wantSession ?? '_default'}`;
    if (lastLoadedRef.current === key) return;
    lastLoadedRef.current = key;
    void loadConversation(active.id, wantSession).then((snap) => {
      if (snap && snap.messages !== undefined) {
        useStore.getState().hydrateConversation(snap);
        // Se backend ha scelto una session diversa (perché wantSession non
        // esisteva o non era passata), allinea localStorage. Se invece il
        // wantSession ESISTEVA ma è stata cancellata fuori-app, snap arriverà
        // vuoto e __sessionFsId punterà alla nuova default — anche qui
        // riallineiamo così alla prossima esecuzione partiamo da quella.
        if (snap.__sessionFsId && snap.__sessionFsId !== wantSession) {
          setActiveSession(active.id, snap.__sessionFsId);
        }
      } else {
        useStore.getState().resetSession();
      }
    });
  }, [active?.id, activeSessionByProject, setActiveSession]);

  // isGitRepo del progetto attivo: refresh on project change. Lo usiamo
  // per nascondere il tab GIT della sidebar se non è un repo.
  useEffect(() => {
    if (!active?.id) return;
    setIsGitRepo(null);
    let cancelled = false;
    fetch('/api/git/status')
      .then((r) => (r.ok ? r.json() : { isGitRepo: false }))
      .then((j: { isGitRepo: boolean }) => {
        if (!cancelled) setIsGitRepo(!!j.isGitRepo);
      })
      .catch(() => { if (!cancelled) setIsGitRepo(false); });
    return () => { cancelled = true; };
  }, [active?.id, setIsGitRepo]);

  return (
    <div className="app" ref={appRef}>
      <header className="header">
        <span className="header__title">
          <Logo size={20} />
          <span className="header__title-text">SublodeX</span>
        </span>
        {active && (
          <button
            className="header__project"
            title={active.remote ? `${active.name} on ${active.remote.user ? active.remote.user + '@' : ''}${active.remote.host}:${active.path}` : active.path}
            onClick={openProjectSwitcher}
          >
            {active.name}
            {active.remote && <span className="header__project-ssh">ssh</span>}
            <span className="header__project-chevron" aria-hidden="true"> ▾</span>
          </button>
        )}
        {sessionId && (
          <span className="header__session" title={sessionId}>{sessionId.slice(0, 8)}</span>
        )}
        {isStreaming && <span className="header__working">claude is working…</span>}
        <span className="header__spacer" />
        <HeaderCommandPalette />
        {lastError && <span className="header__error" title={lastError}>error</span>}
        {messageCount > 0 && (
          <button
            className="header__btn"
            onClick={async () => {
              if (!active?.id) return;
              const id = await createNewSession(active.id);
              if (id) {
                setActiveSession(active.id, id);
                resetSession();
                lastLoadedRef.current = `${active.id}::${id}`;
              }
            }}
            disabled={isStreaming}
            title="start a new conversation alongside the current one"
          >
            new session
          </button>
        )}
        <HeaderMenu items={buildHeaderMenuItems({
          openQuickOpen,
          messageCount,
          activeName: active?.name,
          terminalOpen,
          toggleTerminal,
          openExtensions,
          openThemePicker,
          openSettings,
        })} />
      </header>

      <main className="main">
        <Layout />
      </main>

      {settingsOpen && <SettingsModal onClose={closeSettings} />}
      {themePickerOpen && <ThemePicker onClose={closeThemePicker} />}
      {extensionsOpen && <Extensions onClose={closeExtensions} />}
      <QuickOpen />
      <ProjectSwitcher />
    </div>
  );
}
