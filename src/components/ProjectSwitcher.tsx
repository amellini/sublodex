import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { useUI } from '../lib/ui';
import { useSettings, setActiveProject } from '../lib/settings';
import { cancel } from '../lib/ws';
import { fuzzyScore } from '../lib/fuzzy';
import type { Project } from '../lib/types';

/** Ordina i progetti quando la query è vuota: prima il progetto attivo,
 *  poi quelli usati di recente (lastUsedAt desc), poi gli altri alfabetici. */
function defaultSort(projects: Project[], activeId: string | undefined): Project[] {
  const copy = [...projects];
  copy.sort((a, b) => {
    if (a.id === activeId) return -1;
    if (b.id === activeId) return 1;
    const la = a.lastUsedAt ?? 0;
    const lb = b.lastUsedAt ?? 0;
    if (la !== lb) return lb - la;
    return a.name.localeCompare(b.name);
  });
  return copy;
}

export function ProjectSwitcher() {
  const open = useUI((s) => s.projectSwitcherOpen);
  const close = useUI((s) => s.closeProjectSwitcher);
  const settings = useSettings((s) => s.settings);
  const isStreaming = useStore((s) => s.isStreaming);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  // id del progetto in attesa di conferma per "switch anyway" durante streaming.
  // null = nessuna conferma pendente.
  const [confirmSwitchId, setConfirmSwitchId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const projects = settings?.projects ?? [];
  const activeId = settings?.activeId;

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(0);
    setConfirmSwitchId(null);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const matches = useMemo(() => {
    if (!query.trim()) return defaultSort(projects, activeId);
    const scored: Array<{ p: Project; score: number }> = [];
    for (const p of projects) {
      const s = fuzzyScore(query, `${p.name} ${p.path}`);
      if (s !== null) scored.push({ p, score: s });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.map((m) => m.p);
  }, [projects, activeId, query]);

  // Reset selezione se cambia il set di match.
  useEffect(() => { setSelected(0); }, [query, matches.length]);

  // Scroll alla riga selezionata.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-idx="${selected}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!open) return null;

  const performSwitch = async (project: Project) => {
    if (isStreaming) cancel();
    await setActiveProject(project.id);
    close();
  };

  const choose = (project: Project) => {
    if (project.id === activeId) {
      close();
      return;
    }
    if (isStreaming && confirmSwitchId !== project.id) {
      // Primo Enter su un progetto durante streaming → mostra conferma,
      // non switcha. Il secondo Enter (con confirmSwitchId allineato)
      // chiama cancel() + setActiveProject.
      setConfirmSwitchId(project.id);
      return;
    }
    void performSwitch(project);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((i) => Math.min(matches.length - 1, i + 1));
      setConfirmSwitchId(null);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
      setConfirmSwitchId(null);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const m = matches[selected];
      if (m) choose(m);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (confirmSwitchId) {
        setConfirmSwitchId(null);
      } else {
        close();
      }
    }
  };

  return (
    <div className="modal-backdrop modal-backdrop--top" onClick={close}>
      <div className="quick-open" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="quick-open__input"
          placeholder="switch project…  (esc to close)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          autoComplete="off"
          spellCheck={false}
        />
        <div className="quick-open__list" ref={listRef}>
          {matches.length === 0 && (
            <div className="quick-open__empty">no projects match</div>
          )}
          {matches.map((p, i) => {
            const isActive = p.id === activeId;
            const isConfirming = confirmSwitchId === p.id;
            return (
              <button
                key={p.id}
                data-idx={i}
                className={`quick-open__item ${i === selected ? 'quick-open__item--selected' : ''}`}
                onClick={() => choose(p)}
                onMouseEnter={() => { setSelected(i); setConfirmSwitchId(null); }}
              >
                <span className="quick-open__name">
                  {p.name}
                  {isActive && <span className="header__project-ssh" style={{ marginLeft: 6 }}>active</span>}
                  {p.remote && <span className="header__project-ssh" style={{ marginLeft: 6 }}>ssh</span>}
                </span>
                <span className="quick-open__path">{p.path}</span>
                {isConfirming && (
                  <span className="quick-open__path" style={{ color: 'var(--color-warning, #c97a00)' }}>
                    ↵ again to interrupt the running stream
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="quick-open__hint">
          {confirmSwitchId
            ? '↵ switch anyway (cancels stream) · esc keep streaming'
            : isStreaming
              ? '↑↓ navigate · ↵ switch (will prompt: stream is active) · esc close'
              : '↑↓ navigate · ↵ switch · esc close'}
        </div>
      </div>
    </div>
  );
}
