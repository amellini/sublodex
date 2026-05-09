import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { useStore } from '../lib/store';
import { useUI } from '../lib/ui';
import { useSettings, activeProject } from '../lib/settings';
import { ChevronRight, FolderIcon } from './icons';

async function deleteFsEntry(relPath: string): Promise<boolean> {
  const r = await fetch(`/api/file?path=${encodeURIComponent(relPath)}`, { method: 'DELETE' });
  return r.ok;
}

type FileNode = {
  name: string;
  path: string;       // relative to project root
  isDir: boolean;
  children?: FileNode[];
};

type TreeResponse = { root: string; tree: FileNode[] };

/* ---------- UI state separato dal data store ----------
 *
 * Pre-refactor: `expanded: Set<string>` + `pendingDelete: string|null` erano
 * useState nel componente FileTree, passati come prop a ogni NodeRow.
 * Risultato: ogni toggle creava un nuovo Set → tutti i NodeRow ri-renderizzavano.
 *
 * Post-refactor: store Zustand dedicato. Ogni NodeRow seleziona un boolean
 * (`isExpanded(path)`, `isPendingDelete(path)`) → re-render solo del nodo
 * effettivamente cambiato. Combina con React.memo + selettori granulari su
 * activeFile/openFiles/streamingFiles per il vero salto perf.
 */
type FileTreeUI = {
  expanded: ReadonlySet<string>;
  pendingDelete: string | null;
  toggle: (path: string) => void;
  setExpanded: (paths: Iterable<string>) => void;
  setPendingDelete: (path: string | null) => void;
};
const useFileTreeUI = create<FileTreeUI>((set) => ({
  expanded: new Set(),
  pendingDelete: null,
  toggle: (path) =>
    set((s) => {
      const next = new Set(s.expanded);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { expanded: next };
    }),
  setExpanded: (paths) => set({ expanded: new Set(paths) }),
  setPendingDelete: (path) => set({ pendingDelete: path }),
}));

export function FileTree() {
  const settings = useSettings((s) => s.settings);
  const active = activeProject(settings);
  const [data, setData] = useState<TreeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const setExpanded = useFileTreeUI((s) => s.setExpanded);
  const setPendingDelete = useFileTreeUI((s) => s.setPendingDelete);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/tree');
      if (!r.ok) throw new Error(await r.text());
      const j = (await r.json()) as TreeResponse;
      setData(j);
      setExpanded(j.tree.filter((n) => n.isDir).map((n) => n.path));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [setExpanded]);

  // Ricarica il tree quando il progetto attivo cambia (incluso il primo mount).
  useEffect(() => { void load(); }, [load, active?.id]);

  // Stabile: confirmDelete viene memoizzata così NodeRow + React.memo non
  // invalida ad ogni render del padre. La closure cattura `load` (stabile
  // via useCallback) → safe.
  const confirmDelete = useCallback(async (p: string) => {
    const ok = await deleteFsEntry(p);
    setPendingDelete(null);
    if (ok) {
      // se il file era aperto in editor, chiudi il tab
      useStore.getState().closeFile(p);
      await load();
    }
  }, [load, setPendingDelete]);

  const filteredTree = useMemo(() => {
    if (!data || !filter.trim()) return data?.tree ?? [];
    const q = filter.toLowerCase();
    const matches = (node: FileNode): FileNode | null => {
      if (!node.isDir) {
        return node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q)
          ? node
          : null;
      }
      const kids = (node.children ?? []).map(matches).filter((n): n is FileNode => n !== null);
      if (kids.length === 0 && !node.name.toLowerCase().includes(q)) return null;
      return { ...node, children: kids };
    };
    return data.tree.map(matches).filter((n): n is FileNode => n !== null);
  }, [data, filter]);

  // Quando c'è un filtro, forziamo expand di tutte le dir mostrate. Lo
  // applichiamo all'UI store così i NodeRow figli leggono il bool dal selettore.
  useEffect(() => {
    if (!filter.trim() || !data) return;
    const all: string[] = [];
    const walk = (nodes: FileNode[]) => {
      for (const n of nodes) {
        if (n.isDir) {
          all.push(n.path);
          if (n.children) walk(n.children);
        }
      }
    };
    walk(filteredTree);
    setExpanded(all);
  }, [filter, filteredTree, data, setExpanded]);

  return (
    <div className="ftree">
      <div className="ftree__head">
        <input
          className="ftree__filter"
          placeholder="Filter… (e.g. .py)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="ftree__refresh" onClick={load} title="Refresh">⟳</button>
      </div>

      {data?.root && (
        <div className="ftree__root" title={data.root}>
          {shortRoot(data.root)}
        </div>
      )}

      <div className="ftree__list">
        {loading && <div className="ftree__msg">Loading…</div>}
        {error && <div className="ftree__error">{error}</div>}
        {!loading && !error && data && filteredTree.length === 0 && (
          <div className="ftree__msg">{filter ? 'No matches' : 'Empty project'}</div>
        )}
        {filteredTree.map((node) => (
          <NodeRow
            key={node.path}
            node={node}
            depth={0}
            confirmDelete={confirmDelete}
          />
        ))}
      </div>
    </div>
  );
}

