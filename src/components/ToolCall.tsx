import { useState } from 'react';
import type { UIBlock } from '../lib/types';
import { useStore } from '../lib/store';
import { useUI } from '../lib/ui';
import { PlanCard } from './PlanCard';
import { QuestionCard } from './QuestionCard';

type ToolBlock = Extract<UIBlock, { kind: 'tool' }>;
type Variant = 'read' | 'edit' | 'bash' | 'search' | 'web' | 'task' | 'default';

function variantOf(name: string): Variant {
  if (name === 'Read' || name === 'NotebookRead') return 'read';
  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit') return 'edit';
  if (name === 'Bash' || name === 'BashOutput' || name === 'KillShell') return 'bash';
  if (name === 'Grep' || name === 'Glob') return 'search';
  if (name === 'WebFetch' || name === 'WebSearch') return 'web';
  if (name === 'Task') return 'task';
  return 'default';
}

const ICON: Record<Variant, string> = {
  read: '📖', edit: '✏️', bash: '⚡',
  search: '🔎', web: '🌐', task: '🤝', default: '⚙',
};

export function ToolCall({ block }: { block: ToolBlock }) {
  if (block.name === 'ExitPlanMode') return <PlanCard block={block} />;
  if (block.name === 'AskUserQuestion') return <QuestionCard block={block} />;
  return <GenericToolCall block={block} />;
}

function GenericToolCall({ block }: { block: ToolBlock }) {
  const hasError = !!block.result?.isError;
  const [open, setOpen] = useState(false);
  const setActiveFile = useStore((s) => s.setActiveFile);
  const openEditorPanel = useUI((s) => s.openEditorPanel);
  const variant = variantOf(block.name);

  // niente auto-expand: l'errore è spesso una recovery di claude (file already exists,
  // permesso negato e simili) — mostriamo solo il pill "error" nell'header,
  // l'utente può cliccare per vedere il dettaglio.

  const filePath = typeof block.input.file_path === 'string' ? block.input.file_path : undefined;
  const headlineText = headline(block);
  const meta = renderMeta(block, variant);

  const onPathClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (filePath) { setActiveFile(filePath); openEditorPanel(); }
  };

  return (
    <div className={`tool tool--${variant} ${open ? 'tool--open' : ''}`}>
      <div className="tool__head" onClick={() => setOpen((v) => !v)}>
        <span className="tool__icon">{ICON[variant]}</span>
        <span className="tool__name">{block.name}</span>
        {filePath ? (
          <button className="tool__path tool__path--link" onClick={onPathClick} title="Open in editor">
            {shortPath(filePath)}
          </button>
        ) : headlineText ? (
          <span className="tool__path">{headlineText}</span>
        ) : null}
        <span className="tool__meta">
          {meta}
          {block.pending ? (
            <span className="tool__pending" />
          ) : block.result?.isError ? (
            <span className="tool__err">Error</span>
          ) : (
            <span className="tool__chev">›</span>
          )}
        </span>
      </div>
      {open && (
        <div className="tool__body">
          <ToolBody block={block} variant={variant} />
        </div>
      )}
    </div>
  );
}

function headline(block: ToolBlock): string {
  const i = block.input;
  if (typeof i.command === 'string') return truncate(i.command, 70);
  if (typeof i.pattern === 'string') return truncate(i.pattern, 60);
  if (typeof i.url === 'string') return truncate(i.url, 60);
  if (typeof i.description === 'string') return truncate(i.description, 60);
  return '';
}

function renderMeta(block: ToolBlock, variant: Variant) {
  if (variant === 'edit') {
    const { added, removed } = countDiff(block);
    return (
      <>
        {added > 0 && <span className="tool__delta-add">+{added}</span>}
        {removed > 0 && <span className="tool__delta-del">−{removed}</span>}
      </>
    );
  }
  return null;
}

