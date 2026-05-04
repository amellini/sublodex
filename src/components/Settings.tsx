import { useEffect, useMemo, useState } from 'react';
import { useSettings } from '../lib/settings';
import { useStore, type StreamSpeed } from '../lib/store';
import { deleteConversation } from '../lib/conversation';
import { cancel } from '../lib/ws';
import { EyeIcon, EyeOffIcon, FolderIcon } from './icons';
import type { Project, RemoteConfig } from '../lib/types';

/** Sentinel scambiato col server quando l'utente non vuole modificare la
 *  password SSH già salvata. Il backend redact-a la password reale nei
 *  response e accetta indietro il sentinel come "tieni quella esistente".
 *  Lato UI: mostriamo un placeholder con asterischi ma manteniamo il
 *  sentinel nello state finché l'utente non digita una nuova stringa. */
const PWD_REDACT_SENTINEL = '__SUBLODEX_PWD_KEEP__';

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const remote = useSettings((s) => s.settings);
  const loading = useSettings((s) => s.loading);
  const remoteError = useSettings((s) => s.error);
  const save = useSettings((s) => s.save);
  const load = useSettings((s) => s.load);

  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string>('');
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [confirmWipe, setConfirmWipe] = useState<string | null>(null);
  const [wipedFlash, setWipedFlash] = useState<string | null>(null);
  const [sshHosts, setSshHosts] = useState<string[]>([]);
  useEffect(() => {
    fetch('/api/ssh-hosts').then((r) => r.json()).then((j: { hosts: { name: string }[] }) => {
      setSshHosts(j.hosts.map((h) => h.name));
    }).catch(() => { /* */ });
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!remote) return;
    setProjects(remote.projects);
    setActiveId(remote.activeId);
    setSelectedId((id) => id || remote.activeId);
  }, [remote]);

  const selected = useMemo(
    () => projects.find((p) => p.id === selectedId) ?? null,
    [projects, selectedId],
  );

  const updateSelected = (patch: Partial<Project>) => {
    if (!selected) return;
    setProjects((ps) => ps.map((p) => (p.id === selected.id ? { ...p, ...patch } : p)));
  };

  const addNew = () => {
    const id = crypto.randomUUID();
    const newProj: Project = {
      id,
      name: 'new project',
      path: '',
      instructions: '',
    };
    setProjects((ps) => [...ps, newProj]);
    setSelectedId(id);
  };

  const requestDelete = (id: string) => {
    setConfirmDelete(id);
  };

  const doDelete = (id: string) => {
    let next = projects.filter((p) => p.id !== id);
    // Se elimini l'ultimo, creo automaticamente un progetto default vuoto
    // così non rimani in stato "no project" (il backend richiede almeno 1)
    if (next.length === 0) {
      next = [{
        id: crypto.randomUUID(),
        name: 'workspace',
        path: '',
        instructions: '',
      }];
    }
    setProjects(next);
    if (activeId === id) setActiveId(next[0].id);
    if (selectedId === id) setSelectedId(next[0].id);
    setConfirmDelete(null);
  };

  const setAsActive = (id: string) => setActiveId(id);

  const browse = async () => {
    setBrowseError(null);
    try {
      const r = await fetch('/api/pick-folder', { method: 'POST' });
      const j = await r.json();
      if (j.path) {
        const seg = (j.path as string).split('/').filter(Boolean).pop() ?? '';
        if (selected) {
          const patch: Partial<Project> = { path: j.path };
          if (
            !selected.name.trim() ||
            selected.name === 'new project' ||
            selected.name === 'workspace'
          ) {
            patch.name = seg || selected.name;
          }
          updateSelected(patch);
        }
      } else if (j.error) {
        setBrowseError(j.error);
      }
    } catch (err) {
      setBrowseError(String(err));
    }
  };

  const saveAll = async () => {
    const oldActive = remote?.activeId;
    // Mitigazione UI per issue #2: se Claude sta streamando e l'utente
    // sta per cambiare progetto, chiediamo conferma e interrompiamo lo
    // stream prima di switchare. Senza questo le route /api/file|tree|git/*
    // continuerebbero a leggere dal singleton settings post-switch.
    if (oldActive && oldActive !== activeId && useStore.getState().isStreaming) {
      const ok = confirm('Claude is streaming — switching project now will interrupt it. Continue?');
      if (!ok) return;
      cancel();
    }
    const ok = await save({ projects, activeId });
    if (!ok) return;
    if (oldActive && oldActive !== activeId) {
      useStore.getState().resetSession();
    }
    onClose();
  };

  const dirty =
    !!remote &&
    (remote.activeId !== activeId ||
      JSON.stringify(remote.projects) !== JSON.stringify(projects));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">projects</h2>
          <button className="header__btn" onClick={onClose}>✕</button>
        </div>

        <StreamSpeedRow />

        <div className="settings-body">
          <aside className="settings-list">
            <div className="settings-list__head">projects</div>
            <div className="settings-list__items">
              {projects.map((p) => (
                <button
                  key={p.id}
                  className={`settings-item ${selectedId === p.id ? 'settings-item--selected' : ''}`}
                  onClick={() => setSelectedId(p.id)}
                  title={p.path}
                >
                  <span className={`settings-item__dot ${activeId === p.id ? 'settings-item__dot--on' : ''}`} />
                  <span className="settings-item__name">{p.name || '(no name)'}</span>
                  <span className="settings-item__path">{shortPath(p.path)}</span>
                </button>
              ))}
            </div>
            <button className="settings-list__new" onClick={addNew}>
              + new project
            </button>
          </aside>

          <section className="settings-detail">
            {!selected ? (
              <div className="settings-detail__empty">select a project</div>
            ) : (
              <>
                <div className="settings-detail__head">
                  {activeId === selected.id ? (
                    <span className="settings-detail__badge settings-detail__badge--active">active</span>
                  ) : (
                    <button className="header__btn" onClick={() => setAsActive(selected.id)}>
                      set as active
                    </button>
                  )}
                  <button
                    className="header__btn"
                    onClick={() => setConfirmWipe(selected.id)}
                    title="delete the saved conversation for this project"
                  >
                    🗑 wipe conversation
                  </button>
                  {wipedFlash === selected.id && (
                    <span className="settings-detail__flash">conversation deleted</span>
                  )}
                  <button
                    className="header__btn header__btn--danger"
                    onClick={() => requestDelete(selected.id)}
                  >
                    delete project
                  </button>
                </div>

                {confirmDelete === selected.id && (
                  <div className="settings-confirm">
                    <span>delete <b>{selected.name}</b>? the folder is not removed.</span>
                    <div className="settings-confirm__actions">
                      <button className="header__btn" onClick={() => setConfirmDelete(null)}>cancel</button>
                      <button className="header__btn header__btn--danger" onClick={() => doDelete(selected.id)}>
                        delete
                      </button>
                    </div>
                  </div>
                )}

                {confirmWipe === selected.id && (
                  <div className="settings-confirm">
                    <span>delete the saved conversation for <b>{selected.name}</b>? the file tree is not touched.</span>
                    <div className="settings-confirm__actions">
                      <button className="header__btn" onClick={() => setConfirmWipe(null)}>cancel</button>
                      <button
                        className="header__btn header__btn--danger"
                        onClick={async () => {
                          await deleteConversation(selected.id);
                          if (activeId === selected.id) {
                            useStore.getState().resetSession();
                          }
                          setConfirmWipe(null);
                          setWipedFlash(selected.id);
                          setTimeout(() => setWipedFlash(null), 1800);
                        }}
                      >
                        wipe
                      </button>
                    </div>
                  </div>
                )}

                <label className="field">
                  <span className="field__label">name</span>
                  <input
                    className="field__input"
                    value={selected.name}
                    onChange={(e) => updateSelected({ name: e.target.value })}
                    placeholder="e.g. my-project"
                  />
                </label>

                <div className="field">
                  <span className="field__label">path</span>
                  <div className="field__row">
                    <input
                      className="field__input field__input--mono"
                      value={selected.path}
                      onChange={(e) => updateSelected({ path: e.target.value })}
                      placeholder={selected.remote ? '/home/me/myproj  (path on remote)' : '/Users/me/code/myproj'}
                    />
                    {!selected.remote && (
                      <button className="field__browse" onClick={browse} type="button">
                        <FolderIcon size={14} />
                        <span>browse</span>
                      </button>
                    )}
                  </div>
                  {browseError && <span className="field__error">{browseError}</span>}
                </div>

                <RemoteSection
                  selected={selected}
                  sshHosts={sshHosts}
                  onChange={(remote) => updateSelected({ remote })}
                />

                <label className="field">
                  <span className="field__label">instructions</span>
                  <textarea
                    className="field__textarea"
                    rows={6}
                    value={selected.instructions}
                    onChange={(e) => updateSelected({ instructions: e.target.value })}
                    placeholder={'e.g.\n\n# Conventions\n- typescript strict\n- prefer functions over classes'}
                  />
                  <span className="field__hint">
                    saved to <code>{selected.path || '<path>'}/CLAUDE.md</code> between markers.
                    The rest of the file is preserved.
                  </span>
                </label>
              </>
            )}
          </section>
        </div>

        {remoteError && <div className="modal__error">{remoteError}</div>}

        <div className="modal__foot">
          <span className="modal__hint">
            {dirty ? 'unsaved changes' : 'all saved'}
          </span>
          <span className="modal__credit">
            SubLodeX · by Amani Andrea aka <em>The Pirate Pinperepette</em>
          </span>
          <span className="modal__spacer" />
          <button className="header__btn" onClick={onClose}>close</button>
          <button className="composer__send" onClick={saveAll} disabled={loading || !dirty}>
            {loading ? 'saving…' : 'save all'}
          </button>
        </div>
      </div>
    </div>
  );
}