type NodeRowProps = {
  node: FileNode;
  depth: number;
  confirmDelete: (path: string) => Promise<void> | void;
};

/** NodeRow memoizzato. Re-renderizza solo se:
 *  - cambia il `node` (riferimento) o `depth` (parent passa fresh)
 *  - cambia uno dei boolean per-path che leggiamo via selettore granulare
 *  Il `confirmDelete` è memoizzato dal padre via useCallback → stabile.
 *
 *  Selettori dello store globale: ognuno torna un boolean → con il default
 *  shallow-eq di Zustand (Object.is su primitive) il componente si rende
 *  solo quando QUEL boolean cambia. Pre-refactor: selettori che ritornavano
 *  Record/Array invalidavano ogni nodo a ogni edit/scroll/streaming.
 */
const NodeRow = memo(function NodeRow({ node, depth, confirmDelete }: NodeRowProps) {
  const isActive = useStore((s) => s.activeFile === node.path);
  const isOpenInTab = useStore((s) => s.openFiles.includes(node.path));
  const isStreaming = useStore((s) => s.streamingFiles[node.path] !== undefined);
  const setActiveFile = useStore((s) => s.setActiveFile);
  const openEditorPanel = useUI((s) => s.openEditorPanel);

  const isExpanded = useFileTreeUI((s) => s.expanded.has(node.path));
  const isPendingDelete = useFileTreeUI((s) => s.pendingDelete === node.path);
  const toggle = useFileTreeUI((s) => s.toggle);
  const setPendingDelete = useFileTreeUI((s) => s.setPendingDelete);

  const onClick = () => {
    if (node.isDir) toggle(node.path);
    else { setActiveFile(node.path); openEditorPanel(); }
  };

  return (
    <>
      <div
        className={`fnode-row ${isActive ? 'fnode-row--active' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 }}
      >
        <button
          className={`fnode ${node.isDir ? 'fnode--dir' : 'fnode--file'} ${isActive ? 'fnode--active' : ''} ${isOpenInTab ? 'fnode--in-tab' : ''}`}
          onClick={onClick}
          title={node.path}
        >
          <span className={`fnode__chev ${node.isDir && isExpanded ? 'fnode__chev--open' : ''}`}>
            {node.isDir && <ChevronRight size={9} />}
          </span>
          <span className="fnode__icon">
            {node.isDir
              ? <FolderIcon size={15} />
              : <span className="fnode__ext">{iconFor(node.name)}</span>}
          </span>
          <span className="fnode__name">{node.name}</span>
          {isStreaming && <span className="fnode__live" />}
          {!isStreaming && isOpenInTab && !node.isDir && <span className="fnode__open-dot" />}
        </button>
        {!isPendingDelete && (
          <button
            className="fnode__trash"
            title={node.isDir ? 'Delete folder (recursive)' : 'Delete file'}
            onClick={(e) => { e.stopPropagation(); setPendingDelete(node.path); }}
          >
            ✕
          </button>
        )}
      </div>
      {isPendingDelete && (
        <div className="fnode-confirm" style={{ paddingLeft: 8 + depth * 12 }}>
          <span>Delete <b>{node.name}</b>{node.isDir ? ' and everything inside' : ''}?</span>
          <div className="fnode-confirm__actions">
            <button className="fnode-confirm__cancel" onClick={() => setPendingDelete(null)}>Cancel</button>
            <button className="fnode-confirm__yes" onClick={() => confirmDelete(node.path)}>Delete</button>
          </div>
        </div>
      )}
      {node.isDir && isExpanded && node.children?.map((child) => (
        <NodeRow
          key={child.path}
          node={child}
          depth={depth + 1}
          confirmDelete={confirmDelete}
        />
      ))}
    </>
  );
});

function iconFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  if (!ext) return '·';
  const map: Record<string, string> = {
    ts: 'T', tsx: 'T', js: 'J', jsx: 'J', mjs: 'J', cjs: 'J',
    py: 'P', rs: 'R', go: 'G', java: 'J', kt: 'K',
    rb: 'R', php: 'P', swift: 'S',
    c: 'C', cpp: 'C', cc: 'C', h: 'H', hpp: 'H', cs: 'C',
    md: 'M', mdx: 'M',
    json: '{}', yaml: 'Y', yml: 'Y', toml: 'T',
    css: '#', scss: '#', html: 'H', xml: 'X',
    sql: 'S', sh: '$', bash: '$', zsh: '$',
  };
  return map[ext] ?? '·';
}

function shortRoot(p: string): string {
  const home = '/Users/';
  if (p.startsWith(home)) {
    const parts = p.slice(home.length).split('/');
    if (parts.length <= 2) return '~/' + parts.slice(1).join('/');
    return '~/…/' + parts.slice(-2).join('/');
  }
  return p;
}
