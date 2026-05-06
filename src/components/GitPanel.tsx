import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useStore } from '../lib/store';
import { useSettings, activeProject } from '../lib/settings';
import { useUI } from '../lib/ui';
import { ChevronRight, FolderIcon, TrashIcon } from './icons';

type GitFileStatus = {
  path: string;
  staged: 'A' | 'M' | 'D' | 'R' | 'U' | null;
  workdir: 'M' | 'D' | 'U' | '?' | null;
};

/** Nodo per la tree view del git status: leaf = file, branch = directory. */
type GitTreeNode = {
  name: string;          // segmento(i) dal genitore — può contenere "/" se compattato
  path: string;          // path completo relativo alla repo
  isDir: boolean;
  file?: GitFileStatus;  // solo per le foglie
  children: GitTreeNode[];
};

/** Costruisce un albero da una lista flat di file git, e collassa le catene
 *  di directory con un solo figlio (stile VS Code "compact folders"). */
function buildGitTree(files: GitFileStatus[]): GitTreeNode[] {
  const root: GitTreeNode[] = [];
  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean);
    let level = root;
    let cur = '';
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1;
      const name = parts[i];
      cur = cur ? `${cur}/${name}` : name;
      let node = level.find((n) => n.name === name && n.isDir === !isLeaf);
      if (!node) {
        node = {
          name,
          path: cur,
          isDir: !isLeaf,
          file: isLeaf ? f : undefined,
          children: [],
        };
        level.push(node);
      }
      level = node.children;
    }
  }
  const sortRec = (nodes: GitTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) sortRec(n.children);
  };
  const compactRec = (nodes: GitTreeNode[]) => {
    for (const n of nodes) {
      if (!n.isDir) continue;
      compactRec(n.children);
      while (n.children.length === 1 && n.children[0].isDir) {
        const only = n.children[0];
        n.name = `${n.name}/${only.name}`;
        n.path = only.path;
        n.children = only.children;
      }
    }
  };
  sortRec(root);
  compactRec(root);
  return root;
}

/** Conta ricorsivamente le foglie sotto un nodo (utile per il badge sulla dir). */
function countLeaves(node: GitTreeNode): number {
  if (!node.isDir) return 1;
  let c = 0;
  for (const child of node.children) c += countLeaves(child);
  return c;
}

/** Conta i file sotto un nodo classificati per stato (added/modified/deleted).
 *  - added: nuovi file (`?` workdir o `A` staged)
 *  - deleted: `D` (sia staged che workdir)
 *  - modified: tutto il resto (M, R, U merge) — fallback safe. */
type StatusCounts = { added: number; modified: number; deleted: number };
function countByStatus(node: GitTreeNode, staged: boolean): StatusCounts {
  if (!node.isDir && node.file) {
    const code = staged ? node.file.staged : node.file.workdir;
    if (code === 'A' || code === '?') return { added: 1, modified: 0, deleted: 0 };
    if (code === 'D') return { added: 0, modified: 0, deleted: 1 };
    return { added: 0, modified: 1, deleted: 0 };
  }
  const acc: StatusCounts = { added: 0, modified: 0, deleted: 0 };
  for (const c of node.children) {
    const sub = countByStatus(c, staged);
    acc.added += sub.added;
    acc.modified += sub.modified;
    acc.deleted += sub.deleted;
  }
  return acc;
}

type GitStatus =
  | { isGitRepo: false }
  | {
      isGitRepo: true;
      branch: string;
      upstream?: string;
      ahead: number;
      behind: number;
      files: GitFileStatus[];
    };

type RunResult = { ok: boolean; stdout: string; stderr: string; code: number };

type Commit = {
  hash: string;
  abbrev: string;
  author: string;
  date: string;
  subject: string;
};

type Branch = {
  name: string;
  sha: string;
  upstream?: string;
  current: boolean;
};

type Stash = { ref: string; message: string };

