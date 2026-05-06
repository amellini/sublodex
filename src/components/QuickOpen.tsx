import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { useUI } from '../lib/ui';
import { useSettings, activeProject } from '../lib/settings';
import { fuzzyScore } from '../lib/fuzzy';

type FileNode = {
  name: string;
  path: string;
  isDir: boolean;
  children?: FileNode[];
};

/** Flatten l'albero a una lista di soli file (no dir). */
function flattenFiles(nodes: FileNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: FileNode[]) => {
    for (const n of ns) {
      if (n.isDir) { if (n.children) walk(n.children); }
      else out.push(n.path);
    }
  };
  walk(nodes);
  return out;
}

export function QuickOpen() {
  const open = useUI((s) => s.quickOpenOpen);
  const close = useUI((s) => s.closeQuickOpen);
  const setActiveFile = useStore((s) => s.setActiveFile);
  const openEditorPanel = useUI((s) => s.openEditorPanel);
  const settings = useSettings((s) => s.settings);
  const activeId = activeProject(settings)?.id;

  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Fetch tree quando il modal si apre. Lo facciamo on-demand così evitiamo
  // di tenere ~1000 entry in memoria di continuo.
  const loadTree = useCallback(async () => {
    try {
      const r = await fetch('/api/tree');
      if (!r.ok) return;
      const j = (await r.json()) as { tree: FileNode[] };
      setAllFiles(flattenFiles(j.tree ?? []));
    } catch { /* */ }
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    void loadTree();
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, activeId, loadTree]);

  // Filtra + ordina i match
  const matches = useMemo(() => {
    if (!query.trim()) return allFiles.slice(0, 80);
    const scored: Array<{ path: string; score: number }> = [];
    for (const f of allFiles) {
      const s = fuzzyScore(query, f);
      if (s !== null) scored.push({ path: f, score: s });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, 80).map((m) => m.path);
  }, [allFiles, query]);

  // Reset selezione se il numero match cambia
  useEffect(() => { setSelected(0); }, [query, allFiles.length]);

  // Scroll alla riga selezionata
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${selected}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!open) return null;

  const choose = (path: string) => {
    setActiveFile(path);
    openEditorPanel();
    close();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((i) => Math.min(matches.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const m = matches[selected];
      if (m) choose(m);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  return (
    <div className="modal-backdrop modal-backdrop--top" onClick={close}>
      <div className="quick-open" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="quick-open__input"
          placeholder="search files…  (esc to close)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="quick-open__list" ref={listRef}>
          {matches.length === 0 && (
            <div className="quick-open__empty">no files match</div>
          )}
          {matches.map((p, i) => (
            <button
              key={p}
              data-idx={i}
              className={`quick-open__item ${i === selected ? 'quick-open__item--selected' : ''}`}
              onClick={() => choose(p)}
              onMouseEnter={() => setSelected(i)}
            >
              <span className="quick-open__name">{basename(p)}</span>
              <span className="quick-open__path">{dirname(p)}</span>
            </button>
          ))}
        </div>
        <div className="quick-open__hint">
          ↑↓ navigate · ↵ open · esc close
        </div>
      </div>
    </div>
  );
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}
function dirname(p: string): string {
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join('/');
}
