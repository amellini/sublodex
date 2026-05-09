import { useEffect, useRef, useState } from 'react';
import MonacoEditor, { type BeforeMount, type OnMount } from '@monaco-editor/react';
import { useStore } from '../lib/store';
import { useTheme, resolveTheme } from '../lib/themeStore';
import { THEMES } from '../lib/themes';
import { useScopedTheme } from './ThemeApplier';

/** Genera un tema Monaco da un nostro Theme. */
function buildMonacoTheme(themeId: keyof typeof THEMES): import('monaco-editor').editor.IStandaloneThemeData {
  const c = THEMES[themeId].colors;
  const hex = (s: string) => s.replace('#', '');
  return {
    base: c.monacoBase,
    inherit: true,
    rules: [
      { token: '', foreground: hex(c.fg), background: hex(c.bg) },
      { token: 'comment', foreground: hex(c.fgMute), fontStyle: 'italic' },
      { token: 'string', foreground: hex(c.yellow) },
      { token: 'string.escape', foreground: hex(c.purple) },
      { token: 'keyword', foreground: hex(c.red) },
      { token: 'keyword.control', foreground: hex(c.red) },
      { token: 'keyword.operator', foreground: hex(c.red) },
      { token: 'storage', foreground: hex(c.red) },
      { token: 'storage.type', foreground: hex(c.blue), fontStyle: 'italic' },
      { token: 'number', foreground: hex(c.purple) },
      { token: 'constant', foreground: hex(c.purple) },
      { token: 'constant.language', foreground: hex(c.purple) },
      { token: 'type', foreground: hex(c.blue), fontStyle: 'italic' },
      { token: 'entity.name.type', foreground: hex(c.blue), fontStyle: 'italic' },
      { token: 'entity.name.function', foreground: hex(c.green) },
      { token: 'entity.name.tag', foreground: hex(c.red) },
      { token: 'entity.other.attribute-name', foreground: hex(c.green) },
      { token: 'support.function', foreground: hex(c.blue) },
      { token: 'variable', foreground: hex(c.fg) },
      { token: 'variable.parameter', foreground: hex(c.accent), fontStyle: 'italic' },
      { token: 'tag', foreground: hex(c.red) },
      { token: 'attribute.name', foreground: hex(c.green) },
      { token: 'attribute.value', foreground: hex(c.yellow) },
      { token: 'delimiter', foreground: hex(c.fg) },
      { token: 'operator', foreground: hex(c.red) },
    ],
    colors: {
      'editor.background':            c.bg,
      'editor.foreground':            c.fg,
      'editor.lineHighlightBackground': c.bgCard,
      'editor.lineHighlightBorder':   c.bgCard,
      'editor.selectionBackground':   c.bgCard2,
      'editor.inactiveSelectionBackground': c.bgCard,
      'editorCursor.foreground':      c.fg,
      'editorWhitespace.foreground':  c.border,
      'editorLineNumber.foreground':  c.fgMute,
      'editorLineNumber.activeForeground': c.fgDim,
      'editorIndentGuide.background': c.border,
      'editorIndentGuide.activeBackground': c.borderStrong,
      'editorBracketMatch.background': c.bgCard2,
      'editorBracketMatch.border':    c.borderStrong,
      'editorGutter.background':      c.bg,
    },
  };
}

const beforeMount: BeforeMount = (monaco) => {
  for (const id of Object.keys(THEMES) as (keyof typeof THEMES)[]) {
    monaco.editor.defineTheme(`sublodex-${id}`, buildMonacoTheme(id));
  }
};

