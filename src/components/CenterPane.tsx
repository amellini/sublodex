import { useRef } from 'react';
import { Conversation } from './Conversation';
import { Composer } from './Composer';
import { PermissionPrompt } from './PermissionPrompt';
import { SpecEditorPane } from './SpecEditorPane';
import { useUI, SESSION_TAB_ID, centerTabId } from '../lib/ui';
import { useScopedTheme } from './ThemeApplier';

/** Center pane multi-tab.
 *  - Tab "session" sempre presente, non chiudibile, mai smontata
 *    (nascondiamo con `display:none` per preservare scroll, draft del Composer
 *    e streaming Claude in background).
 *  - Tab "spec" si aggiungono on-demand (vedi useUI.openSpecTab) e vengono
 *    montate solo se attive — il loro stato è locale al pane (key=path) e
 *    si ricarica al riapertura. */
export function CenterPane() {
  const ref = useRef<HTMLDivElement>(null);
  useScopedTheme(ref, 'center');

  const tabs = useUI((s) => s.centerTabs);
  const activeId = useUI((s) => s.activeCenterTab);
  const setActive = useUI((s) => s.setActiveCenterTab);
  const closeSpecTab = useUI((s) => s.closeSpecTab);

  const hasSpecTabs = tabs.some((t) => t.kind === 'spec');

  return (
    <div className="center" ref={ref}>
      {hasSpecTabs && (
        <div className="center__tabs">
          {tabs.map((t) => {
            const id = centerTabId(t);
            const active = id === activeId;
            if (t.kind === 'session') {
              return (
                <div key={id} className={`tab ${active ? 'tab--active' : ''}`}>
                  <button className="tab__select" onClick={() => setActive(id)} title="Chat session">
                    <span className="tab__name">Session</span>
                  </button>
                </div>
              );
            }
            const fileName = t.path.split('/').pop() ?? t.path;
            return (
              <div key={id} className={`tab ${active ? 'tab--active' : ''}`}>
                <button className="tab__select" onClick={() => setActive(id)} title={t.path}>
                  <span className="tab__name">{fileName}</span>
                </button>
                <button
                  className="tab__close"
                  onClick={(e) => { e.stopPropagation(); closeSpecTab(t.path); }}
                  title="Close"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Session sempre montata: hidden quando non attiva. Necessario per non
          interrompere lo streaming di Claude e preservare lo stato del Composer. */}
      <div className="center__pane" style={{ display: activeId === SESSION_TAB_ID ? 'flex' : 'none' }}>
        <Conversation />
        <PermissionPrompt />
        <Composer />
      </div>

      {/* Spec pane: monta solo la tab attiva (key=path → reset stato locale al
          cambio file). Le altre tab spec sono "lazy" — riapertura ricarica dal disco. */}
      {tabs.map((t) => {
        if (t.kind !== 'spec') return null;
        const id = centerTabId(t);
        if (id !== activeId) return null;
        return (
          <div key={id} className="center__pane center__pane--spec">
            <SpecEditorPane key={t.path} filePath={t.path} />
          </div>
        );
      })}
    </div>
  );
}
