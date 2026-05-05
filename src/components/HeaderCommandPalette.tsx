import { useEffect, useRef, useState } from 'react';
import { COMMANDS, type Command } from '../lib/commands';
import { useStore } from '../lib/store';

export function HeaderCommandPalette() {
  const [open, setOpen]           = useState(false);
  const [query, setQuery]         = useState('');
  const [activeCmd, setActiveCmd] = useState<Command | null>(null);
  const [values, setValues]       = useState<Record<string, string>>({});
  const [hlIdx, setHlIdx]         = useState(0);

  const isStreaming = useStore((s) => s.isStreaming);
  const wrapperRef  = useRef<HTMLDivElement>(null);
  const inputRef    = useRef<HTMLInputElement>(null);

  /* ── filtering ─────────────────────────────────────────────────── */
  const q = query.trim().toLowerCase();
  const filtered = COMMANDS.filter((cmd) => {
    if (!q) return true;
    return (
      cmd.name.toLowerCase().includes(q) ||
      cmd.description.toLowerCase().includes(q)
    );
  });

  /* ── close on outside click ─────────────────────────────────────── */
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  /* ── helpers ────────────────────────────────────────────────────── */
  const close = () => {
    setOpen(false);
    setQuery('');
    setActiveCmd(null);
    setValues({});
    setHlIdx(0);
    inputRef.current?.blur();
  };

  const selectCmd = (cmd: Command) => {
    if (cmd.args && cmd.args.length > 0) {
      // toggle inline args form
      setActiveCmd((prev) => (prev?.id === cmd.id ? null : cmd));
      setValues({});
    } else {
      void cmd.run({});
      close();
    }
  };

  const launch = async (cmd: Command) => {
    const missing = (cmd.args ?? []).find(
      (a) => a.required && !values[a.name]?.trim(),
    );
    if (missing) return;
    await cmd.run(values);
    close();
  };

  /* ── keyboard on palette input ──────────────────────────────────── */
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const len = Math.max(filtered.length, 1);
    switch (e.key) {
      case 'Escape':
        close();
        break;
      case 'ArrowDown':
        e.preventDefault();
        setHlIdx((i) => (i + 1) % len);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHlIdx((i) => (i - 1 + len) % len);
        break;
      case 'Enter':
        if (filtered[hlIdx]) selectCmd(filtered[hlIdx]);
        break;
    }
  };

  /* ── render ─────────────────────────────────────────────────────── */
  return (
    <div className="cmd-palette" ref={wrapperRef}>

      {/* ── bar ── */}
      <div className={`cmd-palette__bar${open ? ' cmd-palette__bar--open' : ''}`}>
        <span className="cmd-palette__bar-icon">⌕</span>
        <input
          ref={inputRef}
          className="cmd-palette__bar-input"
          value={query}
          placeholder={open ? 'type / to filter commands…' : 'Search commands…'}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setHlIdx(0);
            setActiveCmd(null);
            setValues({});
          }}
          onKeyDown={handleKeyDown}
        />
        {!open && <kbd className="cmd-palette__bar-kbd">⌘P</kbd>}
      </div>

      {/* ── dropdown ── */}
      {open && (
        <div className="cmd-palette__drop">
          {filtered.length === 0 && (
            <div className="cmd-palette__empty">no commands match</div>
          )}

          {filtered.map((cmd, i) => {
            const isHl     = i === hlIdx;
            const isActive = activeCmd?.id === cmd.id;
            const disabled = isStreaming && cmd.id === 'ask';
            const hasArgs  = (cmd.args ?? []).length > 0;

            return (
              <div
                key={cmd.id}
                className={[
                  'cmd-palette__item',
                  isHl     ? 'cmd-palette__item--hl'     : '',
                  isActive ? 'cmd-palette__item--active'  : '',
                ].join(' ').trim()}
              >
                {/* command row */}
                <button
                  className="cmd-palette__row"
                  onClick={() => selectCmd(cmd)}
                  onMouseEnter={() => setHlIdx(i)}
                  disabled={disabled}
                >
                  <span className="cmd-palette__glyph">{cmd.icon}</span>
                  <span className="cmd-palette__name">{cmd.name}</span>
                  <span className="cmd-palette__desc">{cmd.description}</span>
                  {hasArgs && (
                    <span className="cmd-palette__arrow">
                      {isActive ? '▾' : '▸'}
                    </span>
                  )}
                </button>

                {/* inline args form */}
                {isActive && (
                  <div
                    className="cmd-palette__args"
                    onKeyDown={(e) => { if (e.key === 'Escape') close(); }}
                  >
                    {cmd.args!.map((arg) => (
                      <label key={arg.name} className="cmd-palette__field">
                        <span className="cmd-palette__label">
                          {arg.label}
                          {arg.required && <em> *</em>}
                        </span>

                        {arg.type === 'select' ? (
                          <select
                            className="cmd-palette__arginput"
                            value={values[arg.name] ?? ''}
                            onChange={(e) =>
                              setValues((v) => ({ ...v, [arg.name]: e.target.value }))
                            }
                            autoFocus
                          >
                            <option value="">— choose —</option>
                            {(arg.options ?? []).map((opt) => (
                              <option key={opt} value={opt}>{opt}</option>
                            ))}
                          </select>
                        ) : arg.multiline ? (
                          <textarea
                            className="cmd-palette__arginput"
                            rows={3}
                            placeholder={arg.placeholder}
                            value={values[arg.name] ?? ''}
                            onChange={(e) =>
                              setValues((v) => ({ ...v, [arg.name]: e.target.value }))
                            }
                            autoFocus
                          />
                        ) : (
                          <input
                            className="cmd-palette__arginput"
                            type="text"
                            placeholder={arg.placeholder}
                            value={values[arg.name] ?? ''}
                            onChange={(e) =>
                              setValues((v) => ({ ...v, [arg.name]: e.target.value }))
                            }
                            autoFocus
                          />
                        )}
                      </label>
                    ))}

                    <div className="cmd-palette__run-row">
                      <button
                        className="cmd-palette__run"
                        onClick={() => launch(cmd)}
                        disabled={(cmd.args ?? []).some(
                          (a) => a.required && !values[a.name]?.trim(),
                        )}
                      >
                        run
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