export function GitPanel() {
  const settings = useSettings((s) => s.settings);
  const active = activeProject(settings);
  const setActiveFileRaw = useStore((s) => s.setActiveFile);
  const openEditorPanel = useUI((s) => s.openEditorPanel);
  const setActiveFile = (p?: string) => { setActiveFileRaw(p); if (p) openEditorPanel(); };
  const setIsGitRepo = useUI((s) => s.setIsGitRepo);

  const [data, setData] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitMsg, setCommitMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  const [opOutput, setOpOutput] = useState<{ label: string; text: string } | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);
  const [stashes, setStashes] = useState<Stash[]>([]);
  const [stashOpen, setStashOpen] = useState(false);
  const [stashMsg, setStashMsg] = useState('');
  const [prInput, setPrInput] = useState('');
  const [prOpen, setPrOpen] = useState(false);
  /** Apertura del menu dropdown del commit-button (split button stile VS Code). */
  const [commitMenuOpen, setCommitMenuOpen] = useState(false);
  const commitMenuRef = useRef<HTMLDivElement>(null);
  const caretBtnRef = useRef<HTMLButtonElement>(null);
  /** Posizione assoluta in viewport del dropdown, calcolata dal bbox del caret. */
  const [commitMenuPos, setCommitMenuPos] = useState<{ top: number; right: number } | null>(null);
  /** Path delle directory chiuse nella tree view (default: tutte aperte). */
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());
  const toggleDir = useCallback((path: string) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [statusRes, logRes, branchesRes, stashRes] = await Promise.all([
        fetch('/api/git/status'),
        fetch('/api/git/log?limit=30'),
        fetch('/api/git/branches'),
        fetch('/api/git/stash/list'),
      ]);
      if (!statusRes.ok) throw new Error(await statusRes.text());
      const j = (await statusRes.json()) as GitStatus;
      setData(j);
      setIsGitRepo(j.isGitRepo);
      if (logRes.ok) {
        const lj = (await logRes.json()) as { commits: Commit[] };
        setCommits(lj.commits ?? []);
      } else {
        setCommits([]);
      }
      if (branchesRes.ok) {
        const bj = (await branchesRes.json()) as { branches: Branch[] };
        setBranches(bj.branches ?? []);
      } else {
        setBranches([]);
      }
      if (stashRes.ok) {
        const sj = (await stashRes.json()) as { stashes: Stash[] };
        setStashes(sj.stashes ?? []);
      } else {
        setStashes([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh, active?.id]);

  // Chiude il dropdown del commit button su click esterno. Pattern allineato
  // a quello del model-picker nel Composer.
  useEffect(() => {
    if (!commitMenuOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (commitMenuRef.current?.contains(target)) return;
      if (caretBtnRef.current?.contains(target)) return;
      setCommitMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [commitMenuOpen]);

  // Calcola la posizione del dropdown ogni volta che si apre o quando la
  // finestra viene ridimensionata/scrollata. Il dropdown è renderizzato
  // via portal con position:fixed, così non viene tagliato dall'overflow
  // del Panel di react-resizable-panels.
  useEffect(() => {
    if (!commitMenuOpen) {
      setCommitMenuPos(null);
      return;
    }
    const update = () => {
      const r = caretBtnRef.current?.getBoundingClientRect();
      if (!r) return;
      setCommitMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [commitMenuOpen]);

  const runOp = async (label: string, op: () => Promise<Response>) => {
    setBusy(true);
    setOpError(null);
    setOpOutput(null);
    try {
      const r = await op();
      const j = (await r.json()) as RunResult;
      const text = (j.stdout + (j.stderr ? `\n${j.stderr}` : '')).trim();
      if (!j.ok) {
        setOpError(text || `git failed (code ${j.code})`);
      } else if (text) {
        setOpOutput({ label, text });
      }
      await refresh();
    } catch (err) {
      setOpError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const stage = (p: string) =>
    runOp(`stage ${p}`, () =>
      fetch('/api/git/stage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: p }),
      }),
    );
  const unstage = (p: string) =>
    runOp(`unstage ${p}`, () =>
      fetch('/api/git/unstage', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: p }),
      }),
    );
  const stageAll = () =>
    runOp('stage all', () => fetch('/api/git/stage-all', { method: 'POST' }));
  const unstageAll = () =>
    runOp('unstage all', () => fetch('/api/git/unstage-all', { method: 'POST' }));
  const discard = (p: string, untracked: boolean) =>
    runOp(`discard ${p}`, () =>
      fetch('/api/git/discard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: p, untracked }),
      }),
    ).then(() => setConfirmDiscard(null));
  const commit = () =>
    runOp('commit', () =>
      fetch('/api/git/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: commitMsg }),
      }),
    ).then(() => { setCommitMsg(''); setCommitMenuOpen(false); });
  const pull = () => runOp('pull', () => fetch('/api/git/pull', { method: 'POST' }));
  const push = () => runOp('push', () => fetch('/api/git/push', { method: 'POST' }));

  /** Commit + push in sequenza (lato client). Se il commit fallisce, il push
   *  non viene tentato. Il messaggio viene resettato solo se entrambi vanno
   *  a buon fine: in caso di errore l'utente ritrova il msg per ritentare.
   *  L'output combinato di commit + push viene mostrato nel pannello opOutput. */
  const commitAndPush = async () => {
    setBusy(true);
    setOpError(null);
    setOpOutput(null);
    setCommitMenuOpen(false);
    try {
      const rs = await fetch('/api/git/stage-all', { method: 'POST' });
      const js = (await rs.json()) as RunResult;
      if (!js.ok) {
        setOpError(((js.stderr || js.stdout) ?? '').trim() || `stage failed (code ${js.code})`);
        await refresh();
        return;
      }
      const r1 = await fetch('/api/git/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: commitMsg }),
      });
      const j1 = (await r1.json()) as RunResult;
      const t1 = (j1.stdout + (j1.stderr ? `\n${j1.stderr}` : '')).trim();
      if (!j1.ok) {
        setOpError(t1 || `commit failed (code ${j1.code})`);
        await refresh();
        return;
      }
      const r2 = await fetch('/api/git/push', { method: 'POST' });
      const j2 = (await r2.json()) as RunResult;
      const t2 = (j2.stdout + (j2.stderr ? `\n${j2.stderr}` : '')).trim();
      const combined = [t1, t2].filter(Boolean).join('\n---\n');
      if (!j2.ok) {
        // commit ok, push ko: lo segnaliamo come errore ma manteniamo la traccia
        // del commit avvenuto nel testo.
        setOpError(combined || `push failed (code ${j2.code})`);
        // Il commit È andato → resettiamo comunque il msg per evitare doppi
        // commit accidentali al retry; l'utente farà solo il push.
        setCommitMsg('');
      } else {
        setOpOutput({ label: 'commit + push', text: combined });
        setCommitMsg('');
      }
      await refresh();
    } catch (err) {
      setOpError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** Save dello stash usando il messaggio della textarea principale.
   *  Differisce da `stashSave` (sotto, per il pannello stash espandibile)
   *  perché legge `commitMsg` invece di `stashMsg`. */
  const stashFromCommit = () =>
    runOp('stash', () =>
      fetch('/api/git/stash/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: commitMsg }),
      }),
    ).then(() => { setCommitMsg(''); setCommitMenuOpen(false); });

  const [generating, setGenerating] = useState(false);
  const generateCommitMsg = async () => {
    setGenerating(true);
    setOpError(null);
    try {
      const r = await fetch('/api/git/generate-commit-msg', { method: 'POST' });
      const text = await r.text();
      if (!text.trim()) {
        setOpError(`empty response from server (status ${r.status}) — request may have timed out`);
        return;
      }
      let j: { message?: string; error?: string };
      try {
        j = JSON.parse(text) as { message?: string; error?: string };
      } catch {
        setOpError(`invalid JSON response: ${text.slice(0, 200)}`);
        return;
      }
      if (!r.ok || j.error) {
        setOpError(j.error ?? 'failed to generate commit message');
        return;
      }
      if (j.message) setCommitMsg(j.message);
    } catch (err) {
      setOpError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };
  const checkout = (branch: string, create = false) =>
    runOp(create ? `checkout -b ${branch}` : `checkout ${branch}`, () =>
      fetch('/api/git/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ branch, create }),
      }),
    ).then(() => {
      setBranchMenuOpen(false);
      setCreatingBranch(false);
      setNewBranchName('');
    });
  const stashSave = () =>
    runOp('stash save', () =>
      fetch('/api/git/stash/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: stashMsg }),
      }),
    ).then(() => setStashMsg(''));
  const stashPop = (ref: string) =>
    runOp(`stash pop ${ref}`, () =>
      fetch('/api/git/stash/pop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref }),
      }),
    );
  const stashDrop = (ref: string) =>
    runOp(`stash drop ${ref}`, () =>
      fetch('/api/git/stash/drop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref }),
      }),
    );

  /** Estrae il numero PR da varie forme di input:
   *   - "https://github.com/owner/repo/pull/123" → 123
   *   - "#123" → 123
   *   - "123" → 123 */
  const extractPrNumber = (s: string): number | null => {
    const t = s.trim();
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    if (/^#\d+$/.test(t)) return parseInt(t.slice(1), 10);
    const m = t.match(/\/pull\/(\d+)/);
    if (m) return parseInt(m[1], 10);
    return null;
  };

  const reviewPr = async () => {
    const num = extractPrNumber(prInput);
    if (!num) {
      setOpError('paste a PR url or number (e.g. https://github.com/.../pull/123 or 123)');
      return;
    }
    setBusy(true);
    setOpError(null);
    setOpOutput(null);
    try {
      // 1) fetch del branch del PR sotto refs/heads/pr-N
      const fr = await fetch('/api/git/fetch-pr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ number: num }),
      });
      const fj = (await fr.json()) as RunResult & { branch?: string };
      if (!fj.ok || !fj.branch) {
        setOpError(((fj.stderr || fj.stdout) ?? '').trim() || `fetch failed (code ${fj.code})`);
        return;
      }
      // 2) base branch (origin/HEAD → main/master)
      const dbRes = await fetch('/api/git/default-branch');
      const db = (await dbRes.json()) as { branch: string | null };
      const base = db.branch || 'main';
      // 3) apri tab diff range
      setActiveFile(`diff://range:${base}..${fj.branch}`);
      setPrInput('');
      setPrOpen(false);
      setOpOutput({
        label: `PR #${num}`,
        text: `fetched into branch ${fj.branch} → diff vs ${base} opened in editor`,
      });
      await refresh();
    } catch (err) {
      setOpError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const stagedFiles = data?.isGitRepo ? data.files.filter((f) => f.staged !== null) : [];
  const unstagedFiles = data?.isGitRepo ? data.files.filter((f) => f.staged === null) : [];
  const stagedTree = useMemo(() => buildGitTree(stagedFiles), [stagedFiles]);
  const unstagedTree = useMemo(() => buildGitTree(unstagedFiles), [unstagedFiles]);

  if (loading && !data) {
    return <div className="git-panel git-panel--empty">loading…</div>;
  }
  if (error) {
    return <div className="git-panel git-panel--empty">{error}</div>;
  }
  if (!data || !data.isGitRepo) {
    return (
      <div className="git-panel git-panel--empty">
        <div>not a git repository</div>
        <div className="git-panel__hint">
          run <code>git init</code> in the project, then refresh
        </div>
        <button className="header__btn" onClick={refresh}>refresh</button>
      </div>
    );
  }

  /** Renderer ricorsivo della tree. Le foglie usano <FileRow>, le dir un header
   *  collassabile. L'indentazione cresce di 12px per livello, come la FileTree. */
  const renderTree = (nodes: GitTreeNode[], depth: number, staged: boolean): ReactNode =>
    nodes.map((node) => {
      if (!node.isDir && node.file) {
        const f = node.file;
        return (
          <FileRow
            key={`${staged ? 'staged' : 'workdir'}-${f.path}`}
            f={f}
            staged={staged}
            depth={depth}
            onClick={() =>
              staged
                ? setActiveFile(`diff://staged:${f.path}`)
                : f.workdir === '?'
                  ? setActiveFile(f.path)
                  : setActiveFile(`diff://workdir:${f.path}`)
            }
            onAction={() => (staged ? unstage(f.path) : stage(f.path))}
            onDiscard={staged ? null : () => discard(f.path, f.workdir === '?')}
            busy={busy}
            confirming={!staged && confirmDiscard === f.path}
            onRequestDiscard={() => setConfirmDiscard(f.path)}
            onCancelDiscard={() => setConfirmDiscard(null)}
          />
        );
      }
      const isCollapsed = collapsedDirs.has(node.path);
      const counts = countByStatus(node, staged);
      const tooltip = `${node.path}\n${counts.added} added · ${counts.modified} modified · ${counts.deleted} deleted`;
      return (
        <div key={`dir-${staged ? 's' : 'w'}-${node.path}`}>
          <button
            type="button"
            className="git-dir"
            style={{ paddingLeft: 6 + depth * 12 }}
            onClick={() => toggleDir(node.path)}
            title={tooltip}
          >
            <span
              className={`git-dir__chev ${isCollapsed ? '' : 'git-dir__chev--open'}`}
            >
              <ChevronRight size={9} />
            </span>
            <span className="git-dir__icon">
              <FolderIcon size={13} />
            </span>
            <span className="git-dir__name">{node.name}</span>
            <span className="git-dir__counts" aria-label={`added ${counts.added}, modified ${counts.modified}, deleted ${counts.deleted}`}>
              <span className="git-dir__count git-dir__count--added">{counts.added}</span>
              <span className="git-dir__count-sep">/</span>
              <span className="git-dir__count git-dir__count--modified">{counts.modified}</span>
              <span className="git-dir__count-sep">/</span>
              <span className="git-dir__count git-dir__count--deleted">{counts.deleted}</span>
            </span>
          </button>
          {!isCollapsed && renderTree(node.children, depth + 1, staged)}
        </div>
      );
    });

  return (
    <div className="git-panel">
      <div className="git-panel__head">
        <button
          className="git-panel__branch git-panel__branch--clickable"
          onClick={() => setBranchMenuOpen((v) => !v)}
          title={data.upstream ?? '(no upstream)'}
        >
          <span className="git-panel__branch-glyph">⎇</span>
          <span className="git-panel__branch-name">{data.branch}</span>
          {(data.ahead > 0 || data.behind > 0) && (
            <span className="git-panel__ab">
              {data.ahead > 0 && <span title="ahead">↑{data.ahead}</span>}
              {data.behind > 0 && <span title="behind">↓{data.behind}</span>}
            </span>
          )}
          <span className="git-panel__branch-chev">{branchMenuOpen ? '▾' : '▸'}</span>
        </button>
        <button className="ftree__refresh" onClick={refresh} title="refresh">⟳</button>
      </div>

      {branchMenuOpen && (
        <div className="git-panel__branches">
          {branches.map((b) => (
            <button
              key={b.name}
              className={`git-branch ${b.current ? 'git-branch--current' : ''}`}
              onClick={() => !b.current && checkout(b.name)}
              disabled={busy || b.current}
              title={b.upstream ?? ''}
            >
              <span className="git-branch__glyph">{b.current ? '●' : '○'}</span>
              <span className="git-branch__name">{b.name}</span>
              {b.upstream && <span className="git-branch__upstream">{b.upstream}</span>}
            </button>
          ))}
          {creatingBranch ? (
            <div className="git-branch__create">
              <input
                className="field__input field__input--mono"
                placeholder="new branch name"
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newBranchName.trim()) checkout(newBranchName.trim(), true);
                  if (e.key === 'Escape') { setCreatingBranch(false); setNewBranchName(''); }
                }}
              />
              <button
                className="header__btn"
                onClick={() => newBranchName.trim() && checkout(newBranchName.trim(), true)}
                disabled={busy || !newBranchName.trim()}
              >
                create
              </button>
            </div>
          ) : (
            <button className="git-branch__new" onClick={() => setCreatingBranch(true)}>
              + new branch
            </button>
          )}
        </div>
      )}

      <PanelGroup direction="vertical" autoSaveId="git-panel-vertical" className="git-panel__split">
        <Panel defaultSize={40} minSize={20} className="git-panel__split-top">
      <div className="git-panel__commit git-panel__commit--top">
        <div className="git-commit__textarea-wrap">
          <textarea
            className="field__textarea git-commit__textarea"
            value={commitMsg}
            placeholder="commit message"
            onChange={(e) => setCommitMsg(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                if (!busy && commitMsg.trim() && stagedFiles.length > 0) {
                  e.preventDefault();
                  commit();
                }
              }
            }}
          />
          <button
            className="git-commit__generate"
            onClick={generateCommitMsg}
            disabled={generating || busy || (data?.isGitRepo && data.files.length === 0)}
            title={
              data?.isGitRepo && data.files.length === 0
                ? 'no changes to summarize'
                : stagedFiles.length > 0
                  ? 'generate commit message from staged changes (AI)'
                  : 'generate commit message from all changes (AI)'
            }
            aria-label="generate commit message"
          >
            {generating
              ? <span className="git-commit__dots"><span>.</span><span>.</span><span>.</span></span>
              : '✦'
            }
          </button>
        </div>
        <div className="git-commit__actions">
          <div className="git-commit-btn">
            <button
              className="git-commit-btn__main"
              onClick={commit}
              disabled={busy || !commitMsg.trim() || stagedFiles.length === 0}
              title={
                stagedFiles.length === 0
                  ? 'stage files first'
                  : !commitMsg.trim()
                    ? 'enter a commit message'
                    : 'commit staged changes (Ctrl+Enter)'
              }
            >
              commit
            </button>
            <div className="git-commit-btn__menu-wrap">
              <button
                ref={caretBtnRef}
                className="git-commit-btn__caret"
                onClick={() => setCommitMenuOpen((v) => !v)}
                disabled={busy}
                title="more actions"
                aria-label="more commit actions"
                aria-haspopup="menu"
                aria-expanded={commitMenuOpen}
              >
                {commitMenuOpen ? '▴' : '▾'}
              </button>
              {commitMenuOpen && commitMenuPos && createPortal(
                <div
                  ref={commitMenuRef}
                  className="git-commit-btn__menu"
                  role="menu"
                  style={{ top: commitMenuPos.top, right: commitMenuPos.right }}
                >
                  <button
                    className="git-commit-btn__opt"
                    role="menuitem"
                    onClick={commitAndPush}
                    disabled={busy || !commitMsg.trim() || data.files.length === 0}
                    title={
                      data.files.length === 0
                        ? 'no changes'
                        : !commitMsg.trim()
                          ? 'enter a commit message'
                          : 'stage all, commit and push'
                    }
                  >
                    <span className="git-commit-btn__opt-label">commit + push</span>
                    <span className="git-commit-btn__opt-sub">stage all, commit, then git push</span>
                  </button>
                  <button
                    className="git-commit-btn__opt"
                    role="menuitem"
                    onClick={stashFromCommit}
                    disabled={busy || data.files.length === 0}
                    title={
                      data.files.length === 0
                        ? 'nothing to stash'
                        : 'stash all changes (with optional message)'
                    }
                  >
                    <span className="git-commit-btn__opt-label">stash</span>
                    <span className="git-commit-btn__opt-sub">git stash push</span>
                  </button>
                </div>,
                document.body,
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="git-panel__actions">
        <button className="header__btn" onClick={pull} disabled={busy || data.behind === 0}>
          pull
        </button>
        <button className="header__btn" onClick={push} disabled={busy || data.ahead === 0}>
          push
        </button>
        <button
          className={`header__btn ${prOpen ? 'header__btn--active' : ''}`}
          onClick={() => setPrOpen((v) => !v)}
          disabled={busy}
          title="review a GitHub PR"
        >
          review PR
        </button>
      </div>

      {prOpen && (
        <div className="git-panel__pr">
          <input
            className="field__input field__input--mono"
            placeholder="PR url or #number"
            value={prInput}
            onChange={(e) => setPrInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') reviewPr();
              if (e.key === 'Escape') { setPrOpen(false); setPrInput(''); }
            }}
            autoFocus
          />
          <button
            className="composer__send"
            onClick={reviewPr}
            disabled={busy || !prInput.trim()}
          >
            review
          </button>
        </div>
      )}

      {opError && <div className="git-panel__error">{opError}</div>}
      {opOutput && (
        <div className="git-panel__op">
          <div className="git-panel__op-head">
            <span>{opOutput.label}</span>
            <button className="git-panel__op-close" onClick={() => setOpOutput(null)} title="dismiss">✕</button>
          </div>
          <pre className="git-panel__op-text">{opOutput.text}</pre>
        </div>
      )}
        </Panel>
        <PanelResizeHandle className="layout__handle layout__handle--horizontal" />
        <Panel defaultSize={60} minSize={20} className="git-panel__split-bottom">
      <div className="git-panel__list">
        {stagedFiles.length > 0 && (
          <>
            <div className="git-panel__section">
              <span>staged ({stagedFiles.length})</span>
              <button className="git-panel__bulk" onClick={unstageAll} disabled={busy}>
                unstage all
              </button>
            </div>
            {renderTree(stagedTree, 0, true)}
          </>
        )}
        {unstagedFiles.length > 0 && (
          <>
            <div className="git-panel__section">
              <span>changes ({unstagedFiles.length})</span>
              <button className="git-panel__bulk" onClick={stageAll} disabled={busy}>
                stage all
              </button>
            </div>
            {renderTree(unstagedTree, 0, false)}
          </>
        )}
        {data.files.length === 0 && (
          <div className="git-panel__clean">working tree clean</div>
        )}

        <div className="git-panel__stash">
          <button
            className="git-panel__history-toggle"
            onClick={() => setStashOpen((v) => !v)}
          >
            <span>{stashOpen ? '▾' : '▸'} stash ({stashes.length})</span>
          </button>
          {stashOpen && (
            <div className="git-stash">
              <div className="git-stash__save">
                <input
                  className="field__input field__input--mono"
                  placeholder="optional message"
                  value={stashMsg}
                  onChange={(e) => setStashMsg(e.target.value)}
                />
                <button
                  className="header__btn"
                  onClick={stashSave}
                  disabled={busy || data.files.length === 0}
                  title={data.files.length === 0 ? 'nothing to stash' : 'stash current changes'}
                >
                  stash
                </button>
              </div>
              {stashes.length === 0 && (
                <div className="git-stash__empty">no stash entries</div>
              )}
              {stashes.map((s) => (
                <div className="git-stash__row" key={s.ref}>
                  <span className="git-stash__ref">{s.ref}</span>
                  <span className="git-stash__msg" title={s.message}>{s.message}</span>
                  <button
                    className="git-stash__act"
                    onClick={() => stashPop(s.ref)}
                    disabled={busy}
                    title="pop (apply + drop)"
                  >
                    pop
                  </button>
                  <button
                    className="git-stash__act git-stash__act--danger"
                    onClick={() => stashDrop(s.ref)}
                    disabled={busy}
                    title="drop (delete)"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {commits.length > 0 && (
          <div className="git-panel__history">
            <button
              className="git-panel__history-toggle"
              onClick={() => setHistoryOpen((v) => !v)}
            >
              <span>{historyOpen ? '▾' : '▸'} history ({commits.length})</span>
            </button>
            {historyOpen && (
              <div className="git-panel__commits">
                {commits.map((c) => (
                  <button
                    className="git-commit"
                    key={c.hash}
                    title={`${c.hash}\n${c.author} · ${c.date}`}
                    onClick={() => setActiveFile(`diff://commit:${c.hash}`)}
                  >
                    <div className="git-commit__head">
                      <span className="git-commit__abbrev">{c.abbrev}</span>
                      <span className="git-commit__date">{c.date}</span>
                    </div>
                    <div className="git-commit__subject">{c.subject}</div>
                    <div className="git-commit__author">{c.author}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}

function FileRow({
  f, staged, depth = 0, onClick, onAction, onDiscard, busy, confirming, onRequestDiscard, onCancelDiscard,
}: {
  f: GitFileStatus;
  staged: boolean;
  /** Profondità nella tree view: indenta la riga di 12px per livello. */
  depth?: number;
  onClick: () => void;
  onAction: () => void;
  /** null = staged file (no discard available); altrimenti il discard handler */
  onDiscard: (() => void) | null;
  busy: boolean;
  confirming: boolean;
  onRequestDiscard: () => void;
  onCancelDiscard: () => void;
}) {
  const code = staged ? f.staged : f.workdir;
  // Mappa il codice git short-status a una label più leggibile:
  //   ? (untracked, file nuovo non tracciato)  → U
  //   A (added)                                → A
  //   M (modified)                             → M
  //   D (deleted)                              → D
  //   R (renamed)                              → R
  //   U (unmerged conflict)                    → !
  const label = code === '?' ? 'U' : code === 'U' ? '!' : (code ?? '·');
  const codeTitle =
    code === '?' ? 'untracked (new file)' :
    code === 'A' ? 'added' :
    code === 'M' ? 'modified' :
    code === 'D' ? 'deleted' :
    code === 'R' ? 'renamed' :
    code === 'U' ? 'unmerged conflict' :
    '';
  // Mostra solo il basename: il path completo è ricostruibile dalla gerarchia
  // della tree, e il title attribute lo rende disponibile su hover.
  const basename = f.path.split('/').pop() ?? f.path;
  const indent = 6 + depth * 12;
  if (confirming && onDiscard) {
    return (
      <div className="git-row git-row--confirm" style={{ paddingLeft: indent }}>
        <span className="git-row__confirm-text">discard {basename}?</span>
        <div className="git-row__confirm-actions">
          <button className="header__btn" onClick={onCancelDiscard}>cancel</button>
          <button className="header__btn header__btn--danger" onClick={onDiscard} disabled={busy}>
            discard
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="git-row" style={{ paddingLeft: indent }}>
      <button className="git-row__select" onClick={onClick} title={f.path}>
        <span
          className={`git-row__code git-row__code--${label}`}
          title={codeTitle}
          aria-label={codeTitle}
        >
          {label}
        </span>
        <span className="git-row__path">{basename}</span>
      </button>
      {onDiscard && (
        <button
          className="git-row__action git-row__action--discard"
          onClick={onRequestDiscard}
          disabled={busy}
          title="discard changes"
          aria-label="discard changes"
        >
          <TrashIcon size={13} />
        </button>
      )}
      <button
        className="git-row__action"
        onClick={onAction}
        disabled={busy}
        title={staged ? 'unstage' : 'stage'}
        aria-label={staged ? 'unstage' : 'stage'}
      >
        {staged ? '−' : '+'}
      </button>
    </div>
  );
}
