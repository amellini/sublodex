import { useRef } from 'react';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useUI } from '../lib/ui';
import { useSettings, activeProject } from '../lib/settings';
import { SidebarLeft } from './SidebarLeft';
import { SidebarRail } from './SidebarRail';
import { CenterPane } from './CenterPane';
import { RightPanel } from './RightPanel';
import { RightRail } from './RightRail';
import { TerminalPane } from './TerminalPane';
import { useScopedTheme } from './ThemeApplier';

export function Layout() {
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  const rightPanelMode = useUI((s) => s.rightPanelMode);
  const terminalOpen = useUI((s) => s.terminalOpen);
  const toggleTerminal = useUI((s) => s.toggleTerminal);

  const settings = useSettings((s) => s.settings);
  const active = activeProject(settings);

  // Sinistra: SidebarLeft (espansa) o SidebarRail (collassata, thin strip).
  // La sinistra è sempre presente — l'utente la espande/collassa via toggle.
  // Centro: CenterPane (sempre).
  // Destra (opzionale): RightPanel se rightPanelMode !== null.
  // Far right: RightRail (sempre visibile, larghezza fissa, fuori dal PanelGroup).

  const leftSection = sidebarOpen ? (
    <Panel
      key="sidebar-open"
      defaultSize={20}
      minSize={15}
      maxSize={36}
      className="layout__pane"
    >
      <SidebarLeft />
    </Panel>
  ) : null;

  const rightSection = rightPanelMode !== null ? (
    <>
      <PanelResizeHandle className="layout__handle" />
      <Panel
        key={`right-${rightPanelMode}`}
        defaultSize={32}
        minSize={18}
        maxSize={60}
        className="layout__pane"
      >
        <RightPanel />
      </Panel>
    </>
  ) : null;

  // autoSaveId varia con la presenza dei pannelli laterali così
  // react-resizable-panels non ricicla dimensioni stale tra layout diversi.
  const layoutKey = `${sidebarOpen ? 'L' : 'l'}-${rightPanelMode ?? 'none'}`;

  const top = (
    <div className="layout layout--with-rails">
      {!sidebarOpen && <SidebarRail />}
      <PanelGroup
        key={layoutKey}
        direction="horizontal"
        autoSaveId={`cw-${layoutKey}`}
        className="layout__panels"
      >
        {leftSection}
        {leftSection && <PanelResizeHandle className="layout__handle" />}
        <Panel
          defaultSize={sidebarOpen ? 50 : (rightPanelMode ? 60 : 100)}
          minSize={28}
          className="layout__pane"
        >
          <CenterPane />
        </Panel>
        {rightSection}
      </PanelGroup>
      <RightRail />
    </div>
  );

  if (!terminalOpen) {
    return <div className="layout-shell">{top}</div>;
  }

  return (
    <PanelGroup direction="vertical" autoSaveId="cw-vertical" className="layout-shell">
      <Panel defaultSize={65} minSize={20} className="layout-shell__top">
        {top}
      </Panel>
      <PanelResizeHandle className="layout__handle layout__handle--horizontal" />
      <Panel defaultSize={35} minSize={10} className="layout-shell__bottom">
        <TerminalContainer active={active} toggleTerminal={toggleTerminal} />
      </Panel>
    </PanelGroup>
  );
}

function TerminalContainer({ active, toggleTerminal }: {
  active: ReturnType<typeof activeProject>;
  toggleTerminal: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useScopedTheme(ref, 'terminal');

  const remote = active?.remote;
  const remoteLabel = remote
    ? `${remote.user ? remote.user + '@' : ''}${remote.host}${remote.port && remote.port !== 22 ? `:${remote.port}` : ''}`
    : null;
  const termKey = remote ? `ssh:${remoteLabel}:${active?.id ?? ''}` : `local:${active?.id ?? ''}`;

  return (
    <div className="terminal" ref={ref}>
      <div className="terminal__head">
        <span className="terminal__label">Terminal</span>
        <span className="terminal__path">
          {remoteLabel
            ? <><span className="terminal__remote-pill">ssh</span> {remoteLabel}:{active?.path}</>
            : active?.path}
        </span>
        <button className="header__btn" onClick={toggleTerminal} title="Close terminal">✕</button>
      </div>
      {active && <TerminalPane key={termKey} project={active} />}
    </div>
  );
}
