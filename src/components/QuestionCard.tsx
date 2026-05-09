import { useState } from 'react';
import type { UIBlock } from '../lib/types';
import { useStore } from '../lib/store';
import { respondToPermission } from '../lib/ws';

type ToolBlock = Extract<UIBlock, { kind: 'tool' }>;

type QuestionOption = { label: string; description?: string };

const OTHER_KEY = '__other__';

/** Renders an inline Yes/No or multi-select question Claude asked via the
 *  AskUserQuestion tool. The answer is round-tripped via permission_response
 *  with a payload string; the server forwards it as a deny-message so Claude
 *  reads the user's choice and continues. */
export function QuestionCard({ block }: { block: ToolBlock }) {
  const pending = useStore((s) => s.pendingPermission);
  const isActive = !!(block.pending && pending && pending.toolName === 'AskUserQuestion');

  const question = readQuestion(block.input);
  const options  = readOptions(block.input);
  const multi    = readMulti(block.input);

  const [picked, setPicked] = useState<string[]>([]);
  const [otherText, setOtherText] = useState('');

  const toggle = (key: string) => {
    setPicked((cur) => {
      if (multi) return cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key];
      return [key];
    });
  };

  const buildAnswer = (): string => {
    const parts = picked.map((k) => {
      if (k === OTHER_KEY) return otherText.trim();
      return k;
    }).filter(Boolean);
    return parts.join(', ');
  };

  const canSubmit = (() => {
    if (!isActive) return false;
    if (picked.length === 0) return false;
    if (picked.includes(OTHER_KEY) && !otherText.trim()) return false;
    return true;
  })();

  const submit = () => {
    if (!pending || !canSubmit) return;
    respondToPermission(pending.id, 'allow', buildAnswer());
  };

  const denied = block.result?.isError;

  return (
    <div className={`q-card${denied ? ' q-card--denied' : ''}${isActive ? ' q-card--active' : ''}`}>
      <div className="q-card__head">
        <span className="q-card__icon" aria-hidden>❓</span>
        <span className="q-card__question">{question || '(no question text)'}</span>
      </div>

      <div className="q-card__options" role={multi ? 'group' : 'radiogroup'}>
        {options.map((o) => {
          const checked = picked.includes(o.label);
          return (
            <Choice
              key={o.label}
              type={multi ? 'checkbox' : 'radio'}
              name={`q-${block.id}`}
              checked={checked}
              disabled={!isActive}
              label={o.label}
              description={o.description}
              onChange={() => toggle(o.label)}
            />
          );
        })}

        {/* Synthetic "Altro" row — always present, with inline input */}
        <Choice
          key={OTHER_KEY}
          type={multi ? 'checkbox' : 'radio'}
          name={`q-${block.id}`}
          checked={picked.includes(OTHER_KEY)}
          disabled={!isActive}
          label="Altro"
          description="Specifica una risposta libera"
          onChange={() => toggle(OTHER_KEY)}
          rightSlot={
            <input
              className="q-card__other-input"
              type="text"
              placeholder="Scrivi qui…"
              value={otherText}
              disabled={!isActive}
              onChange={(e) => {
                setOtherText(e.target.value);
                // Auto-seleziona "Altro" non appena l'utente inizia a digitare,
                // così non serve un click sul radio prima di scrivere.
                if (e.target.value && !picked.includes(OTHER_KEY)) toggle(OTHER_KEY);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) { e.preventDefault(); submit(); }
              }}
            />
          }
        />
      </div>

      {isActive && (
        <div className="q-card__actions">
          <button
            className="q-card__submit"
            onClick={submit}
            disabled={!canSubmit}
          >
            Invia risposta
          </button>
        </div>
      )}
      {!isActive && !denied && block.result && (
        <div className="q-card__hint">— risposta inviata</div>
      )}
      {denied && <div className="q-card__hint q-card__hint--denied">— annullata</div>}
    </div>
  );
}

/** Custom-styled radio/checkbox row. Native control hidden for layout/keyboard
 *  semantics; visual indicator is a `.q-card__dot` element. */
function Choice({
  type, name, checked, disabled, label, description, onChange, rightSlot,
}: {
  type: 'radio' | 'checkbox';
  name: string;
  checked: boolean;
  disabled: boolean;
  label: string;
  description?: string;
  onChange: () => void;
  rightSlot?: React.ReactNode;
}) {
  return (
    <label className={`q-card__opt q-card__opt--${type}${checked ? ' q-card__opt--on' : ''}${disabled ? ' q-card__opt--disabled' : ''}`}>
      <input
        className="q-card__input-hidden"
        type={type}
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span className="q-card__dot" aria-hidden />
      <span className="q-card__opt-text">
        <span className="q-card__opt-label">{label}</span>
        {description && <span className="q-card__opt-desc">{description}</span>}
      </span>
      {rightSlot && <span className="q-card__opt-slot">{rightSlot}</span>}
    </label>
  );
}

function readQuestion(input: unknown): string {
  if (input && typeof input === 'object') {
    const i = input as Record<string, unknown>;
    if (typeof i.question === 'string') return i.question;
    if (Array.isArray(i.questions) && i.questions.length > 0) {
      const q = i.questions[0];
      if (q && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string') {
        return (q as { question: string }).question;
      }
    }
  }
  return '';
}

function readOptions(input: unknown): QuestionOption[] {
  if (!input || typeof input !== 'object') return [];
  const i = input as Record<string, unknown>;
  let arr: unknown = i.options;
  if (!Array.isArray(arr) && Array.isArray(i.questions) && i.questions.length > 0) {
    const q = i.questions[0] as Record<string, unknown> | undefined;
    arr = q?.options;
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((o): QuestionOption | null => {
      if (typeof o === 'string') return { label: o };
      if (o && typeof o === 'object') {
        const op = o as Record<string, unknown>;
        const label = typeof op.label === 'string' ? op.label
          : typeof op.value === 'string' ? op.value
          : null;
        if (!label) return null;
        return { label, description: typeof op.description === 'string' ? op.description : undefined };
      }
      return null;
    })
    .filter((o): o is QuestionOption => o !== null);
}

function readMulti(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false;
  const i = input as Record<string, unknown>;
  if (typeof i.multiSelect === 'boolean') return i.multiSelect;
  if (Array.isArray(i.questions) && i.questions.length > 0) {
    const q = i.questions[0] as Record<string, unknown> | undefined;
    if (typeof q?.multiSelect === 'boolean') return q.multiSelect;
  }
  return false;
}
