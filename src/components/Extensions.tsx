import { useEffect, useMemo, useState } from 'react';

/* tipi mirror del backend `readPluginsState` */

type PluginInstall = {
  id: string;
  name: string;
  marketplace: string;
  scope: string;
  installPath: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
  gitCommitSha?: string;
  enabled: boolean;
  manifest?: any;
  description?: string;
  exposes: {
    commands: number;
    agents: number;
    skills: number;
    hooks: number;
    mcpServers: number;
    lspServers: number;
  };
  activeForProject: boolean;
};

type SkillEntry = {
  id: string;
  name: string;
  pluginId: string;
  description?: string;
  scope: 'user' | 'project' | 'plugin';
  skillPath: string;
  activeForProject: boolean;
};

/** Shape del campo `source` su un Marketplace.
 *  Il backend (`readPluginsState`) emette varianti diverse a seconda
 *  della provenienza: github (`source: 'github'` + `repo`), URL bare
 *  (`url`), o altri formati ancora ignoti. Manteniamo permissivo via
 *  Record<string, unknown>, e leggiamo i campi attesi come opzionali. */
type MarketplaceSource = {
  source?: string;
  repo?: string;
  url?: string;
} & Record<string, unknown>;

type Marketplace = {
  name: string;
  source: MarketplaceSource;
  installLocation?: string;
  lastUpdated?: string;
};

type McpServer = {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  scope: 'user' | 'project';
  activeForProject: boolean;
};

type HookEntry = {
  event: string;
  matcher?: string;
  command: string;
  type?: string;
  scope: 'user' | 'project';
  activeForProject: boolean;
};

type ExtensionPackage = {
  name: string;
  packageRoot: string;
  hooks: Array<{ event: string; matcher?: string; scope: 'user' | 'project' }>;
  scope: 'user' | 'project' | 'mixed';
  activeForProject: boolean;
};

type PluginsState = {
  plugins: PluginInstall[];
  extensionPackages: ExtensionPackage[];
  marketplaces: Marketplace[];
  mcpServers: McpServer[];
  hooks: HookEntry[];
  skills: SkillEntry[];
  paths: Record<string, string>;
};

type Tab = 'plugins' | 'extensions' | 'skills' | 'mcp' | 'hooks' | 'marketplaces';

