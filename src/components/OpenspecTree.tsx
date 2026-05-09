import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { useUI, SESSION_TAB_ID } from '../lib/ui';
import { useStore } from '../lib/store';
import { useSettings, activeProject } from '../lib/settings';
import { sendPrompt, OPENSPEC_TREE_REFRESH_EVENT } from '../lib/ws';
import {
  buildRegenPrompt,
  regenTargetFor,
  isChangeFolder,
  isArchivedChange,
  APPLY_PROMPT,
} from '../lib/openspecPrompts';
import { useOpenspecState } from '../lib/openspecState';
import {
  ChevronRight,
  FolderIcon,
  FileIcon,
  ProposalIcon,
  DesignIcon,
  TasksIcon,
  RegenIcon,
  PlusIcon,
  CheckIcon,
  ArchiveIcon,
} from './icons';
import { ProposeModal } from './ProposeModal';
import { ArchivePickerModal } from './ArchivePickerModal';

/** Icona dedicata per i file canonici di OpenSpec. Il pattern è fisso:
 *  `proposal.md`, `design.md`, `tasks.md` (e i loro YAML equivalenti). Per
 *  qualunque altro file ricadiamo su FileIcon generico. */
function iconForSpec(name: string): React.ReactNode {
  const base = name.toLowerCase().replace(/\.(md|yaml|yml)$/, '');
  if (base === 'proposal') return <ProposalIcon size={14} className="fnode__spec-icon fnode__spec-icon--proposal" />;
  if (base === 'design')   return <DesignIcon   size={14} className="fnode__spec-icon fnode__spec-icon--design" />;
  if (base === 'tasks')    return <TasksIcon    size={14} className="fnode__spec-icon fnode__spec-icon--tasks" />;
  return <FileIcon size={14} />;
}

/** Tree dei file `.md/.yaml/.yml` dentro la cartella `openspec/` del progetto.
 *  Click su file → apre tab nel center pane (vedi useUI.openSpecTab). Niente
 *  delete: le spec si mantengono lifecycle a livello git. */

type FileNode = {
  name: string;
  path: string;       // relativo al project root, es. 'openspec/changes/foo/proposal.md'
  isDir: boolean;
  children?: FileNode[];
};

type TreeResponse = { root: string; tree: FileNode[] };

type OpenspecTreeUI = {
  expanded: ReadonlySet<string>;
  toggle: (path: string) => void;
  setExpanded: (paths: Iterable<string>) => void;
};
const useOpenspecTreeUI = create<OpenspecTreeUI>((set) => ({
  expanded: new Set(),
  toggle: (path) =>
    set((s) => {
      const next = new Set(s.expanded);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { expanded: next };
    }),
  setExpanded: (paths) => set({ expanded: new Set(paths) }),
}));

export function OpenspecTree() {
  const settings = useSettings((s) => s.settings);
  const active = activeProject(settings);
  const [data, setData] = useState<TreeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [proposeOpen, setProposeOpen] = useState(false);
  const [archivePickerOpen, setArchivePickerOpen] = useState(false);
  const setExpanded = useOpenspecTreeUI((s) => s.setExpanded);
  const loadOpenspecState = useOpenspecState((s) => s.loadState);
  const pending = useOpenspecState((s) => s.pending);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/openspec/tree');
      if (!r.ok) throw new Error(await r.text());
      const j = (await r.json()) as TreeResponse;
      setData(j);
      // Espandi i top-level (changes/, specs/, ...) di default così l'utente
      // vede subito qualcosa senza dover cliccare.
      setExpanded(j.tree.filter((n) => n.isDir).map((n) => n.path));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [setExpanded]);

  useEffect(() => {
    void load();
    void loadOpenspecState();
  }, [load, loadOpenspecState, active?.id]);

  // Refresh tree quando il done hook segnala completamento di archive/propose.
  useEffect(() => {
    const onRefresh = () => { void load(); void loadOpenspecState(); };
    window.addEventListener(OPENSPEC_TREE_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(OPENSPEC_TREE_REFRESH_EVENT, onRefresh);
  }, [load, loadOpenspecState]);

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
          placeholder="Filter… (e.g. proposal)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          className="ftree__refresh"
          onClick={() => setProposeOpen(true)}
          title="New openspec proposal (/opsx:propose)"
        >
          <PlusIcon size={13} />
        </button>
        <button
          className="ftree__refresh"
          onClick={() => setArchivePickerOpen(true)}
          title="Archive changes (/opsx:archive)"
        >
          <ArchiveIcon size={13} />
        </button>
        <button className="ftree__refresh" onClick={load} title="Refresh">⟳</button>
      </div>

      {pending?.kind === 'archive-batch' && (
        <div className={`archive-picker__banner ${pending.awaitingSync ? 'archive-picker__banner--paused' : ''}`}>
          {pending.awaitingSync
            ? <>Paused on sync prompt for <strong>{pending.current}</strong> · answer the modal to continue</>
            : <>Archiving {pending.done}/{pending.total} · current: <strong>{pending.current}</strong></>
          }
          {!pending.awaitingSync && pending.queue.length > 0 && (
            <span className="archive-picker__queue">
              {' '}· Queue: {pending.queue.join(', ')}
            </span>
          )}
        </div>
      )}

      <div className="ftree__list">
        {loading && <div className="ftree__msg">Loading…</div>}
        {error && <div className="ftree__error">{error}</div>}
        {!loading && !error && data && filteredTree.length === 0 && (
          <div className="ftree__msg">{filter ? 'No matches' : 'Empty openspec/'}</div>
        )}
        {filteredTree.map((node) => (
          <NodeRow key={node.path} node={node} depth={0} />
        ))}
      </div>

      {proposeOpen && <ProposeModal onClose={() => setProposeOpen(false)} />}
      {archivePickerOpen && <ArchivePickerModal onClose={() => setArchivePickerOpen(false)} />}
    </div>
  );
}

