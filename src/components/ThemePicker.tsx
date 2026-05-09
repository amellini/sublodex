import { useState } from 'react';
import { useTheme, resolveTheme, type ThemeSettings } from '../lib/themeStore';
import { THEMES, THEME_LIST, type ThemeId, type Scope } from '../lib/themes';

const SCOPE_TABS: { id: Scope; label: string; hint: string }[] = [
  { id: 'global',   label: 'Global',   hint: 'All panels at once' },
  { id: 'editor',   label: 'Editor',   hint: 'Monaco code editor (right)' },
  { id: 'center',   label: 'Chat',     hint: 'Conversation panel (center)' },
  { id: 'sidebar',  label: 'Sidebar',  hint: 'Commands & files (left)' },
  { id: 'terminal', label: 'Terminal', hint: 'Shell panel (bottom)' },
];

export function ThemePicker({ onClose }: { onClose: () => void }) {
  const t = useTheme();
  const [scope, setScope] = useState<Scope>('global');

  const currentForScope = (sc: Scope): ThemeId | null => {
    if (sc === 'global') return t.global;
    // Cast a ThemeSettings (parent) per indicizzare solo le proprietà
    // dati, escludendo i metodi action dello ZustandStore.
    return (t as ThemeSettings)[sc] ?? null;
  };

  const setForScope = (id: ThemeId | null) => {
    if (scope === 'global') {
      if (id !== null) t.setGlobal(id);
    } else {
      t.setScope(scope, id);
    }
  };

  const inheritedId = scope !== 'global' ? resolveTheme(t, scope as Exclude<Scope, 'global'>) : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--themes" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">Themes</h2>
          <button className="header__btn" onClick={onClose}>✕</button>
        </div>

        <div className="tp__tabs">
          {SCOPE_TABS.map((s) => (
            <button
              key={s.id}
              className={`tp__tab ${scope === s.id ? 'tp__tab--active' : ''}`}
              onClick={() => setScope(s.id)}
            >
              <span className="tp__tab-label">{s.label}</span>
              <span className="tp__tab-hint">{s.hint}</span>
            </button>
          ))}
        </div>

        <div className="tp__body">
          {scope !== 'global' && (
            <button
              className={`tp__card tp__card--inherit ${currentForScope(scope) === null ? 'tp__card--selected' : ''}`}
              onClick={() => setForScope(null)}
            >
              <div className="tp__card-name">Inherit from global</div>
              <div className="tp__card-sub">Currently using <strong>{THEMES[inheritedId!].label}</strong></div>
            </button>
          )}

          <div className="tp__grid">
            {THEME_LIST.map((th) => {
              const selected = currentForScope(scope) === th.id;
              return (
                <button
                  key={th.id}
                  className={`tp__card ${selected ? 'tp__card--selected' : ''}`}
                  onClick={() => setForScope(th.id)}
                >
                  <div className="tp__preview">
                    <Preview theme={th.colors} />
                  </div>
                  <div className="tp__card-meta">
                    <span className="tp__card-name">{th.label}</span>
                    <span className={`tp__chip tp__chip--${th.isDark ? 'dark' : 'light'}`}>
                      {th.isDark ? 'Dark' : 'Light'}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="modal__foot">
          <button
            className="header__btn"
            onClick={() => t.resetAll()}
            title="Reset all scopes to monokai"
          >
            Reset all
          </button>
          <span className="modal__spacer" />
          <button className="header__btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/** Mini-mockup del layout: barra+sidebar+chat+editor+terminal in colori del tema. */
function Preview({ theme }: { theme: typeof THEMES[ThemeId]['colors'] }) {
  return (
    <svg viewBox="0 0 200 130" xmlns="http://www.w3.org/2000/svg" className="tp__preview-svg">
      {/* bg */}
      <rect width="200" height="130" fill={theme.bg} />
      {/* header */}
      <rect x="0" y="0" width="200" height="14" fill={theme.bgElev} />
      <rect x="6" y="5" width="6" height="4" fill={theme.accent} rx="1" />
      <rect x="16" y="5" width="22" height="4" fill={theme.fgDim} rx="1" />
      <rect x="174" y="5" width="20" height="4" fill={theme.fgMute} rx="1" />
      {/* sidebar */}
      <rect x="0" y="14" width="22" height="116" fill={theme.bgElev} />
      <rect x="5" y="20" width="12" height="3" fill={theme.accent} rx="1" />
      <rect x="5" y="28" width="12" height="3" fill={theme.fgMute} rx="1" />
      <rect x="5" y="36" width="12" height="3" fill={theme.fgMute} rx="1" />
      <rect x="5" y="44" width="12" height="3" fill={theme.fgMute} rx="1" />
      {/* center */}
      <rect x="22" y="14" width="100" height="92" fill={theme.bg} />
      <rect x="28" y="22" width="40" height="3" fill={theme.accent} rx="1" />
      <rect x="28" y="29" width="80" height="3" fill={theme.fgDim} rx="1" />
      <rect x="28" y="35" width="60" height="3" fill={theme.fgDim} rx="1" />
      <rect x="28" y="44" width="50" height="3" fill={theme.accent2} rx="1" />
      <rect x="28" y="51" width="80" height="3" fill={theme.fgDim} rx="1" />
      <rect x="28" y="57" width="70" height="3" fill={theme.fgDim} rx="1" />
      <rect x="28" y="65" width="86" height="14" fill={theme.bgCard} rx="2" />
      <rect x="32" y="69" width="8" height="2" fill={theme.green} rx="1" />
      <rect x="44" y="69" width="50" height="2" fill={theme.fgMute} rx="1" />
      <rect x="32" y="73" width="40" height="2" fill={theme.yellow} rx="1" />
      <rect x="28" y="84" width="80" height="3" fill={theme.fgDim} rx="1" />
      <rect x="28" y="90" width="60" height="3" fill={theme.fgDim} rx="1" />
      {/* composer */}
      <rect x="22" y="106" width="100" height="24" fill={theme.bgCard} />
      <rect x="28" y="113" width="86" height="3" fill={theme.fgMute} rx="1" />
      <rect x="100" y="121" width="14" height="5" fill={theme.accent} rx="1" />
      {/* editor */}
      <rect x="122" y="14" width="78" height="92" fill={theme.bg} />
      <rect x="122" y="14" width="78" height="8" fill={theme.bgDeep} />
      <rect x="126" y="17" width="14" height="3" fill={theme.accent} rx="1" />
      <rect x="143" y="17" width="14" height="3" fill={theme.fgMute} rx="1" />
      {/* code lines */}
      <rect x="128" y="28" width="6" height="2" fill={theme.purple} rx="1" />
      <rect x="138" y="28" width="20" height="2" fill={theme.green} rx="1" />
      <rect x="128" y="34" width="14" height="2" fill={theme.red} rx="1" />
      <rect x="146" y="34" width="14" height="2" fill={theme.blue} rx="1" />
      <rect x="164" y="34" width="20" height="2" fill={theme.yellow} rx="1" />
      <rect x="128" y="40" width="10" height="2" fill={theme.fgMute} rx="1" />
      <rect x="142" y="40" width="40" height="2" fill={theme.fgDim} rx="1" />
      <rect x="132" y="46" width="20" height="2" fill={theme.blue} rx="1" />
      <rect x="156" y="46" width="14" height="2" fill={theme.green} rx="1" />
      <rect x="128" y="52" width="6" height="2" fill={theme.purple} rx="1" />
      <rect x="138" y="52" width="50" height="2" fill={theme.yellow} rx="1" />
      <rect x="128" y="58" width="40" height="2" fill={theme.fgMute} rx="1" />
      <rect x="128" y="64" width="14" height="2" fill={theme.red} rx="1" />
      <rect x="146" y="64" width="30" height="2" fill={theme.fgDim} rx="1" />
      <rect x="128" y="70" width="6" height="2" fill={theme.purple} rx="1" />
      <rect x="138" y="70" width="20" height="2" fill={theme.green} rx="1" />
      {/* terminal */}
      <rect x="22" y="106" width="178" height="24" fill={theme.bgDeep} />
      <rect x="22" y="106" width="178" height="6" fill={theme.bgElev} />
      <rect x="26" y="108" width="20" height="2" fill={theme.accent} rx="1" />
      <rect x="28" y="116" width="6" height="2" fill={theme.green} rx="1" />
      <rect x="38" y="116" width="40" height="2" fill={theme.fgDim} rx="1" />
      <rect x="28" y="122" width="50" height="2" fill={theme.yellow} rx="1" />
    </svg>
  );
}