export function Extensions({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<PluginsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('plugins');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/plugins/list');
      if (!r.ok) throw new Error(await r.text());
      const j = (await r.json()) as PluginsState;
      setData(j);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, []);

  const toggleExpanded = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  // Filtro full-text: applicato a tutte le liste insieme. I count nei tab
  // riflettono i match (così l'utente vede subito in quale tab c'è qualcosa).
  // Quando la query è vuota, `filtered === data` per reference → niente
  // re-render inutili a valle.
  const filtered = useMemo(() => applySearch(data, query), [data, query]);

  const counts = filtered
    ? {
        plugins: filtered.plugins.length,
        extensions: filtered.extensionPackages.length,
        skills: filtered.skills.length,
        mcp: filtered.mcpServers.length,
        hooks: filtered.hooks.length,
        marketplaces: filtered.marketplaces.length,
      }
    : { plugins: 0, extensions: 0, skills: 0, mcp: 0, hooks: 0, marketplaces: 0 };

  const enabledCount = data?.plugins.filter((p) => p.enabled).length ?? 0;
  const totalMatches = filtered
    ? counts.plugins + counts.extensions + counts.skills + counts.mcp + counts.hooks + counts.marketplaces
    : 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--extensions" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">Extensions</h2>
          <span className="ext__sub">
            {enabledCount}/{counts.plugins} plugins enabled · {counts.skills} skills · {counts.mcp} MCP · {counts.hooks} hooks
          </span>
        </div>

        <div className="ext__split">
          <nav className="ext__tabs ext__tabs--vertical">
            {([
              ['plugins', 'Plugins', counts.plugins],
              ['extensions', 'Extensions', counts.extensions],
              ['skills', 'Skills', counts.skills],
              ['mcp', 'MCP servers', counts.mcp],
              ['hooks', 'Hooks', counts.hooks],
              ['marketplaces', 'Marketplaces', counts.marketplaces],
            ] as const).map(([id, label, n]) => (
              <button
                key={id}
                className={`ext__tab ${tab === id ? 'ext__tab--active' : ''}`}
                onClick={() => setTab(id)}
              >
                <span className="ext__tab-label">{label}</span>
                <span className="ext__tab-count">{n}</span>
              </button>
            ))}
            <button
              className="ext__tab ext__tab--action"
              onClick={refresh}
              title="Refresh"
              disabled={loading}
            >
              <span className="ext__tab-label">{loading ? 'Refreshing…' : 'Refresh'}</span>
              <span className="ext__tab-count">⟳</span>
            </button>
          </nav>

          <div className="ext__body">
          {!loading && !error && data && (
            <div className="ext__search">
              <span className="ext__search-icon" aria-hidden="true">⌕</span>
              <input
                className="ext__search-input"
                type="text"
                placeholder="Search across all extensions, skills, hooks, MCP…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
              />
              {query && (
                <button
                  className="ext__search-clear"
                  onClick={() => setQuery('')}
                  title="Clear search"
                  type="button"
                >
                  ✕
                </button>
              )}
            </div>
          )}
          {loading && <div className="ext__loading">Loading…</div>}
          {error && <div className="ext__error">{error}</div>}

          {!loading && !error && filtered && query.trim() && totalMatches === 0 && (
            <div className="ext__empty">
              <div className="ext__empty-title">No matches for "{query}"</div>
              <div className="ext__empty-hint">
                Try a different keyword, or clear the search to see all extensions.
              </div>
            </div>
          )}

          {!loading && !error && filtered && tab === 'plugins' && (
            <PluginsList data={filtered} expanded={expanded} onToggle={toggleExpanded} />
          )}
          {!loading && !error && filtered && tab === 'extensions' && (
            <ExtensionPackagesList data={filtered} expanded={expanded} onToggle={toggleExpanded} />
          )}
          {!loading && !error && filtered && tab === 'skills' && (
            <SkillsList data={filtered} expanded={expanded} onToggle={toggleExpanded} />
          )}
          {!loading && !error && filtered && tab === 'mcp' && (
            <McpList data={filtered} />
          )}
          {!loading && !error && filtered && tab === 'hooks' && (
            <HooksList data={filtered} />
          )}
          {!loading && !error && filtered && tab === 'marketplaces' && (
            <MarketplacesList data={filtered} />
          )}
          </div>
        </div>

        <div className="modal__foot">
          <span className="modal__hint">
            Read-only — install / enable via <code>claude plugin</code> CLI
          </span>
          <span className="modal__spacer" />
          <button className="header__btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- plugins tab ---------- */

function PluginsList({ data, expanded, onToggle }: {
  data: PluginsState;
  expanded: Set<string>;
  onToggle: (id: string) => void;
}) {
  if (data.plugins.length === 0) {
    return (
      <div className="ext__empty">
        <div className="ext__empty-title">No plugins installed</div>
        <div className="ext__empty-hint">
          Install one with <code>claude plugin install &lt;name&gt;</code>
        </div>
      </div>
    );
  }
  return (
    <div className="ext__grid">
      {data.plugins.map((p) => (
        <PluginCard
          key={`${p.id}::${p.scope}`}
          plugin={p}
          expanded={expanded.has(p.id + '::' + p.scope)}
          onToggle={() => onToggle(p.id + '::' + p.scope)}
        />
      ))}
    </div>
  );
}

function PluginCard({ plugin, expanded, onToggle }: {
  plugin: PluginInstall;
  expanded: boolean;
  onToggle: () => void;
}) {
  const exposes = plugin.exposes;
  const totalExposes =
    exposes.commands + exposes.agents + exposes.skills +
    exposes.hooks + exposes.mcpServers + exposes.lspServers;
  return (
    <div className={`ext-card ${plugin.enabled ? 'ext-card--enabled' : 'ext-card--disabled'}${plugin.activeForProject ? ' ext-card--project-active' : ''}`}>
      <button className="ext-card__head" onClick={onToggle}>
        <span className="ext-card__icon">{plugin.enabled ? '●' : '○'}</span>
        <div className="ext-card__title">
          <span className="ext-card__name">{plugin.name}</span>
          <span className="ext-card__market">@{plugin.marketplace}</span>
        </div>
        <span className={`ext-chip ext-chip--${plugin.scope}`}>{plugin.scope}</span>
        {plugin.version && (
          <span className="ext-chip ext-chip--version">v{plugin.version}</span>
        )}
        <span className="ext-card__chev">{expanded ? '▴' : '▾'}</span>
      </button>

      {plugin.description && (
        <div className="ext-card__desc">{plugin.description}</div>
      )}

      <div className="ext-card__exposes">
        {exposes.commands > 0 && <Capability icon="⌘" label="Commands" n={exposes.commands} />}
        {exposes.agents > 0 && <Capability icon="◉" label="Agents" n={exposes.agents} />}
        {exposes.skills > 0 && <Capability icon="✦" label="Skills" n={exposes.skills} />}
        {exposes.hooks > 0 && <Capability icon="⚡" label="Hooks" n={exposes.hooks} />}
        {exposes.mcpServers > 0 && <Capability icon="◆" label="MCP" n={exposes.mcpServers} />}
        {exposes.lspServers > 0 && <Capability icon="⚙" label="LSP" n={exposes.lspServers} />}
        {totalExposes === 0 && <span className="ext-card__nothing">No manifest data</span>}
      </div>

      {expanded && (
        <div className="ext-card__details">
          <DetailRow label="Path" value={plugin.installPath} mono />
          {plugin.installedAt && (
            <DetailRow label="Installed" value={fmtDate(plugin.installedAt)} />
          )}
          {plugin.lastUpdated && plugin.lastUpdated !== plugin.installedAt && (
            <DetailRow label="Updated" value={fmtDate(plugin.lastUpdated)} />
          )}
          {plugin.gitCommitSha && (
            <DetailRow label="Commit" value={plugin.gitCommitSha.slice(0, 12)} mono />
          )}
          {plugin.manifest?.author && (
            <DetailRow
              label="Author"
              value={typeof plugin.manifest.author === 'string'
                ? plugin.manifest.author
                : plugin.manifest.author.name ?? '?'}
            />
          )}
          {plugin.manifest?.repository && (
            <DetailRow
              label="Repository"
              value={typeof plugin.manifest.repository === 'string'
                ? plugin.manifest.repository
                : plugin.manifest.repository.url ?? '?'}
              mono
            />
          )}
          {plugin.manifest?.license && (
            <DetailRow label="License" value={plugin.manifest.license} />
          )}
        </div>
      )}
    </div>
  );
}

function Capability({ icon, label, n }: { icon: string; label: string; n: number }) {
  return (
    <span className="ext-cap" title={`${n} ${label}`}>
      <span className="ext-cap__icon">{icon}</span>
      <span className="ext-cap__n">{n}</span>
      <span className="ext-cap__label">{label}</span>
    </span>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="ext-detail">
      <span className="ext-detail__label">{label}</span>
      <span className={`ext-detail__value ${mono ? 'ext-detail__value--mono' : ''}`}>
        {value}
      </span>
    </div>
  );
}

/* ---------- skills tab ---------- */

function SkillsList({ data, expanded, onToggle }: {
  data: PluginsState;
  expanded: Set<string>;
  onToggle: (id: string) => void;
}) {
  if (data.skills.length === 0) {
    return (
      <div className="ext__empty">
        <div className="ext__empty-title">No skills available</div>
        <div className="ext__empty-hint">
          Skills come from installed plugins (e.g. <code>mempalace</code>,
          <code>{' '}anthropic-skills</code>) or from <code>~/.claude/skills/</code> /
          <code>{' '}.claude/skills/</code>
        </div>
      </div>
    );
  }

  // Raggruppiamo per "origine": pluginId per skill di plugin, altrimenti
  // lo scope ('user' | 'project'). Una skill appare una sola volta, sotto
  // l'unica intestazione del suo provider — niente più ripetizione del
  // pill `@pluginId` su ogni card.
  const groups = new Map<string, SkillEntry[]>();
  for (const s of data.skills) {
    const key = s.scope === 'plugin' ? s.pluginId : s.scope;
    const arr = groups.get(key) ?? [];
    arr.push(s);
    groups.set(key, arr);
  }
  // Ordine: user-level prima, poi project-level, poi plugins in ordine alfabetico.
  // Coerente col senso "scope crescente di specificità → granularità di terze parti".
  const ordered = [...groups.entries()].sort(([a], [b]) => {
    const rank = (k: string) => k === 'user' ? 0 : k === 'project' ? 1 : 2;
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });

  const groupLabel = (key: string): string => {
    if (key === 'user') return 'User-level skills';
    if (key === 'project') return 'Project-level skills';
    return key;
  };

  return (
    <div className="ext__list">
      {ordered.map(([key, skills]) => (
        <div className="ext-hook-group" key={key}>
          <div className="ext-hook-group__head">
            <span className="ext-hook-group__event">{groupLabel(key)}</span>
            <span className="ext-hook-group__count">{skills.length}</span>
          </div>
          {skills.map((s) => (
            <SkillRow
              key={s.id}
              skill={s}
              expanded={expanded.has(`skill::${s.id}`)}
              onToggle={() => onToggle(`skill::${s.id}`)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Riga compatta per skill: nome + descrizione inline, click → expand
 *  per id/path. Niente bordo/card: il raggruppamento per origine fornisce
 *  già il contenitore visivo. */
function SkillRow({ skill, expanded, onToggle }: {
  skill: SkillEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`ext-skill-row ${skill.activeForProject ? 'ext-skill-row--active' : ''}`}>
      <button className="ext-skill-row__head" onClick={onToggle}>
        <span className="ext-skill-row__icon">✦</span>
        <span className="ext-skill-row__name">{skill.name}</span>
        {skill.description && (
          <span className="ext-skill-row__desc">{skill.description}</span>
        )}
        <span className="ext-skill-row__chev">{expanded ? '▴' : '▾'}</span>
      </button>
      {expanded && (
        <div className="ext-skill-row__details">
          <DetailRow label="Id" value={skill.id} mono />
          <DetailRow label="Path" value={skill.skillPath} mono />
        </div>
      )}
    </div>
  );
}

/* ---------- extension packages tab (npm hook-based extensions) ---------- */

function ExtensionPackagesList({ data, expanded, onToggle }: {
  data: PluginsState;
  expanded: Set<string>;
  onToggle: (id: string) => void;
}) {
  const pkgs = data.extensionPackages;
  if (pkgs.length === 0) {
    return (
      <div className="ext__empty">
        <div className="ext__empty-title">No extension packages detected</div>
        <div className="ext__empty-hint">
          Npm packages installed globally that hook into Claude Code (like
          <code>{' '}@ccplug/claude-reforge</code>) appear here automatically.
        </div>
      </div>
    );
  }
  return (
    <div className="ext__grid">
      {pkgs.map((p) => (
        <ExtensionPackageCard
          key={p.name}
          pkg={p}
          expanded={expanded.has(`pkg::${p.name}`)}
          onToggle={() => onToggle(`pkg::${p.name}`)}
        />
      ))}
    </div>
  );
}

function ExtensionPackageCard({ pkg, expanded, onToggle }: {
  pkg: ExtensionPackage;
  expanded: boolean;
  onToggle: () => void;
}) {
  const events = new Set(pkg.hooks.map((h) => h.event));
  return (
    <div className={`ext-card ext-card--enabled${pkg.activeForProject ? ' ext-card--project-active' : ''}`}>
      <button className="ext-card__head" onClick={onToggle}>
        <span className="ext-card__icon">⚡</span>
        <div className="ext-card__title">
          <span className="ext-card__name">{pkg.name}</span>
          <span className="ext-card__market">Npm hook extension</span>
        </div>
        <span className={`ext-chip ext-chip--${pkg.scope}`}>{pkg.scope}</span>
        <span className="ext-card__chev">{expanded ? '▴' : '▾'}</span>
      </button>

      <div className="ext-card__exposes">
        <Capability icon="⚡" label="Hooks" n={pkg.hooks.length} />
        <Capability icon="◐" label="Events" n={events.size} />
      </div>

      {expanded && (
        <div className="ext-card__details">
          {pkg.packageRoot && (
            <DetailRow label="Path" value={pkg.packageRoot} mono />
          )}
          <div className="ext-detail">
            <span className="ext-detail__label">Events</span>
            <div className="ext-detail__value">
              <div className="ext-pkg__events">
                {[...events].map((e) => (
                  <span key={e} className="ext-pkg__event">{e}</span>
                ))}
              </div>
            </div>
          </div>
          <div className="ext-detail">
            <span className="ext-detail__label">Hooks</span>
            <div className="ext-detail__value">
              <div className="ext-pkg__hooks">
                {pkg.hooks.map((h, i) => (
                  <div className="ext-pkg__hook" key={i}>
                    <span className="ext-pkg__hook-event">{h.event}</span>
                    {h.matcher && <span className="ext-pkg__hook-matcher">{h.matcher}</span>}
                    <span className={`ext-chip ext-chip--${h.scope}`}>{h.scope}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- mcp tab ---------- */

function McpList({ data }: { data: PluginsState }) {
  if (data.mcpServers.length === 0) {
    return (
      <div className="ext__empty">
        <div className="ext__empty-title">No MCP servers configured</div>
        <div className="ext__empty-hint">
          Add servers in <code>~/.claude/settings.json</code> (user) or
          <code>{' '}.mcp.json</code> (project root)
        </div>
      </div>
    );
  }
  return (
    <div className="ext__list">
      {data.mcpServers.map((s, i) => (
        <div className={`ext-mcp${s.activeForProject ? ' ext-mcp--project-active' : ''}`} key={`${s.scope}-${s.name}-${i}`}>
          <div className="ext-mcp__head">
            <span className="ext-mcp__icon">◆</span>
            <span className="ext-mcp__name">{s.name}</span>
            <span className={`ext-chip ext-chip--${s.scope}`}>{s.scope}</span>
          </div>
          {s.url && <DetailRow label="Url" value={s.url} mono />}
          {s.command && (
            <DetailRow
              label="Command"
              value={`${s.command}${s.args?.length ? ' ' + s.args.join(' ') : ''}`}
              mono
            />
          )}
          {s.env && Object.keys(s.env).length > 0 && (
            <DetailRow label="Env" value={Object.keys(s.env).join(', ')} mono />
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------- hooks tab ---------- */

function HooksList({ data }: { data: PluginsState }) {
  if (data.hooks.length === 0) {
    return (
      <div className="ext__empty">
        <div className="ext__empty-title">No hooks configured</div>
        <div className="ext__empty-hint">
          Add them under <code>hooks</code> in <code>~/.claude/settings.json</code> or
          <code>{' '}.claude/settings.json</code>
        </div>
      </div>
    );
  }
  // Group by event for readability
  const byEvent = new Map<string, HookEntry[]>();
  for (const h of data.hooks) {
    const arr = byEvent.get(h.event) ?? [];
    arr.push(h);
    byEvent.set(h.event, arr);
  }
  return (
    <div className="ext__list">
      {[...byEvent.entries()].map(([event, hooks]) => (
        <div className="ext-hook-group" key={event}>
          <div className="ext-hook-group__head">
            <span className="ext-hook-group__event">{event}</span>
            <span className="ext-hook-group__count">{hooks.length}</span>
          </div>
          {hooks.map((h, i) => (
            <div className={`ext-hook${h.activeForProject ? ' ext-hook--project-active' : ''}`} key={i}>
              <div className="ext-hook__line">
                {h.matcher && <span className="ext-hook__matcher">{h.matcher}</span>}
                <span className={`ext-chip ext-chip--${h.scope}`}>{h.scope}</span>
                {h.type && <span className="ext-chip ext-chip--version">{h.type}</span>}
              </div>
              <div className="ext-hook__cmd">{h.command}</div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* ---------- marketplaces tab ---------- */

function MarketplacesList({ data }: { data: PluginsState }) {
  if (data.marketplaces.length === 0) {
    return (
      <div className="ext__empty">
        <div className="ext__empty-title">No marketplaces registered</div>
      </div>
    );
  }
  return (
    <div className="ext__list">
      {data.marketplaces.map((m) => {
        const src: MarketplaceSource = m.source ?? {};
        const sourceLabel =
          src.source === 'github' && src.repo
            ? `github:${src.repo}`
            : src.url ?? JSON.stringify(src);
        return (
          <div className="ext-market" key={m.name}>
            <div className="ext-market__head">
              <span className="ext-market__icon">◇</span>
              <span className="ext-market__name">{m.name}</span>
            </div>
            <DetailRow label="Source" value={sourceLabel} mono />
            {m.installLocation && (
              <DetailRow label="Path" value={m.installLocation} mono />
            )}
            {m.lastUpdated && (
              <DetailRow label="Updated" value={fmtDate(m.lastUpdated)} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Filtro full-text case-insensitive su tutte le entità. Restituisce
 *  l'oggetto originale (per reference) se la query è vuota — così i consumer
 *  con `useMemo` non re-renderizzano. Per ogni tipo flatto i campi rilevanti
 *  in un array di stringhe e cerco la sottostringa. */
function applySearch(data: PluginsState | null, q: string): PluginsState | null {
  if (!data) return null;
  const needle = q.trim().toLowerCase();
  if (!needle) return data;

  const has = (...fields: Array<string | undefined | null>): boolean =>
    fields.some((f) => typeof f === 'string' && f.toLowerCase().includes(needle));

  return {
    ...data,
    plugins: data.plugins.filter((p) =>
      has(
        p.id, p.name, p.description, p.marketplace, p.scope, p.version,
        typeof p.manifest?.author === 'string' ? p.manifest.author : p.manifest?.author?.name,
        typeof p.manifest?.repository === 'string' ? p.manifest.repository : p.manifest?.repository?.url,
        p.manifest?.license,
      ),
    ),
    extensionPackages: data.extensionPackages.filter((p) =>
      has(p.name, p.scope, p.packageRoot, ...p.hooks.map((h) => h.event), ...p.hooks.map((h) => h.matcher)),
    ),
    skills: data.skills.filter((s) =>
      has(s.id, s.name, s.description, s.pluginId, s.scope, s.skillPath),
    ),
    mcpServers: data.mcpServers.filter((s) =>
      has(
        s.name, s.scope, s.command, s.url,
        ...(s.args ?? []),
        ...Object.keys(s.env ?? {}),
        ...Object.values(s.env ?? {}),
      ),
    ),
    hooks: data.hooks.filter((h) => has(h.event, h.matcher, h.command, h.scope, h.type)),
    marketplaces: data.marketplaces.filter((m) =>
      has(
        m.name, m.installLocation,
        typeof m.source.source === 'string' ? m.source.source : undefined,
        m.source.repo, m.source.url,
      ),
    ),
  };
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return iso; }
}
