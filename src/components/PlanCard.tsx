import type { UIBlock } from '../lib/types';
import { Markdown } from './Markdown';

type ToolBlock = Extract<UIBlock, { kind: 'tool' }>;

/** Renders the markdown plan proposed by Claude via the ExitPlanMode tool.
 *  Approva / Rivedi actions live in the composer overlay (see Composer.tsx)
 *  because the user wants them inside the editor area, bottom-right. */
export function PlanCard({ block }: { block: ToolBlock }) {
  const plan = typeof block.input.plan === 'string' ? block.input.plan : '';
  const denied = block.result?.isError;

  return (
    <div className={`plan-card${denied ? ' plan-card--denied' : ''}${block.pending ? ' plan-card--pending' : ''}`}>
      <div className="plan-card__head">
        <span className="plan-card__icon" aria-hidden>📋</span>
        <span className="plan-card__title">Piano proposto da Claude</span>
        {block.pending && <span className="plan-card__hint">— rispondi nel composer ↓</span>}
        {denied && <span className="plan-card__hint plan-card__hint--denied">— inviato per revisione</span>}
        {!block.pending && !denied && block.result && (
          <span className="plan-card__hint plan-card__hint--approved">— approvato</span>
        )}
      </div>
      <div className="plan-card__body">
        {plan ? <Markdown>{plan}</Markdown> : <div className="plan-card__empty">(empty plan)</div>}
      </div>
    </div>
  );
}