export function Editor() {
  // `HTMLElement | null` allinea il tipo del ref alla signature di
  // useScopedTheme (`RefObject<HTMLElement | null>`); senza la nullability
  // esplicita TS non rende compatibili i due RefObject (varianza).
  const ref = useRef<HTMLElement | null>(null);
  useScopedTheme(ref, 'editor');
  const openFiles = useStore((s) => s.openFiles);
  const activeFile = useStore((s) => s.activeFile);
  const setActiveFile = useStore((s) => s.setActiveFile);
  const closeFile = useStore((s) => s.closeFile);

  if (openFiles.length === 0) {
    return (
      <aside className="editor" ref={ref}>
        <div className="editor__tabs editor__tabs--empty">No files open</div>
        <div className="editor__placeholder">
          <div>The editor opens automatically</div>
          <div className="editor__placeholder-sub">When claude reads or writes a file</div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="editor" ref={ref}>
      <div className="editor__tabs">
        {openFiles.map((path) => (
          <Tab
            key={path}
            path={path}
            active={path === activeFile}
            onSelect={() => setActiveFile(path)}
            onClose={() => closeFile(path)}
          />
        ))}
      </div>
      {activeFile && <EditorPane key={activeFile} filePath={activeFile} />}
    </aside>
  );
}

function Tab({ path, active, onSelect, onClose }: {
  path: string; active: boolean; onSelect: () => void; onClose: () => void;
}) {
  const streaming = useStore((s) => s.streamingFiles[path] !== undefined);
  const diff = parseDiffPath(path);
  const tabName = diff
    ? diff.kind === 'commit'
      ? `${diff.hash.slice(0, 7)} (diff)`
      : diff.kind === 'range'
      ? `${diff.from}…${diff.to} (PR)`
      : `${basename(diff.path)} (diff)`
    : basename(path);
  return (
    <div className={`tab ${active ? 'tab--active' : ''} ${streaming ? 'tab--live' : ''} ${diff ? 'tab--diff' : ''}`}>
      <button className="tab__select" onClick={onSelect} title={path}>
        {streaming && <span className="tab__live-dot" />}
        <span className="tab__name">{tabName}</span>
      </button>
      <button
        className="tab__close"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        title="Close"
      >
        ✕
      </button>
    </div>
  );
}

/** Una istanza editor per file: keyed by filePath (vedi parent), così Monaco
 *  ricarica il modello ad ogni switch tab. Stato locale (dirty) si perde
 *  cambiando tab — pattern semplice, IDE-quality multi-buffer è un altro lavoro. */
/** Tab "speciali" per il diff git:
 *   - `diff://workdir:foo.ts`        → workdir vs HEAD
 *   - `diff://staged:foo.ts`         → staged vs HEAD
 *   - `diff://commit:<hash>`         → diff completo del commit (`git show`)
 *   - `diff://range:<from>..<to>`    → `git diff <from>...<to>` (PR review)
 *  Tutti read-only, language Monaco `diff`. */
type DiffInfo =
  | { kind: 'workdir' | 'staged'; path: string }
  | { kind: 'commit'; hash: string }
  | { kind: 'range'; from: string; to: string };

function parseDiffPath(p: string): DiffInfo | null {
  if (!p.startsWith('diff://')) return null;
  const rest = p.slice('diff://'.length);
  const idx = rest.indexOf(':');
  if (idx < 0) return null;
  const kind = rest.slice(0, idx);
  const value = rest.slice(idx + 1);
  if (kind === 'workdir' || kind === 'staged') return { kind, path: value };
  if (kind === 'commit') return { kind: 'commit', hash: value };
  if (kind === 'range') {
    const [from, to] = value.split('..');
    if (from && to) return { kind: 'range', from, to };
  }
  return null;
}

function EditorPane({ filePath }: { filePath: string }) {
  const themeSettings = useTheme();
  const themeId = resolveTheme(themeSettings, 'editor');
  const streamingContent = useStore((s) => s.streamingFiles[filePath]?.displayed);
  const [diskContent, setDiskContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const editorRef = useRef<any>(null);

  const diffInfo = parseDiffPath(filePath);
  const isDiff = diffInfo !== null;

  useEffect(() => {
    if (streamingContent !== undefined) return;
    let cancelled = false;
    setLoading(true);
    let url: string;
    if (diffInfo?.kind === 'commit') {
      url = `/api/git/show?hash=${encodeURIComponent(diffInfo.hash)}`;
    } else if (diffInfo?.kind === 'workdir' || diffInfo?.kind === 'staged') {
      url = `/api/git/diff?path=${encodeURIComponent(diffInfo.path)}&staged=${diffInfo.kind === 'staged' ? '1' : '0'}`;
    } else if (diffInfo?.kind === 'range') {
      url = `/api/git/diff-range?from=${encodeURIComponent(diffInfo.from)}&to=${encodeURIComponent(diffInfo.to)}`;
    } else {
      url = `/api/file?path=${encodeURIComponent(filePath)}`;
    }
    fetch(url)
      .then((r) => (r.ok ? r.text() : ''))
      .then((text) => {
        if (cancelled) return;
        setDiskContent(text);
        setDirty(false);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filePath, streamingContent]);

  useEffect(() => {
    if (streamingContent === undefined) return;
    const ed = editorRef.current;
    if (!ed) return;
    const lineCount = ed.getModel()?.getLineCount() ?? 1;
    ed.revealLine(lineCount);
  }, [streamingContent]);

  const isStreaming = streamingContent !== undefined;
  const value = isStreaming ? streamingContent : diskContent;

  const save = async () => {
    if (isStreaming || isDiff) return;
    const r = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`, {
      method: 'PUT',
      body: diskContent,
    });
    if (r.ok) {
      setSavedFlash(true);
      setDirty(false);
      setTimeout(() => setSavedFlash(false), 1200);
    }
  };

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => save());
  };

  const diffLabel = (() => {
    if (!diffInfo) return '';
    if (diffInfo.kind === 'commit') return `commit ${diffInfo.hash.slice(0, 7)}`;
    if (diffInfo.kind === 'range') return `${diffInfo.from} → ${diffInfo.to}`;
    return diffInfo.kind;
  })();

  const status = loading
    ? 'Loading…'
    : isDiff
    ? `Diff · ${diffLabel}`
    : isStreaming
    ? 'Claude is writing…'
    : savedFlash
    ? '✓ Saved'
    : dirty
    ? 'Modified · ⌘S to save'
    : 'Ready';

  const headPath = (() => {
    if (!isDiff || !diffInfo) return filePath;
    if (diffInfo.kind === 'commit') return `commit · ${diffInfo.hash}`;
    if (diffInfo.kind === 'range') return `range · ${diffInfo.from}...${diffInfo.to}`;
    // Dopo gli early-return sopra, TS sa che diffInfo.kind è 'workdir' | 'staged'
    // e quei rami della discriminated union hanno entrambi `path: string`.
    return `${diffInfo.kind} · ${diffInfo.path}`;
  })();

  return (
    <>
      <div className="editor__head">
        <span className="editor__path">{headPath}</span>
        <span className={`editor__status ${isStreaming ? 'editor__status--live' : ''}`}>
          {isStreaming && <span className="editor__live-dot" />}
          {status}
        </span>
        {!isStreaming && !isDiff && (
          <button className="header__btn" onClick={save} disabled={loading || !dirty}>
            Save
          </button>
        )}
      </div>
      <div className="editor__body">
        <MonacoEditor
          height="100%"
          language={isDiff ? 'diff' : guessLanguage(filePath)}
          value={value}
          theme={`sublodex-${themeId}`}
          beforeMount={beforeMount}
          onChange={(v) => {
            if (isStreaming || isDiff) return;
            setDiskContent(v ?? '');
            setDirty(true);
          }}
          onMount={onMount}
          options={{
            readOnly: isStreaming || isDiff,
            fontSize: 13,
            fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            minimap: { enabled: false },
            wordWrap: 'on',
            scrollBeyondLastLine: false,
            tabSize: 2,
            automaticLayout: true,
            renderLineHighlight: 'gutter',
          }}
        />
      </div>
    </>
  );
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

function guessLanguage(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    mjs: 'javascript', cjs: 'javascript',
    py: 'python', rs: 'rust', go: 'go', java: 'java', kt: 'kotlin',
    rb: 'ruby', php: 'php', swift: 'swift',
    c: 'c', cpp: 'cpp', cc: 'cpp', h: 'cpp', hpp: 'cpp', cs: 'csharp',
    md: 'markdown', mdx: 'markdown',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
    css: 'css', scss: 'scss', html: 'html', xml: 'xml',
    sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell',
  };
  return ext ? map[ext] ?? 'plaintext' : 'plaintext';
}