function RemoteSection({ selected, sshHosts, onChange }: {
  selected: Project;
  sshHosts: string[];
  onChange: (remote: RemoteConfig | undefined) => void;
}) {
  const remote = selected.remote;
  const enabled = !!remote;
  const [showPwd, setShowPwd] = useState(false);
  const [testState, setTestState] = useState<
    | { kind: 'idle' }
    | { kind: 'testing' }
    | { kind: 'ok'; hostname: string; os: string; claudeInstalled: boolean }
    | { kind: 'fail'; error: string }
  >({ kind: 'idle' });

  const update = (patch: Partial<RemoteConfig>) => {
    if (!remote) return;
    onChange({ ...remote, ...patch });
    setTestState({ kind: 'idle' });
  };

  const test = async () => {
    if (!remote?.host?.trim()) return;
    setTestState({ kind: 'testing' });
    try {
      const r = await fetch('/api/test-ssh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(remote),
      });
      const j = await r.json();
      if (j.ok) {
        setTestState({ kind: 'ok', hostname: j.hostname, os: j.os, claudeInstalled: j.claudeInstalled });
      } else {
        setTestState({ kind: 'fail', error: j.error ?? 'unknown error' });
      }
    } catch (err) {
      setTestState({ kind: 'fail', error: String(err) });
    }
  };

  return (
    <div className="remote-section">
      <div className="remote-section__head">
        <label className="remote-section__toggle">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onChange(e.target.checked ? { host: '' } : undefined)}
          />
          <span>connect via SSH / SFTP</span>
        </label>
        <span className="remote-section__hint">
          if on, claude / files / terminal all run on the remote host
        </span>
      </div>

      {enabled && remote && (
        <div className="remote-section__body">
          <div className="remote-grid">
            <label className="field field--small">
              <span className="field__label">protocol</span>
              <select className="field__input field__input--mono" value="ssh" disabled>
                <option value="ssh">SSH / SFTP</option>
              </select>
            </label>

            <label className="field field--small">
              <span className="field__label">address</span>
              <input
                className="field__input field__input--mono"
                value={remote.host}
                list="ssh-hosts-datalist"
                onChange={(e) => update({ host: e.target.value })}
                placeholder="51.255.192.223  or  alias"
              />
              <datalist id="ssh-hosts-datalist">
                {sshHosts.map((h) => <option key={h} value={h} />)}
              </datalist>
            </label>

            <label className="field field--small remote-grid__port">
              <span className="field__label">port</span>
              <input
                className="field__input field__input--mono"
                type="number"
                value={remote.port ?? 22}
                onChange={(e) => update({ port: Number(e.target.value) || 22 })}
                placeholder="22"
              />
            </label>

            <label className="field field--small">
              <span className="field__label">user name</span>
              <input
                className="field__input field__input--mono"
                value={remote.user ?? ''}
                onChange={(e) => update({ user: e.target.value || undefined })}
                placeholder="ubuntu"
              />
            </label>

            <label className="field field--small">
              <span className="field__label">password</span>
              <div className="remote-grid__pwd">
                <input
                  className="field__input field__input--mono"
                  type={showPwd ? 'text' : 'password'}
                  /* Quando lo state è il sentinel (= password presente lato
                   * server, redacted in response) lasciamo il campo vuoto
                   * a video: il placeholder dice all'utente che è settata.
                   * Se l'utente digita, sostituiamo il sentinel con la
                   * nuova stringa e il PUT manderà quella. */
                  value={remote.password === PWD_REDACT_SENTINEL ? '' : (remote.password ?? '')}
                  onChange={(e) => update({ password: e.target.value || undefined })}
                  placeholder={
                    remote.password === PWD_REDACT_SENTINEL
                      ? '•••••• (set — type to change)'
                      : '(optional — prefer key-based auth)'
                  }
                />
                <button
                  type="button"
                  className="remote-grid__pwd-toggle"
                  onClick={() => setShowPwd((v) => !v)}
                  title={showPwd ? 'hide' : 'show'}
                >
                  {showPwd ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                </button>
              </div>
              {remote.password && (
                <span className="field__hint">requires <code>sshpass</code> on the SubLodeX host</span>
              )}
            </label>

            <label className="field field--small">
              <span className="field__label">identity file</span>
              <input
                className="field__input field__input--mono"
                value={remote.identityFile ?? ''}
                onChange={(e) => update({ identityFile: e.target.value || undefined })}
                placeholder="~/.ssh/id_ed25519"
              />
            </label>

            <label className="field field--small remote-grid__url">
              <span className="field__label">remote url <em style={{ color: 'var(--fg-mute)', fontStyle: 'normal', fontWeight: 400 }}>(optional)</em></span>
              <input
                className="field__input field__input--mono"
                value={remote.remoteUrl ?? ''}
                onChange={(e) => update({ remoteUrl: e.target.value || undefined })}
                placeholder="https://myapp.com"
              />
            </label>

            <label className="field field--small">
              <span className="field__label">shell type</span>
              <select
                className="field__input field__input--mono"
                value={remote.shellType ?? 'auto'}
                onChange={(e) => update({ shellType: e.target.value as RemoteConfig['shellType'] })}
              >
                <option value="auto">automatic</option>
                <option value="bash">bash</option>
                <option value="zsh">zsh</option>
                <option value="sh">sh</option>
                <option value="fish">fish</option>
              </select>
            </label>

            <label className="field field--small remote-grid__check">
              <input
                type="checkbox"
                checked={!!remote.agentForwarding}
                onChange={(e) => update({ agentForwarding: e.target.checked })}
              />
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>allow agent forwarding</div>
                <div style={{ fontSize: 11, color: 'var(--fg-mute)' }}>uses keys stored in your local ssh-agent</div>
              </div>
            </label>
          </div>

          <div className="remote-test">
            <button
              type="button"
              className="remote-test__btn"
              onClick={test}
              disabled={testState.kind === 'testing' || !remote.host?.trim()}
            >
              {testState.kind === 'testing' ? '⏳ testing…' : '⚡ test connection'}
            </button>
            {testState.kind === 'ok' && (
              <div className="remote-test__result remote-test__result--ok">
                <span className="remote-test__icon">✓</span>
                <div>
                  <div><b>connected</b> · {testState.hostname} ({testState.os})</div>
                  <div className="remote-test__detail">
                    {testState.claudeInstalled
                      ? 'claude CLI: ✓ installed'
                      : 'claude CLI: ✗ not found — install it on the remote for claude features'}
                  </div>
                </div>
              </div>
            )}
            {testState.kind === 'fail' && (
              <div className="remote-test__result remote-test__result--fail">
                <span className="remote-test__icon">✗</span>
                <div>
                  <div><b>connection failed</b></div>
                  <pre className="remote-test__error">{testState.error}</pre>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const SPEED_OPTIONS: { id: StreamSpeed; label: string; hint: string }[] = [
  { id: 'instant', label: 'instant', hint: 'no animation (default)' },
  { id: 'fast',    label: 'fast',    hint: '~330 char/s' },
  { id: 'normal',  label: 'normal',  hint: '~100 char/s' },
  { id: 'slow',    label: 'slow',    hint: '~33 char/s — typewriter' },
];

function StreamSpeedRow() {
  const speed = useStore((s) => s.streamSpeed);
  const setSpeed = useStore((s) => s.setStreamSpeed);
  return (
    <div className="settings-pref-row">
      <div className="settings-pref-row__label">
        <div className="settings-pref-row__title">live file write speed</div>
        <div className="settings-pref-row__hint">
          how fast claude's writes appear in the editor while streaming
        </div>
      </div>
      <div className="settings-pref-row__choices">
        {SPEED_OPTIONS.map((o) => (
          <button
            key={o.id}
            className={`settings-pref-chip ${speed === o.id ? 'settings-pref-chip--on' : ''}`}
            onClick={() => setSpeed(o.id)}
            title={o.hint}
            type="button"
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function shortPath(p: string): string {
  if (!p) return '(no path)';
  const home = '/Users/';
  if (p.startsWith(home)) {
    const parts = p.slice(home.length).split('/');
    if (parts.length <= 2) return '~/' + parts.slice(1).join('/');
    return '~/…/' + parts.slice(-2).join('/');
  }
  const parts = p.split('/');
  if (parts.length <= 3) return p;
  return '…/' + parts.slice(-2).join('/');
}
