import { useEffect, useState } from 'react';

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

  const counts = data
    ? {
        plugins: data.plugins.length,
        extensions: data.extensionPackages.length,
        skills: data.skills.length,
        mcp: data.mcpServers.length,
        hooks: data.hooks.length,
        marketplaces: data.marketplaces.length,
      }
    : { plugins: 0, extensions: 0, skills: 0, mcp: 0, hooks: 0, marketplaces: 0 };

  const enabledCount = data?.plugins.filter((p) => p.enabled).length ?? 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--extensions" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">extensions</h2>
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
              title="refresh"
              disabled={loading}
            >
              <span className="ext__tab-label">{loading ? 'refreshing…' : 'refresh'}</span>
              <span className="ext__tab-count">⟳</span>
            </button>
          </nav>

          <div className="ext__body">
          {loading && <div className="ext__loading">loading…</div>}
          {error && <div className="ext__error">{error}</div>}

          {!loading && !error && data && tab === 'plugins' && (
            <PluginsList data={data} expanded={expanded} onToggle={toggleExpanded} />
          )}
          {!loading && !error && data && tab === 'extensions' && (
            <ExtensionPackagesList data={data} expanded={expanded} onToggle={toggleExpanded} />
          )}
          {!loading && !error && data && tab === 'skills' && (
            <SkillsList data={data} expanded={expanded} onToggle={toggleExpanded} />
          )}
          {!loading && !error && data && tab === 'mcp' && (
            <McpList data={data} />
          )}
          {!loading && !error && data && tab === 'hooks' && (
            <HooksList data={data} />
          )}
          {!loading && !error && data && tab === 'marketplaces' && (
            <MarketplacesList data={data} />
          )}
          </div>
        </div>

        <div className="modal__foot">
          <span className="modal__hint">
            read-only — install / enable via <code>claude plugin</code> CLI
          </span>
          <span className="modal__spacer" />
          <button className="header__btn" onClick={onClose}>close</button>
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
        <div className="ext__empty-title">no plugins installed</div>
        <div className="ext__empty-hint">
          install one with <code>claude plugin install &lt;name&gt;</code>
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
        {exposes.commands > 0 && <Capability icon="⌘" label="commands" n={exposes.commands} />}
        {exposes.agents > 0 && <Capability icon="◉" label="agents" n={exposes.agents} />}
        {exposes.skills > 0 && <Capability icon="✦" label="skills" n={exposes.skills} />}
        {exposes.hooks > 0 && <Capability icon="⚡" label="hooks" n={exposes.hooks} />}
        {exposes.mcpServers > 0 && <Capability icon="◆" label="MCP" n={exposes.mcpServers} />}
        {exposes.lspServers > 0 && <Capability icon="⚙" label="LSP" n={exposes.lspServers} />}
        {totalExposes === 0 && <span className="ext-card__nothing">no manifest data</span>}
      </div>

      {expanded && (
        <div className="ext-card__details">
          <DetailRow label="path" value={plugin.installPath} mono />
          {plugin.installedAt && (
            <DetailRow label="installed" value={fmtDate(plugin.installedAt)} />
          )}
          {plugin.lastUpdated && plugin.lastUpdated !== plugin.installedAt && (
            <DetailRow label="updated" value={fmtDate(plugin.lastUpdated)} />
          )}
          {plugin.gitCommitSha && (
            <DetailRow label="commit" value={plugin.gitCommitSha.slice(0, 12)} mono />
          )}
          {plugin.manifest?.author && (
            <DetailRow
              label="author"
              value={typeof plugin.manifest.author === 'string'
                ? plugin.manifest.author
                : plugin.manifest.author.name ?? '?'}
            />
          )}
          {plugin.manifest?.repository && (
            <DetailRow
              label="repository"
              value={typeof plugin.manifest.repository === 'string'
                ? plugin.manifest.repository
                : plugin.manifest.repository.url ?? '?'}
              mono
            />
          )}
          {plugin.manifest?.license && (
            <DetailRow label="license" value={plugin.manifest.license} />
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
        <div className="ext__empty-title">no skills available</div>
        <div className="ext__empty-hint">
          skills come from installed plugins (e.g. <code>mempalace</code>,
          <code>{' '}anthropic-skills</code>) or from <code>~/.claude/skills/</code> /
          <code>{' '}.claude/skills/</code>
        </div>
      </div>
    );
  }
  return (
    <div className="ext__grid">
      {data.skills.map((s) => (
        <SkillCard
          key={s.id}
          skill={s}
          expanded={expanded.has(`skill::${s.id}`)}
          onToggle={() => onToggle(`skill::${s.id}`)}
        />
      ))}
    </div>
  );
}

function SkillCard({ skill, expanded, onToggle }: {
  skill: SkillEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const cls = `ext-card ext-card--skill ${skill.activeForProject ? 'ext-card--enabled ext-card--project-active' : 'ext-card--disabled'}`;
  const scopeChip = skill.scope === 'plugin' ? skill.pluginId : skill.scope;
  return (
    <div className={cls}>
      <button className="ext-card__head" onClick={onToggle}>
        <span className="ext-card__icon">✦</span>
        <div className="ext-card__title">
          <span className="ext-card__name">{skill.name}</span>
          <span className="ext-card__market">
            {skill.scope === 'plugin' ? `@${skill.pluginId}` : `${skill.scope}-level`}
          </span>
        </div>
        <span className={`ext-chip ext-chip--${skill.scope === 'project' ? 'project' : 'user'}`}>
          {scopeChip}
        </span>
        <span className="ext-card__chev">{expanded ? '▴' : '▾'}</span>
      </button>

      {skill.description && (
        <div className="ext-card__desc">{skill.description}</div>
      )}

      {expanded && (
        <div className="ext-card__details">
          <DetailRow label="id" value={skill.id} mono />
          <DetailRow label="path" value={skill.skillPath} mono />
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
        <div className="ext__empty-title">no extension packages detected</div>
        <div className="ext__empty-hint">
          npm packages installed globally that hook into Claude Code (like
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
          <span className="ext-card__market">npm hook extension</span>
        </div>
        <span className={`ext-chip ext-chip--${pkg.scope}`}>{pkg.scope}</span>
        <span className="ext-card__chev">{expanded ? '▴' : '▾'}</span>
      </button>

      <div className="ext-card__exposes">
        <Capability icon="⚡" label="hooks" n={pkg.hooks.length} />
        <Capability icon="◐" label="events" n={events.size} />
      </div>

      {expanded && (
        <div className="ext-card__details">
          {pkg.packageRoot && (
            <DetailRow label="path" value={pkg.packageRoot} mono />
          )}
          <div className="ext-detail">
            <span className="ext-detail__label">events</span>
            <div className="ext-detail__value">
              <div className="ext-pkg__events">
                {[...events].map((e) => (
                  <span key={e} className="ext-pkg__event">{e}</span>
                ))}
              </div>
            </div>
          </div>
          <div className="ext-detail">
            <span className="ext-detail__label">hooks</span>
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
        <div className="ext__empty-title">no MCP servers configured</div>
        <div className="ext__empty-hint">
          add servers in <code>~/.claude/settings.json</code> (user) or
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
          {s.url && <DetailRow label="url" value={s.url} mono />}
          {s.command && (
            <DetailRow
              label="command"
              value={`${s.command}${s.args?.length ? ' ' + s.args.join(' ') : ''}`}
              mono
            />
          )}
          {s.env && Object.keys(s.env).length > 0 && (
            <DetailRow label="env" value={Object.keys(s.env).join(', ')} mono />
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
        <div className="ext__empty-title">no hooks configured</div>
        <div className="ext__empty-hint">
          add them under <code>hooks</code> in <code>~/.claude/settings.json</code> or
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
        <div className="ext__empty-title">no marketplaces registered</div>
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
            <DetailRow label="source" value={sourceLabel} mono />
            {m.installLocation && (
              <DetailRow label="path" value={m.installLocation} mono />
            )}
            {m.lastUpdated && (
              <DetailRow label="updated" value={fmtDate(m.lastUpdated)} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  } catch { return iso; }
}
