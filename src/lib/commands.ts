/**
 * Native Claude Code commands, ported as web-side actions.
 *
 * Real `claude` slash commands (`/model`, `/clear`, …) only work in
 * interactive mode. We use `claude -p` (one-shot), so here we recreate
 * the effect by manipulating local state and/or the flags passed to
 * the next `claude -p` invocation.
 */

import { sendPrompt } from './ws';
import { useStore } from './store';
import { useUI } from './ui';

export type CommandArg = {
  name: string;
  label: string;
  placeholder?: string;
  multiline?: boolean;
  required?: boolean;
  type?: 'text' | 'select';
  options?: string[];
};

export type Command = {
  id: string;
  name: string;
  icon: string;        // single-char glyph for the collapsed rail
  description: string;
  args?: CommandArg[];
  run: (values: Record<string, string>) => void | Promise<void>;
};

export const MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];

const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
];

export const COMMANDS: Command[] = [
  {
    id: 'login',
    name: '/login',
    icon: '↪',
    description: 'Log in to claude.ai (Pro/Max subscription) — opens your browser',
    run: async () => {
      const s = useStore.getState();
      s.appendSystemMessage('opening browser for claude.ai login… complete the OAuth flow, then come back here');
      try {
        const r = await fetch('/api/login', { method: 'POST' });
        const j = await r.json();
        if (j.ok) {
          const out = (j.stdout as string) || 'Login successful';
          s.appendSystemMessage(`✓ ${out}\n\nrun /status to confirm`);
        } else {
          const err = (j.stderr as string) || (j.error as string) || `exit ${j.code}`;
          s.appendSystemMessage(`✗ login failed: ${err}`);
        }
      } catch (err) {
        s.appendSystemMessage(`✗ login error: ${String(err)}`);
      }
    },
  },
  {
    id: 'logout',
    name: '/logout',
    icon: '↩',
    description: 'Log out of claude.ai',
    run: async () => {
      const s = useStore.getState();
      try {
        const r = await fetch('/api/logout', { method: 'POST' });
        const j = await r.json();
        if (j.ok) {
          s.appendSystemMessage(`✓ ${(j.stdout as string) || 'logged out'}`);
        } else {
          s.appendSystemMessage(`✗ logout failed: ${(j.stderr as string) || (j.error as string)}`);
        }
      } catch (err) {
        s.appendSystemMessage(`✗ logout error: ${String(err)}`);
      }
    },
  },
  {
    id: 'model',
    name: '/model',
    icon: 'M',
    description: 'Switch model for upcoming turns',
    args: [{
      name: 'model',
      label: 'model',
      type: 'select',
      options: MODELS,
      required: true,
    }],
    run: ({ model }) => {
      useStore.getState().setModel(model);
      useStore.getState().appendSystemMessage(`model set: \`${model}\` (applies from next turn)`);
    },
  },
  {
    id: 'clear',
    name: '/clear',
    icon: '⌫',
    description: 'Clear the conversation and start a new session',
    run: () => {
      useStore.getState().resetSession();
    },
  },
  {
    id: 'usage',
    name: '/usage',
    icon: '▦',
    description: 'Show plan usage (5h session + 7d weekly limits)',
    run: async () => {
      const s = useStore.getState();
      try {
        const r = await fetch('/api/usage');
        const j = await r.json();
        if (!r.ok || j.error) {
          s.appendSystemMessage(`✗ usage fetch failed: ${j.error ?? r.statusText}`);
          return;
        }
        s.appendUsageCard(j);
      } catch (err) {
        s.appendSystemMessage(`✗ usage error: ${String(err)}`);
      }
    },
  },
  {
    id: 'cost',
    name: '/cost',
    icon: '$',
    description: 'Show cumulative session cost',
    run: () => {
      const s = useStore.getState();
      const lines = [
        `total cost:    $${s.totalCost.toFixed(4)}`,
        `turns:         ${s.turns}`,
        `input tokens:  ${s.totalInput.toLocaleString()}`,
        `output tokens: ${s.totalOutput.toLocaleString()}`,
      ].join('\n');
      s.appendSystemMessage(lines);
    },
  },
  {
    id: 'init',
    name: '/init',
    icon: '⚙',
    description: 'Run /init — ask Claude to analyze the repo and write CLAUDE.md',
    run: () => {
      // Slash command nativo del SDK Claude — il runtime sa già cosa fare.
      sendPrompt('/init');
    },
  },
  {
    id: 'permissions',
    name: '/permissions',
    icon: '⊙',
    description: "Change claude's permission mode",
    args: [{
      name: 'mode',
      label: 'mode',
      type: 'select',
      options: PERMISSION_MODES,
      required: true,
    }],
    run: ({ mode }) => {
      useStore.getState().setPermissionMode(mode);
      useStore.getState().appendSystemMessage(`permission mode: \`${mode}\` (applies from next turn)`);
    },
  },
  {
    id: 'status',
    name: '/status',
    icon: 'ⓘ',
    description: 'Show what claude is actually using (auth, model, version, project, cost)',
    run: async () => {
      const s = useStore.getState();

      // diagnostica server (claude version, auth, default model)
      let claudeVersion = '?';
      let claudePath = '?';
      let authMethod = '?';
      let authDetail = '';
      let defaultModel: string | undefined;
      try {
        const r = await fetch('/api/diagnostics');
        if (r.ok) {
          const d = await r.json();
          claudeVersion = d.claudeVersion ?? '(claude not in PATH)';
          claudePath = d.claudePath ?? '(unknown)';
          authMethod = d.authMethod ?? '?';
          authDetail = d.authDetail ?? '';
          defaultModel = d.defaultModel;
        }
      } catch { /* noop */ }

      // settings progetto attivo
      let projectName = '-';
      let projectPath = '-';
      let projectsCount = 0;
      try {
        const r = await fetch('/api/settings');
        if (r.ok) {
          const sett = await r.json();
          projectsCount = sett.projects?.length ?? 0;
          const active = sett.projects?.find((p: any) => p.id === sett.activeId) ?? sett.projects?.[0];
          if (active) { projectName = active.name; projectPath = active.path; }
        }
      } catch { /* noop */ }

      const modelInUse =
        s.runtimeModel ??
        s.model ??
        defaultModel ??
        '(unknown — start a turn first)';

      const modelOverride = s.model
        ? `${s.model} (forced via /model)`
        : defaultModel
        ? `${defaultModel} (from ~/.claude/settings.json)`
        : '(none — claude picks its default)';

      const lines = [
        '── claude ──────────────────────────────────────',
        `version:         ${claudeVersion}`,
        `binary:          ${claudePath}`,
        `auth method:     ${authMethod}`,
        `auth detail:     ${authDetail}`,
        '',
        '── model ───────────────────────────────────────',
        `in use now:      ${modelInUse}`,
        `your override:   ${modelOverride}`,
        `permission mode: ${s.permissionMode}`,
        '',
        '── project ─────────────────────────────────────',
        `active:          ${projectName}`,
        `path:            ${projectPath}`,
        `total projects:  ${projectsCount}`,
        '',
        '── session ─────────────────────────────────────',
        `session id:      ${s.sessionId ?? '(none yet)'}`,
        `turns:           ${s.turns}`,
        `total cost:      $${s.totalCost.toFixed(4)} ${authMethod === 'subscription' ? '(equivalent — actual billing is your subscription)' : ''}`,
        `input tokens:    ${s.totalInput.toLocaleString()}`,
        `output tokens:   ${s.totalOutput.toLocaleString()}`,
      ].join('\n');
      s.appendSystemMessage(lines);
    },
  },
  {
    id: 'ask',
    name: '/ask',
    icon: '❯',
    description: 'Send a free-form prompt (text shortcut)',
    args: [{
      name: 'prompt',
      label: 'prompt',
      placeholder: 'type here…',
      multiline: true,
      required: true,
    }],
    run: ({ prompt }) => sendPrompt(prompt),
  },
];