function ToolBody({ block, variant }: { block: ToolBlock; variant: Variant }) {
  return (
    <>
      {block.result?.isError && (
        <pre className="tool__error">{block.result.content}</pre>
      )}
      {variant === 'edit' ? <EditBody block={block} /> :
        variant === 'bash' ? <BashBody block={block} /> :
        variant === 'read' ? <ReadBody block={block} /> :
        variant === 'search' ? <SearchBody block={block} /> :
        <DefaultBody block={block} />}
    </>
  );
}

function EditBody({ block }: { block: ToolBlock }) {
  let hunks: Array<{ before: string; after: string }> = [];
  if (block.name === 'Write') {
    hunks = [{ before: '', after: String(block.input.content ?? '') }];
  } else if (block.name === 'Edit') {
    hunks = [{
      before: String(block.input.old_string ?? ''),
      after: String(block.input.new_string ?? ''),
    }];
  } else if (block.name === 'MultiEdit') {
    const edits = (block.input.edits as Array<{ old_string: string; new_string: string }> | undefined) ?? [];
    hunks = edits.map((e) => ({
      before: String(e.old_string ?? ''),
      after: String(e.new_string ?? ''),
    }));
  }

  return (
    <div>
      {block.name === 'Write' ? (
        <div className="tool__hint">New file · preview in the editor →</div>
      ) : (
        <div className="tool__diff">
          {hunks.map((h, i) => (
            <div key={i} className="tool__hunk">
              {h.before && h.before.split('\n').map((l, j) => (
                <div key={`b${j}`} className="del">− {l}</div>
              ))}
              {h.after && h.after.split('\n').map((l, j) => (
                <div key={`a${j}`} className="add">+ {l}</div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BashBody({ block }: { block: ToolBlock }) {
  const cmd = String(block.input.command ?? '');
  const out = block.result ? stripAnsi(block.result.content) : '';
  return (
    <div className="tool__bash">
      <div className="tool__bash-cmd">$ {cmd}</div>
      {out && <div className="tool__bash-out">{out.length > 4000 ? out.slice(0, 4000) + '\n…(truncated)' : out}</div>}
    </div>
  );
}

function ReadBody({ block }: { block: ToolBlock }) {
  return <div className="tool__hint">Opened in the editor →</div>;
}

function SearchBody({ block }: { block: ToolBlock }) {
  const out = block.result?.content ?? '';
  return (
    <div>
      <div className="tool__kv">
        {Object.entries(block.input).map(([k, v]) => (
          <div key={k}><b>{k}</b>: <code>{String(v)}</code></div>
        ))}
      </div>
      {out && <pre className="tool__search-out">{out.slice(0, 2000)}</pre>}
    </div>
  );
}

function DefaultBody({ block }: { block: ToolBlock }) {
  return (
    <div>
      <pre className="tool__kv-pre">{JSON.stringify(block.input, null, 2)}</pre>
      {block.result && <pre className="tool__result-pre">{block.result.content.slice(0, 4000)}</pre>}
    </div>
  );
}

function countDiff(block: ToolBlock): { added: number; removed: number } {
  const i = block.input;
  if (block.name === 'Write') {
    const lines = String(i.content ?? '').split('\n').length;
    return { added: lines, removed: 0 };
  }
  if (block.name === 'Edit') {
    return {
      added: String(i.new_string ?? '').split('\n').length,
      removed: String(i.old_string ?? '').split('\n').length,
    };
  }
  if (block.name === 'MultiEdit') {
    const edits = (i.edits as Array<{ old_string: string; new_string: string }> | undefined) ?? [];
    let added = 0, removed = 0;
    for (const e of edits) {
      added += String(e.new_string ?? '').split('\n').length;
      removed += String(e.old_string ?? '').split('\n').length;
    }
    return { added, removed };
  }
  return { added: 0, removed: 0 };
}

function shortPath(p: string): string {
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return '…/' + parts.slice(-2).join('/');
}
function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n) + '…' : s; }
function stripAnsi(s: string): string { return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''); }
