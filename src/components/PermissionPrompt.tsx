import { useStore } from '../lib/store';
import { respondToPermission } from '../lib/ws';

/** Generic Allow / Allow-always / Deny prompt for tool-use approvals.
 *  Hidden for ExitPlanMode (handled by composer overlay) and
 *  AskUserQuestion (handled by QuestionCard inline). */
export function PermissionPrompt() {
  const pending = useStore((s) => s.pendingPermission);
  if (!pending) return null;
  if (pending.toolName === 'ExitPlanMode') return null;
  if (pending.toolName === 'AskUserQuestion') return null;

  const preview = formatInput(pending.toolName, pending.input);

  return (
    <div className="perm-prompt">
      <div className="perm-prompt__head">
        <span className="perm-prompt__icon" aria-hidden>🔒</span>
        <span className="perm-prompt__title">
          Claude vuole usare <code>{pending.toolName}</code>
        </span>
      </div>
      {preview && <pre className="perm-prompt__preview">{preview}</pre>}
      <div className="perm-prompt__actions">
        <button
          className="perm-prompt__deny"
          onClick={() => respondToPermission(pending.id, 'deny')}
        >
          Rifiuta
        </button>
        <button
          className="perm-prompt__always"
          onClick={() => respondToPermission(pending.id, 'allow_always')}
          title={`Permetti sempre questo tool (${pending.toolName}) in questa sessione`}
        >
          Permetti sempre
        </button>
        <button
          className="perm-prompt__allow"
          onClick={() => respondToPermission(pending.id, 'allow')}
        >
          Permetti
        </button>
      </div>
    </div>
  );
}

function formatInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  if (toolName === 'Bash' && typeof i.command === 'string') {
    return `$ ${truncate(i.command, 400)}`;
  }
  if (typeof i.file_path === 'string') {
    return `path: ${i.file_path}`;
  }
  try {
    const s = JSON.stringify(input, null, 2);
    return s.length > 600 ? s.slice(0, 600) + '\n…' : s;
  } catch {
    return '';
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