const NodeRow = memo(function NodeRow({ node, depth }: { node: FileNode; depth: number }) {
  const openSpecTab = useUI((s) => s.openSpecTab);
  const setActiveCenterTab = useUI((s) => s.setActiveCenterTab);
  const activeCenterTab = useUI((s) => s.activeCenterTab);
  const isStreaming = useStore((s) => s.streamingFiles[node.path] !== undefined);
  const claudeBusy = useStore((s) => s.isStreaming);
  const isExpanded = useOpenspecTreeUI((s) => s.expanded.has(node.path));
  const toggle = useOpenspecTreeUI((s) => s.toggle);
  const isApplied = useOpenspecState((s) => Boolean(s.applied[node.path]));
  const setPending = useOpenspecState((s) => s.setPending);

  const tabId = node.isDir ? null : `spec:${node.path}`;
  const isActive = !node.isDir && activeCenterTab === tabId;

  // Solo i file design.md / tasks.md di OpenSpec hanno il bottone regen.
  // Per qualunque altro file (incl. proposal.md che è la sorgente) ritorna null.
  const regen = node.isDir ? null : regenTargetFor(node.path);

  // Bottoni Apply/Archive/badge solo per cartelle change dirette sotto
  // openspec/changes/. Esclude la cartella `archive` stessa e tutti i suoi
  // sotto-elementi (che vanno marcati come archiviati a parte).
  const isChange = node.isDir && isChangeFolder(node.path);
  const isArchived = node.isDir && isArchivedChange(node.path);

  const onClick = () => {
    if (node.isDir) toggle(node.path);
    else openSpecTab(node.path);
  };

  const onRegen = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!regen || claudeBusy) return;
    sendPrompt(buildRegenPrompt(regen.target, regen.changeDir));
    // Switch alla tab session per dare visibilità allo streaming Claude.
    setActiveCenterTab(SESSION_TAB_ID);
  };

  const onApply = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (claudeBusy) return;
    sendPrompt(APPLY_PROMPT);
    setPending({ kind: 'apply', changeDir: node.path });
    setActiveCenterTab(SESSION_TAB_ID);
  };

  return (
    <>
      <div className={`fnode-row ${isActive ? 'fnode-row--active' : ''}`} style={{ paddingLeft: 8 + depth * 12 }}>
        <button
          className={`fnode ${node.isDir ? 'fnode--dir' : 'fnode--file'} ${isActive ? 'fnode--active' : ''}`}
          onClick={onClick}
          title={node.path}
        >
          <span className={`fnode__chev ${node.isDir && isExpanded ? 'fnode__chev--open' : ''}`}>
            {node.isDir && <ChevronRight size={9} />}
          </span>
          <span className="fnode__icon">
            {node.isDir ? <FolderIcon size={15} /> : iconForSpec(node.name)}
          </span>
          <span className="fnode__name">{node.name}</span>
          {isStreaming && <span className="fnode__live" />}
          {isArchived && <span className="fnode__badge fnode__badge--archived">Archived</span>}
          {isChange && isApplied && (
            <span className="fnode__badge fnode__badge--applied" title="Applied — use the archive picker (top of tree) to archive">Applied</span>
          )}
        </button>
        {regen && (
          <button
            className="fnode__regen"
            onClick={onRegen}
            disabled={claudeBusy}
            title={
              claudeBusy
                ? 'Claude is busy — wait for the current response'
                : `Regenerate ${regen.target}.md from ${regen.target === 'design' ? 'proposal' : 'proposal + design'}`
            }
          >
            <RegenIcon size={13} />
          </button>
        )}
        {isChange && !isApplied && (
          <button
            className="fnode__opsx fnode__opsx--apply"
            onClick={onApply}
            disabled={claudeBusy}
            title={claudeBusy ? 'Claude is busy' : 'Apply this change (/opsx:apply)'}
          >
            <CheckIcon size={13} />
          </button>
        )}
      </div>
      {node.isDir && isExpanded && node.children?.map((child) => (
        <NodeRow key={child.path} node={child} depth={depth + 1} />
      ))}
    </>
  );
});
