/**
 * Backend Bun: WebSocket per `claude` CLI + REST per progetti, file, settings.
 * Pensato per girare SOLO su localhost.
 */

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, stat, readdir, access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------- env / SSH ControlMaster ----------
 * Il PTY è gestito interamente dal lato Rust (portable-pty), quindi qui non
 * spawniamo più node-pty. Resta utile mantenere un ControlMaster path
 * comune con il modulo Rust del PTY: così le sessioni SSH del terminale e
 * le chiamate `sshExec` (file ops) condividono la stessa TCP. */

/** SSH ControlMaster: riusa la TCP per richieste successive (~10ms invece di ~300ms).
 *  Supportato solo da OpenSSH su Unix. Su Windows OpenSSH-for-Windows non supporta
 *  i Unix domain socket usati da ControlMaster, quindi disabilitato.
 *
 *  Path: deve essere CORTO perché i Unix socket sono limitati a ~104 char e SSH
 *  aggiunge ~80 char di hash+tmp suffix. Usiamo `<tmpdir>/sub-cm-<uid>/`. */
let SSH_CM_DIR: string | null = null;
let SSH_CM_FLAGS: string[] = [];
if (process.platform !== 'win32') {
  const uid = (process as any).getuid?.() ?? 0;
  // os.tmpdir() su macOS può essere lungo (/var/folders/...). /tmp esiste
  // sempre su Unix ed è 4 char.
  const tmp = '/tmp';
  SSH_CM_DIR = `${tmp}/sub-cm-${uid}`;
  try {
    await mkdir(SSH_CM_DIR, { recursive: true });
    SSH_CM_FLAGS = [
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${SSH_CM_DIR}/%C`,
      '-o', 'ControlPersist=10m',
    ];
  } catch {
    // se non possiamo creare la dir, lasciamo perdere il multiplexing
    SSH_CM_DIR = null;
  }
}

/* ---------- env normalization ----------
 * Le .app macOS launchate da Finder/Launchpad ricevono un PATH minimale
 * (no Homebrew, no nvm, no asdf). Per `ssh` / `sshpass` servono i path
 * standard. Prepende quelli noti se mancano. */
{
  const wantPaths = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    `${process.env.HOME ?? ''}/.bun/bin`,
    `${process.env.HOME ?? ''}/.local/bin`,
    '/usr/bin',
    '/usr/sbin',
    '/bin',
    '/sbin',
  ].filter(Boolean);
  const cur = (process.env.PATH ?? '').split(':').filter(Boolean);
  const merged = [...wantPaths, ...cur.filter((p) => !wantPaths.includes(p))];
  process.env.PATH = merged.join(':');
}

/** Risolve un binario in PATH ritornando il path assoluto, o null se non
 *  trovato. Cerca: candidates espliciti, poi process.env.PATH. Usato per
 *  fixare bun.spawn che a volte non ricerca correttamente il PATH per
 *  binari relativi quando l'app è launchata da Finder con env minimale. */
function whichBin(name: string, candidates: string[] = []): string | null {
  const fs = require('fs');
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* */ }
  }
  const dirs = (process.env.PATH ?? '').split(':');
  for (const d of dirs) {
    if (!d) continue;
    const full = `${d}/${name}`;
    try { if (fs.existsSync(full)) return full; } catch { /* */ }
  }
  return null;
}

/* ---------- log strutturato ---------- */
// Implementazione spostata in `src-server/log.ts` (Fase 3.1).
// Riesporto per compat dei consumer esterni che leggono `log` da server.ts.
import { log } from './src-server/log';
export { log };

const SSHPASS_BIN = whichBin('sshpass', [
  '/opt/homebrew/bin/sshpass',
  '/usr/local/bin/sshpass',
  '/usr/bin/sshpass',
]);
log.info('boot', 'sshpass resolved', { path: SSHPASS_BIN ?? '(not found)' });

const PORT = Number(process.env.PORT ?? 3001);
/** Dove vive `settings.json` + `conversations/`.
 *  - In una `.app` distribuita: `app.path().app_data_dir()` di Tauri,
 *    passato via env (`~/Library/Application Support/SubLodeX/` su Mac).
 *  - In dev (script bun puro): `__dirname/.data/` per non sporcare la home. */
const DATA_DIR = process.env.SUBLODEX_DATA_DIR
  ? path.resolve(process.env.SUBLODEX_DATA_DIR)
  : path.join(__dirname, '.data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const PERMISSION_MODE = process.env.PERMISSION_MODE ?? 'bypassPermissions';
const USE_API_KEY = process.env.CLAUDE_WEB_USE_API_KEY === '1';

const CLAUDE_MD_START = '<!-- claude-web:start -->';
const CLAUDE_MD_END = '<!-- claude-web:end -->';

type RemoteConfig = {
  host: string;
  port?: number;
  user?: string;
  password?: string;
  identityFile?: string;
  remoteUrl?: string;
  shellType?: 'auto' | 'bash' | 'zsh' | 'sh' | 'fish';
  agentForwarding?: boolean;
};

type Project = {
  id: string;
  name: string;
  path: string;
  instructions: string;
  remote?: RemoteConfig;
};

type Settings = {
  activeId: string;
  projects: Project[];
};

function makeDefaultSettings(): Settings {
  const id = crypto.randomUUID();
  // In dev: usa __dirname/workspace (cartella nel repo).
  // In bundled (.app): __dirname punta a Contents/Resources/resources/, che
  // è read-only. Cadiamo su ~/Documents/SubLodeX-workspace, che è writable
  // e facile da trovare per l'utente. SUBLODEX_DATA_DIR set ⇒ siamo bundlati.
  const workspacePath = process.env.SUBLODEX_DATA_DIR
    ? path.join(os.homedir(), 'Documents', 'SubLodeX-workspace')
    : path.resolve(__dirname, 'workspace');
  return {
    activeId: id,
    projects: [{
      id,
      name: 'workspace',
      path: workspacePath,
      instructions: '',
    }],
  };
}

function activeProject(s: Settings): Project {
  return s.projects.find((p) => p.id === s.activeId) ?? s.projects[0];
}

/** Filename leggibile per la conversation di un progetto:
 *  `<slug-del-nome>.<shortId>.json`. Lo shortId garantisce unicità anche
 *  se più progetti condividono il nome. Migriamo file vecchi (solo UUID)
 *  rinominandoli al volo se troviamo lo stesso projectId. */
/** Parser minimale di ~/.ssh/config: estrae gli alias `Host xxx` (esclusi
 *  i pattern con * o ?). Non riconosce Include/Match — sufficiente per il
 *  99% dei casi normali. */
function parseSshConfig(text: string): { name: string }[] {
  const out: { name: string }[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^Host\s+(.+)$/i);
    if (!m) continue;
    for (const h of m[1].split(/\s+/)) {
      if (!h || h.includes('*') || h.includes('?')) continue;
      if (seen.has(h)) continue;
      seen.add(h);
      out.push({ name: h });
    }
  }
  return out;
}

function slugify(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'project';
}
/** Validazione projectId: gli ID sono generati internamente via
 *  `crypto.randomUUID()` (formato UUID v4) o sono stringhe ASCII
 *  semplici. Restringere a `[A-Za-z0-9_-]{1,64}` evita path traversal
 *  in `sessionsDir` e file. */
function isValidProjectId(id: string): boolean {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

/** Sanitizza un projectId per uso in path. Stessa whitelist di
 *  `sessionFilePath`: tutto ciò che non è in [A-Za-z0-9_-] diventa `_`,
 *  troncato a 64 chars. Difesa in profondità anche se il chiamante
 *  ha già validato. */
function safeProjectId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || '_';
}

/** Directory delle conversazioni per un progetto: una sotto-cartella
 *  dedicata. Ogni session è un file `<sessionId>.json`. */
function sessionsDir(projectId: string): string {
  return path.join(DATA_DIR, 'conversations', safeProjectId(projectId));
}

/** Path al file della singola sessione. */
function sessionFilePath(projectId: string, sessionId: string): string {
  // sessionId pulito: solo a-z A-Z 0-9 _ - .
  const safe = sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64);
  return path.join(sessionsDir(projectId), `${safe}.json`);
}

/** Migrazione lazy: se trovo file in formato vecchio
 *  (`conversations/<slug>.<shortId>.json`) per questo progetto, li sposto
 *  dentro `conversations/<projectId>/legacy.json`. Idempotente. */
async function migrateLegacyConversation(projectId: string): Promise<void> {
  const dir = path.join(DATA_DIR, 'conversations');
  const project = settings.projects.find((p) => p.id === projectId);
  if (!project) return;
  const shortId = projectId.slice(0, 8);
  const candidates = [
    path.join(dir, `${slugify(project.name)}.${shortId}.json`),
    path.join(dir, `${projectId}.json`),
    path.join(dir, `${shortId}.json`),
  ];
  for (const old of candidates) {
    try {
      await access(old);
      await mkdir(sessionsDir(projectId), { recursive: true });
      const target = sessionFilePath(projectId, 'legacy');
      try { await access(target); } catch {
        // target non esiste, copia
        await Bun.write(target, await Bun.file(old).text());
      }
      await rm(old).catch(() => {});
    } catch { /* niente */ }
  }
}

/** Lista delle session per un progetto. Per ognuna estrae meta utili
 *  (counter messaggi, prima riga, mtime) senza leggere tutto in memoria. */
async function listSessions(projectId: string): Promise<Array<{
  id: string;
  name?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  summary: string;
}>> {
  await migrateLegacyConversation(projectId);
  const dir = sessionsDir(projectId);
  let entries: Array<{ name: string }>;
  try { entries = await readdir(dir, { withFileTypes: true }) as any; }
  catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.name.endsWith('.json')) continue;
    if (e.name === '_meta.json') continue;
    const id = e.name.slice(0, -5);
    try {
      const fp = path.join(dir, e.name);
      const st = await stat(fp);
      const raw = await readFile(fp, 'utf8');
      const data = JSON.parse(raw);
      const messages = Array.isArray(data.messages) ? data.messages : [];
      const messageCount = messages.length;
      const name = typeof data.name === 'string' && data.name.trim() ? data.name : undefined;
      // summary: primo blocco text del primo messaggio user, se c'è
      let summary = '';
      for (const m of messages) {
        if (m?.role !== 'user') continue;
        for (const b of (m.blocks ?? [])) {
          if (b?.kind === 'text' && typeof b.text === 'string') {
            summary = b.text.replace(/\s+/g, ' ').slice(0, 80);
            break;
          }
        }
        if (summary) break;
      }
      out.push({
        id,
        name,
        createdAt: st.birthtimeMs ?? st.mtimeMs,
        updatedAt: st.mtimeMs,
        messageCount,
        summary,
      });
    } catch { /* skippo file corrotti */ }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

async function createNewSession(projectId: string): Promise<string> {
  await mkdir(sessionsDir(projectId), { recursive: true });
  const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const fp = sessionFilePath(projectId, id);
  // file vuoto coerente con ConversationSnapshot
  await writeFile(fp, JSON.stringify({ messages: [], sessionId: null }, null, 2));
  return id;
}

/** Risolve "quale session caricare". Se sessionId esplicito → quella.
 *  Altrimenti la più recente; se non c'è nessuna → ne crea una nuova. */
async function resolveSessionId(projectId: string, sessionId?: string | null): Promise<string> {
  if (sessionId) return sessionId;
  const sessions = await listSessions(projectId);
  if (sessions.length > 0) return sessions[0].id;
  return await createNewSession(projectId);
}

async function loadSettings(): Promise<Settings> {
  try {
    const raw = await readFile(SETTINGS_FILE, 'utf8');
    const data = JSON.parse(raw);

    // migrazione dal vecchio formato { projectName, projectPath, instructions, recentPaths }
    if ('projectName' in data && !('projects' in data)) {
      const id = crypto.randomUUID();
      const initial: Project = {
        id,
        name: data.projectName ?? 'workspace',
        path: data.projectPath ?? path.resolve(__dirname, 'workspace'),
        instructions: data.instructions ?? '',
      };
      const others: Project[] = ((data.recentPaths ?? []) as string[])
        .filter((p) => p && p !== initial.path)
        .map((p) => ({
          id: crypto.randomUUID(),
          name: path.basename(p) || 'progetto',
          path: p,
          instructions: '',
        }));
      const migrated: Settings = { activeId: id, projects: [initial, ...others] };
      await persistSettings(migrated);
      return migrated;
    }

    if (data && Array.isArray(data.projects) && typeof data.activeId === 'string') {
      return data as Settings;
    }

    // dato corrotto: ricomincia
    const def = makeDefaultSettings();
    await persistSettings(def);
    return def;
  } catch {
    const def = makeDefaultSettings();
    await mkdir(def.projects[0].path, { recursive: true });
    await persistSettings(def);
    return def;
  }
}

async function persistSettings(s: Settings): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

/* ---------- redact: niente password SSH nei response API ----------
 *
 * Sentinel scambiata col frontend: se la UI riceve `password: SENTINEL`
 * sa che c'è una password salvata ma non la mostra; quando salva senza
 * modificarla, rimanda il sentinel — il backend lo riconosce e tiene la
 * password originale dal disk. Sentinel scelto = stringa improbabile
 * come vera password (UUID-like).
 *
 * Senza questo, GET /api/health e /api/settings ritornavano la password
 * SSH in chiaro nel JSON (e la UI la teneva in zustand persisted →
 * disco, log, browser DevTools network tab). */
const PWD_REDACT_SENTINEL = '__SUBLODEX_PWD_KEEP__';

function redactProject(p: Project): Project {
  if (!p.remote?.password) return p;
  return { ...p, remote: { ...p.remote, password: PWD_REDACT_SENTINEL } };
}

function redactSettings(s: Settings): Settings {
  return { ...s, projects: s.projects.map(redactProject) };
}

/** Riapplica le password originali sui progetti che hanno il sentinel.
 *  Match per id col `current` (settings in memoria). Se l'id non matcha
 *  o l'incoming non ha sentinel, lascia com'è — niente surprise:
 *  - sentinel + match → password preservata (utente non l'ha cambiata)
 *  - stringa diversa → la nuova password vince
 *  - undefined/empty → rimossa (utente ha svuotato il campo) */
function unredactSettings(incoming: Settings, current: Settings): Settings {
  const byId = new Map(current.projects.map((p) => [p.id, p]));
  return {
    ...incoming,
    projects: incoming.projects.map((p) => {
      if (p.remote?.password !== PWD_REDACT_SENTINEL) return p;
      const existing = byId.get(p.id);
      const realPwd = existing?.remote?.password;
      if (!realPwd) {
        // sentinel ma non c'è password esistente → rimuovi il campo
        const { password: _omit, ...rest } = p.remote;
        return { ...p, remote: rest };
      }
      return { ...p, remote: { ...p.remote, password: realPwd } };
    }),
  };
}

/* ---------- SSH helpers (per progetti remoti) ---------- */

// Pure utilities estratte in src-server/shell-utils.ts (Fase 3.1).
import {
  isSafeRef,
  isSafeStashRef,
  isSafeRelativePath,
  shellQuote,
  joinRemote,
  isSshFatalError,
} from './src-server/shell-utils';

// Helpers attachments (upload immagini composer).
import {
  ALLOWED_MIMES,
  MAX_BYTES,
  MAX_THUMB_BYTES,
  RETENTION_DAYS,
  PRUNE_INTERVAL_MS,
  buildAttachmentPaths,
  ensureSubLodeXGitignoreLocal,
  ensureSubLodeXGitignoreRemote,
  extFromMime,
  isAttachmentRel,
  mimeFromExt,
  pruneOriginalsLocal,
  pruneOriginalsRemote,
  readAttachmentRemote,
  resolveAttachmentAbs,
  writeAttachmentLocal,
  writeAttachmentRemote,
} from './src-server/attachments';

/** Risolve un path relativo al progetto (locale o remoto) confinandolo
 *  alla root del progetto. Rifiuta path assoluti e traversal con `..`.
 *  Ritorna `{ ok:true, abs }` o `{ ok:false, status, error }`.
 *
 *  Usata da GET/PUT/DELETE su /api/file. Il frontend (FileTree, Editor)
 *  passa SEMPRE path relativi alla root, quindi accettare path assoluti
 *  è un buco di traversal puro: non c'è caso d'uso legittimo. */
type PathResolution =
  | { ok: true; abs: string }
  | { ok: false; status: 400 | 403; error: string };

function resolveProjectPath(project: Project, rel: string): PathResolution {
  if (typeof rel !== 'string' || rel.length === 0) {
    return { ok: false, status: 400, error: 'invalid path: empty' };
  }
  if (rel.length > 4096) {
    return { ok: false, status: 400, error: 'invalid path: too long' };
  }
  // Niente NUL byte (vecchio trucco di bypass).
  if (rel.includes('\0')) {
    return { ok: false, status: 400, error: 'invalid path: null byte' };
  }
  // Niente path assoluti dal client. Mai. La root è quella del progetto.
  if (path.isAbsolute(rel) || rel.startsWith('/')) {
    return { ok: false, status: 400, error: 'invalid path: absolute path not allowed' };
  }

  const root = project.path;

  if (project.remote) {
    // Remoto: normalizza POSIX (separatori `/`), poi verifica containment.
    const normalized = path.posix.normalize(rel);
    // Dopo normalize i `..` residui in testa indicano traversal sopra root.
    if (normalized === '..' || normalized.startsWith('../') || normalized === '.' && rel === '..') {
      return { ok: false, status: 403, error: 'forbidden: path outside project' };
    }
    if (normalized.split('/').some((seg) => seg === '..')) {
      return { ok: false, status: 403, error: 'forbidden: path traversal' };
    }
    // Normalizziamo il risultato del join per eliminare `/.` o `//`
    // ridondanti. Senza questa normalize, `path=.` produrrebbe `<root>/.`
    // che startsWith `<root>/` ma non è === root → la difesa esterna sul
    // DELETE non scatta e il rm remoto fallisce con 500 invece di 403.
    const abs = path.posix.normalize(joinRemote(root, normalized));
    const rootWithSep = root.replace(/\/+$/, '') + '/';
    if (abs !== root && !abs.startsWith(rootWithSep)) {
      return { ok: false, status: 403, error: 'forbidden: path outside project' };
    }
    return { ok: true, abs };
  }

  // Locale: path.resolve risolve `..` e `.`, poi confiniamo a root.
  const abs = path.resolve(root, rel);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    return { ok: false, status: 403, error: 'forbidden: path outside project' };
  }
  return { ok: true, abs };
}

/** Costruisce gli argomenti del comando ssh dato un RemoteConfig.
 *  Restituisce { argv, env } pronto per Bun.spawn. Aggiunge sshpass se serve.
 *
 *  Sicurezza: con `remote.password` set, NON usiamo `sshpass -p <pwd>` perché
 *  la password finirebbe in `argv` e quindi visibile in `ps aux`. Usiamo
 *  invece `sshpass -e` che legge la password dalla env var `SSHPASS`. */
type SshSpawn = { argv: string[]; env?: Record<string, string> };

function buildSshCommand(remote: RemoteConfig, opts: { tty?: boolean; remoteShell: string }): SshSpawn {
  const sshFlags: string[] = [];
  if (opts.tty) sshFlags.push('-tt');
  if (remote.port && remote.port !== 22) sshFlags.push('-p', String(remote.port));
  if (remote.identityFile) sshFlags.push('-i', remote.identityFile);
  if (remote.agentForwarding) sshFlags.push('-A');
  if (!remote.password) sshFlags.push('-o', 'BatchMode=yes');
  sshFlags.push('-o', 'StrictHostKeyChecking=accept-new');
  // ControlMaster: riuso TCP per richieste successive → ~10ms invece di ~300ms
  sshFlags.push(...SSH_CM_FLAGS);

  const target = remote.user ? `${remote.user}@${remote.host}` : remote.host;
  // Passiamo il comando come UN SOLO arg dopo l'host. Se passassimo
  // ['--', 'sh', '-c', cmd] come argv separati, ssh li joina con spazi
  // PRIMA di inviarli al remote → le quote interne si rompono.
  // ssh lancia comunque la shell remota dell'utente per eseguire la stringa.
  const sshArgs = [...sshFlags, target, opts.remoteShell];

  if (remote.password) {
    // sshpass -e legge la password da $SSHPASS, NON da argv.
    // Usiamo path assoluto se trovato in PATH/Homebrew; altrimenti
    // speriamo che PATH lo trovi (e se non lo trova, l'errore è chiaro).
    return {
      argv: [SSHPASS_BIN ?? 'sshpass', '-e', 'ssh', ...sshArgs],
      env: { ...process.env, SSHPASS: remote.password } as Record<string, string>,
    };
  }
  return { argv: ['ssh', ...sshArgs] };
}

/** Esegue un comando one-shot sul remote host via SSH. Timeout di default 15s. */
async function sshExec(
  remote: RemoteConfig,
  remoteCmd: string,
  stdin?: string,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  const { argv, env } = buildSshCommand(remote, { remoteShell: remoteCmd });
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { stdio: ['pipe', 'pipe', 'pipe'], env });
  } catch (err) {
    return { ok: false, stdout: '', stderr: `cannot spawn ssh: ${(err as Error).message}`, code: -1 };
  }
  if (stdin !== undefined) {
    try {
      await (proc.stdin as any).write?.(stdin);
      await (proc.stdin as any).end?.();
    } catch { /* */ }
  } else {
    // niente stdin → chiudilo subito così il remote sh non aspetta
    try { await (proc.stdin as any).end?.(); } catch { /* */ }
  }
  const killTimer = setTimeout(() => { try { proc.kill(); } catch { /* */ } }, timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    clearTimeout(killTimer);
    return { ok: code === 0, stdout, stderr, code };
  } catch (err) {
    clearTimeout(killTimer);
    return { ok: false, stdout: '', stderr: `ssh exec error: ${(err as Error).message}`, code: -2 };
  }
}

async function writeClaudeMdFor(project: Project): Promise<void> {
  if (!project.path) return;
  const target = project.path.endsWith('/') ? project.path + 'CLAUDE.md' : project.path + '/CLAUDE.md';

  let existing = '';
  if (project.remote) {
    const r = await sshExec(project.remote, `cat -- ${shellQuote(target)} 2>/dev/null || true`);
    existing = r.stdout;
  } else {
    try { existing = await readFile(target, 'utf8'); } catch { /* nuovo */ }
  }

  const lines = [
    CLAUDE_MD_START,
    `# ${project.name}`,
    '',
    `Project root: \`${project.path}\`${project.remote ? ` (remote: ${project.remote.user ? project.remote.user + '@' : ''}${project.remote.host})` : ''}`,
    `When the user refers to "this project" or asks to read/write files, work inside this directory.`,
  ];
  if (project.instructions.trim()) {
    lines.push('', project.instructions.trim());
  }
  lines.push(CLAUDE_MD_END);
  const block = lines.join('\n');

  let next: string;
  if (existing.includes(CLAUDE_MD_START) && existing.includes(CLAUDE_MD_END)) {
    next = existing.replace(
      new RegExp(`${CLAUDE_MD_START}[\\s\\S]*?${CLAUDE_MD_END}`),
      block,
    );
  } else if (existing.trim()) {
    next = existing.trimEnd() + '\n\n' + block + '\n';
  } else {
    next = block + '\n';
  }

  if (project.remote) {
    await sshExec(
      project.remote,
      `mkdir -p ${shellQuote(project.path)} && cat > ${shellQuote(target)}`,
      next,
    );
  } else {
    await mkdir(project.path, { recursive: true });
    await writeFile(target, next, 'utf8');
  }
}

function validateSettings(s: Settings): string | null {
  if (!Array.isArray(s.projects) || s.projects.length === 0) return 'at least one project required';
  if (!s.activeId || !s.projects.some((p) => p.id === s.activeId)) return 'invalid activeId';
  for (const p of s.projects) {
    if (!p.id) return 'project without id';
    if (!p.name?.trim()) return `project "${p.name}" has no name`;
    if (!p.path?.trim()) return `project "${p.name}" has no path`;
  }
  const ids = new Set<string>();
  for (const p of s.projects) {
    if (ids.has(p.id)) return 'duplicate id';
    ids.add(p.id);
  }
  return null;
}

let settings = await loadSettings();

/* ---------- diagnostics ---------- */

type Diagnostics = {
  claudeVersion: string | null;
  claudePath: string | null;
  authMethod: 'subscription' | 'api-key' | 'unknown';
  authDetail: string;
  subscriptionType?: string;   // pro / max / team se leggibile
  hasCredentialsFile: boolean;
  hasApiKeyEnv: boolean;
  apiKeySource?: string;
  defaultModel?: string;
  homeClaudeDir: string;
  helperConfigured: boolean;
  warnings: string[];
};

async function detectKeychainCredentials(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  // claude code recente memorizza il token nel Keychain di macOS
  // sotto un service tipo "Claude Code-credentials" (varia tra versioni).
  // Provo varie etichette comuni; un exit 0 = trovato.
  const candidates = ['Claude Code-credentials', 'Claude Code', 'claude-code'];
  for (const svc of candidates) {
    try {
      await runShort('security', ['find-generic-password', '-s', svc]);
      return true;
    } catch { /* try next */ }
  }
  return false;
}

async function getDiagnostics(): Promise<Diagnostics> {
  const home = os.homedir();
  const claudeDir = path.join(home, '.claude');
  const credPath = path.join(claudeDir, '.credentials.json');
  const settingsPath = path.join(claudeDir, 'settings.json');

  const out: Diagnostics = {
    claudeVersion: null,
    claudePath: null,
    authMethod: 'unknown',
    authDetail: '',
    hasCredentialsFile: false,
    hasApiKeyEnv: !!process.env.ANTHROPIC_API_KEY,
    homeClaudeDir: claudeDir,
    helperConfigured: false,
    warnings: [],
  };

  try { out.claudeVersion = (await runShort('claude', ['--version'])).trim(); } catch { /* not in PATH */ }
  try { out.claudePath = (await runShort('which', ['claude'])).trim() || null; } catch { /* noop */ }

  // file credenziali (vecchio formato)
  try {
    const raw = await readFile(credPath, 'utf8');
    out.hasCredentialsFile = true;
    try {
      const j = JSON.parse(raw);
      const oauth = j.claudeAiOauth ?? j.oauth ?? j;
      const subType = oauth?.subscriptionType ?? oauth?.tier ?? oauth?.plan;
      if (typeof subType === 'string') out.subscriptionType = subType;
    } catch { /* parse error, ma il file c'è */ }
  } catch { /* no */ }

  // Keychain di macOS (formato recente)
  const inKeychain = !out.hasCredentialsFile && (await detectKeychainCredentials());

  // settings globali
  try {
    const raw = await readFile(settingsPath, 'utf8');
    const cfg = JSON.parse(raw);
    if (typeof cfg?.model === 'string') out.defaultModel = cfg.model;
    if (cfg?.apiKeyHelper) out.helperConfigured = true;
    if (cfg?.env?.ANTHROPIC_API_KEY) {
      out.hasApiKeyEnv = true;
      out.apiKeySource = '~/.claude/settings.json (env.ANTHROPIC_API_KEY)';
    }
  } catch { /* no settings */ }
  if (out.hasApiKeyEnv && !out.apiKeySource) {
    out.apiKeySource = 'shell env (ANTHROPIC_API_KEY)';
  }

  const isLoggedIn = out.hasCredentialsFile || inKeychain;

  if (USE_API_KEY) {
    if (out.hasApiKeyEnv) {
      out.authMethod = 'api-key';
      out.authDetail = `pay-per-use via ANTHROPIC_API_KEY (${out.apiKeySource}) — opt-in CLAUDE_WEB_USE_API_KEY=1`;
    } else if (out.helperConfigured) {
      out.authMethod = 'api-key';
      out.authDetail = 'apiKeyHelper from ~/.claude/settings.json';
    } else {
      out.warnings.push('CLAUDE_WEB_USE_API_KEY=1 set but no ANTHROPIC_API_KEY found');
      out.authDetail = 'misconfigured: no API key available';
    }
    if (isLoggedIn) {
      out.warnings.push('subscription credentials found but ignored (USE_API_KEY=1)');
    }
  } else {
    if (isLoggedIn) {
      out.authMethod = 'subscription';
      const tier = out.subscriptionType ? out.subscriptionType.toUpperCase() : 'Pro/Max';
      const where = out.hasCredentialsFile ? '~/.claude/.credentials.json' : 'macOS Keychain';
      out.authDetail = `logged in via claude.ai (${tier}) — token in ${where}`;
      if (out.hasApiKeyEnv) {
        out.warnings.push(
          `ANTHROPIC_API_KEY is in env but ignored — set CLAUDE_WEB_USE_API_KEY=1 to use it instead`,
        );
      }
    } else {
      out.authMethod = 'unknown';
      out.authDetail = 'not logged in — run /login (or `claude /login` in a terminal)';
      if (out.hasApiKeyEnv) {
        out.warnings.push(
          `ANTHROPIC_API_KEY is in env but ignored by default — set CLAUDE_WEB_USE_API_KEY=1 to use it`,
        );
      }
    }
  }

  return out;
}

function runShort(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    proc.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `exit ${code}`));
    });
    proc.on('error', reject);
  });
}

/* ---------- oauth + plan usage ---------- */

const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_API_MESSAGES = 'https://api.anthropic.com/v1/messages';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const ANTHROPIC_VERSION = '2023-06-01';

type OAuthCreds = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;     // unix ms
  subscriptionType?: string;
  source: 'file' | 'keychain';
};

async function readCredentialsFile(): Promise<OAuthCreds | null> {
  const p = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    const raw = await readFile(p, 'utf8');
    const j = JSON.parse(raw);
    const oauth = j.claudeAiOauth ?? j.oauth ?? j;
    if (!oauth?.accessToken) return null;
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt: oauth.expiresAt,
      subscriptionType: oauth.subscriptionType,
      source: 'file',
    };
  } catch { return null; }
}

async function readKeychain(): Promise<OAuthCreds | null> {
  if (process.platform !== 'darwin') return null;
  const candidates = ['Claude Code-credentials', 'Claude Code', 'claude-code'];
  for (const svc of candidates) {
    try {
      const raw = (await runShort('security', ['find-generic-password', '-w', '-s', svc])).trim();
      if (!raw) continue;
      // il valore può essere JSON o solo il token grezzo
      let parsed: any = null;
      try { parsed = JSON.parse(raw); } catch { /* not json */ }
      if (parsed && typeof parsed === 'object') {
        const oauth = parsed.claudeAiOauth ?? parsed.oauth ?? parsed;
        if (oauth?.accessToken) {
          return {
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken,
            expiresAt: oauth.expiresAt,
            subscriptionType: oauth.subscriptionType,
            source: 'keychain',
          };
        }
      } else {
        // token grezzo (vecchi formati)
        return { accessToken: raw, source: 'keychain' };
      }
    } catch { /* try next service */ }
  }
  return null;
}

async function persistRefreshedToken(creds: OAuthCreds): Promise<void> {
  // se la fonte era il file, riscrivilo. Per il keychain non tocchiamo:
  // claude lo aggiornerà al prossimo uso; il refresh funziona comunque.
  if (creds.source !== 'file') return;
  const p = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    const raw = await readFile(p, 'utf8');
    const j = JSON.parse(raw);
    const target = j.claudeAiOauth ?? j.oauth ?? j;
    target.accessToken = creds.accessToken;
    if (creds.refreshToken) target.refreshToken = creds.refreshToken;
    if (creds.expiresAt) target.expiresAt = creds.expiresAt;
    await writeFile(p, JSON.stringify(j, null, 2), 'utf8');
  } catch { /* best effort */ }
}

async function refreshIfNeeded(creds: OAuthCreds): Promise<OAuthCreds> {
  if (!creds.expiresAt) return creds; // sconosciuto: prova come sta
  if (creds.expiresAt > Date.now() + 60_000) return creds; // ok per altri 60s
  if (!creds.refreshToken) return creds;

  const r = await fetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      scope: 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
    }),
  });
  if (!r.ok) {
    throw new Error(`oauth refresh failed: ${r.status} ${await r.text()}`);
  }
  const j: any = await r.json();
  const next: OAuthCreds = {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? creds.refreshToken,
    expiresAt: typeof j.expires_in === 'number' ? Date.now() + j.expires_in * 1000 : creds.expiresAt,
    subscriptionType: creds.subscriptionType,
    source: creds.source,
  };
  await persistRefreshedToken(next);
  return next;
}

type WindowUsage = { utilization: number; resetsAt: number };
type PlanUsage = {
  status: string;
  rateLimitType?: string;
  fallbackAvailable: boolean;
  windows: Record<string, WindowUsage>;     // 5h, 7d, 5h_opus, 7d_opus, 7d_sonnet, ecc.
  overage?: { status: string; resetsAt?: number; disabledReason?: string };
  subscriptionType?: string;
  rawHeaders: Record<string, string>;       // tutto quello che inizia con anthropic-ratelimit-
  fetchedAt: number;
  // Campi best-effort arricchiti da fetchClaudeAiExtras() (endpoint privati,
  // possono mancare). Tipi forward-declared, le definizioni sono sotto.
  billing?: Billing;
  weeklyBreakdown?: { name: string; utilization: number; resetsAt?: number }[];
  dailyRoutines?: { used: number; total: number };
  debug?: { url: string; status: number; ok: boolean; sample?: string }[];
};

/** Cache in-memory di /api/usage per ridurre round-trip a api.claude.ai.
 *  TTL breve (60s): la quota cambia di rado, ma vogliamo che un nuovo
 *  login/cambio piano si rifletta abbastanza in fretta.
 *  In caso di errore, NON cachiamo: ritentiamo subito al prossimo GET. */
const USAGE_CACHE_TTL_MS = 60_000;
let _usageCache: { value: PlanUsage; at: number } | null = null;
async function getUsageCached(): Promise<PlanUsage> {
  const now = Date.now();
  if (_usageCache && (now - _usageCache.at) < USAGE_CACHE_TTL_MS) {
    return _usageCache.value;
  }
  const v = await fetchPlanUsage();
  _usageCache = { value: v, at: now };
  return v;
}

async function fetchPlanUsage(): Promise<PlanUsage> {
  let creds = (await readCredentialsFile()) ?? (await readKeychain());
  if (!creds) throw new Error('not logged in (no OAuth credentials found)');
  creds = await refreshIfNeeded(creds);

  const r = await fetch(CLAUDE_API_MESSAGES, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${creds.accessToken}`,
      'anthropic-beta': OAUTH_BETA_HEADER,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'quota' }],
    }),
  });

  const h = r.headers;
  const get = (k: string) => h.get(k) ?? undefined;

  // raccogli tutti gli header di rate-limiting: ci sono varianti per modello
  // (5h_opus, 7d_opus, 7d_sonnet, ecc.) — non sempre tutte presenti.
  const rawHeaders: Record<string, string> = {};
  h.forEach((value, key) => {
    if (key.toLowerCase().startsWith('anthropic-ratelimit-')) {
      rawHeaders[key.toLowerCase()] = value;
    }
  });

  // estrai utilization+reset per ogni "window" (es. 5h, 7d, 5h_opus, 7d_sonnet)
  const windows: Record<string, WindowUsage> = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    const m = k.match(/^anthropic-ratelimit-unified-([a-z0-9_]+)-utilization$/);
    if (!m) continue;
    const win = m[1];
    const reset = rawHeaders[`anthropic-ratelimit-unified-${win}-reset`];
    if (!reset) continue;
    windows[win] = { utilization: Number(v), resetsAt: Number(reset) };
  }

  const usage: PlanUsage = {
    status: get('anthropic-ratelimit-unified-status') ?? 'unknown',
    rateLimitType: get('anthropic-ratelimit-unified-representative-claim'),
    fallbackAvailable: get('anthropic-ratelimit-unified-fallback') === 'available',
    windows,
    subscriptionType: creds.subscriptionType,
    rawHeaders,
    fetchedAt: Date.now(),
  };

  const overageStatus = get('anthropic-ratelimit-unified-overage-status');
  if (overageStatus) {
    const overageReset = get('anthropic-ratelimit-unified-overage-reset');
    usage.overage = {
      status: overageStatus,
      resetsAt: overageReset ? Number(overageReset) : undefined,
      disabledReason: get('anthropic-ratelimit-unified-overage-disabled-reason'),
    };
  }

  if (Object.keys(windows).length === 0 && !r.ok) {
    throw new Error(`API ${r.status}: ${await r.text()}`);
  }

  // Best-effort: prova endpoint privati di claude.ai per arricchire i dati.
  // Tutto quello che è non-rate-limit-headers è speculativo e undocumented.
  try {
    const extra = await fetchClaudeAiExtras(creds.accessToken);
    if (extra.billing) usage.billing = extra.billing;
    if (extra.weeklyBreakdown) usage.weeklyBreakdown = extra.weeklyBreakdown;
    if (extra.dailyRoutines) usage.dailyRoutines = extra.dailyRoutines;
    if (extra.debug) usage.debug = extra.debug;
  } catch { /* swallow */ }

  return usage;
}

type Billing = {
  currency?: string;
  spent?: number;
  monthlyCap?: number;
  balance?: number;
  autoRecharge?: boolean;
  resetsAt?: number;
  raw?: any;
};

type ClaudeAIExtras = {
  billing?: Billing;
  weeklyBreakdown?: { name: string; utilization: number; resetsAt?: number }[];
  dailyRoutines?: { used: number; total: number };
  debug?: { url: string; status: number; ok: boolean; sample?: string }[];
};

const CANDIDATE_URLS = [
  'https://api.claude.ai/api/bootstrap/v1',
  'https://claude.ai/api/bootstrap/v1',
  'https://api.claude.ai/api/account',
  'https://api.claude.ai/api/account/billing',
  'https://api.claude.ai/api/account/usage',
  'https://api.claude.ai/api/account/limits',
  'https://api.claude.ai/api/account/extra-usage',
  'https://api.claude.ai/api/organizations',
  'https://api.claude.ai/api/users/me',
  'https://api.claude.ai/api/oauth/profile',
  'https://api.claude.ai/api/usage/limits',
  'https://api.claude.ai/api/usage/breakdown',
  'https://claude.ai/api/account/usage',
  'https://claude.ai/api/account/billing',
  'https://claude.ai/api/users/me',
];

async function fetchClaudeAiExtras(accessToken: string): Promise<ClaudeAIExtras> {
  const out: ClaudeAIExtras = { debug: [] };
  let collectedJson: any[] = [];

  for (const url of CANDIDATE_URLS) {
    try {
      const res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
          'accept': 'application/json',
        },
      });
      const ct = res.headers.get('content-type') ?? '';
      const isJson = ct.includes('json');
      const text = isJson ? await res.text() : '';
      out.debug!.push({
        url,
        status: res.status,
        ok: res.ok,
        sample: text ? text.slice(0, 600) : undefined,
      });
      if (!res.ok || !isJson) continue;
      try {
        const j = JSON.parse(text);
        collectedJson.push({ url, body: j });
      } catch { /* malformed */ }
    } catch (err) {
      out.debug!.push({
        url,
        status: 0,
        ok: false,
        sample: (err as Error).message.slice(0, 200),
      });
    }
  }

  // estrai dati noti se possibile
  for (const { body } of collectedJson) {
    if (out.billing === undefined) {
      const b = pickBilling(body);
      if (b) out.billing = b;
    }
    if (out.weeklyBreakdown === undefined) {
      const wb = pickWeeklyBreakdown(body);
      if (wb) out.weeklyBreakdown = wb;
    }
    if (out.dailyRoutines === undefined) {
      const dr = pickDailyRoutines(body);
      if (dr) out.dailyRoutines = dr;
    }
  }

  return out;
}

function dig(obj: unknown, keys: string[]): unknown {
  return keys.reduce<unknown>(
    (cur, k) => (cur && typeof cur === 'object') ? (cur as any)[k] : undefined,
    obj,
  );
}

function pickBilling(j: any): Billing | undefined {
  const candidates = [
    j?.billing,
    j?.account?.billing,
    j?.account?.extraUsage,
    j?.extraUsage,
    j?.overage,
    j,
  ];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const spent = (c as any).spent ?? (c as any).amountSpent ?? (c as any).usage_spent;
    const cap = (c as any).monthlyCap ?? (c as any).monthly_limit ?? (c as any).cap;
    const bal = (c as any).balance ?? (c as any).remainingCredit ?? (c as any).credit;
    if (typeof spent === 'number' || typeof cap === 'number' || typeof bal === 'number') {
      return {
        spent: typeof spent === 'number' ? spent : undefined,
        monthlyCap: typeof cap === 'number' ? cap : undefined,
        balance: typeof bal === 'number' ? bal : undefined,
        currency: (c as any).currency ?? 'USD',
        autoRecharge: !!((c as any).autoRecharge ?? (c as any).auto_recharge),
      };
    }
  }
  return undefined;
}

function pickWeeklyBreakdown(j: any): { name: string; utilization: number; resetsAt?: number }[] | undefined {
  const arr = j?.usage?.weekly ?? j?.weeklyLimits ?? j?.limits?.weekly ?? j?.breakdown?.weekly;
  if (!Array.isArray(arr)) return undefined;
  const out = arr
    .map((it: any) => ({
      name: it.name ?? it.label ?? it.scope ?? 'unknown',
      utilization: typeof it.utilization === 'number' ? it.utilization
        : typeof it.percent === 'number' ? it.percent / 100
        : 0,
      resetsAt: typeof it.resetsAt === 'number' ? it.resetsAt
        : typeof it.resets_at === 'number' ? it.resets_at
        : undefined,
    }))
    .filter((x: any) => x.name);
  return out.length ? out : undefined;
}

function pickDailyRoutines(j: any): { used: number; total: number } | undefined {
  const r = j?.routines ?? j?.dailyRoutines ?? j?.features?.routines;
  if (!r || typeof r !== 'object') return undefined;
  const used = (r as any).used ?? (r as any).consumed ?? 0;
  const total = (r as any).total ?? (r as any).limit ?? (r as any).included;
  if (typeof total === 'number') return { used: Number(used) || 0, total };
  return undefined;
}

function safeResolveInActive(rel: string): string | null {
  const root = activeProject(settings).path;
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep) && abs !== root) return null;
  return abs;
}

/* ---------- claude ---------- */

type ServerMsg =
  | { type: 'event'; event: unknown }
  | { type: 'done' }
  | { type: 'error'; error: string };

type ClientAttachment = {
  id: string;
  originalPath: string;
  mime: string;
};

type ClientMsg =
  | { type: 'send'; prompt: string; sessionId?: string; model?: string; permissionMode?: string; attachments?: ClientAttachment[] }
  | { type: 'cancel' };

type WsData = {
  id: string;
  kind: 'ai';
  /** AbortController della query corrente */
  activeAbort?: AbortController;
};

function buildClaudeEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  // Default: usiamo la subscription (Pro/Max). Per usare la API key bisogna
  // avviare il server con CLAUDE_WEB_USE_API_KEY=1, opt-in esplicito.
  // Le credenziali OAuth possono stare in ~/.claude/.credentials.json o nel
  // Keychain di macOS — claude le trova da solo se l'API key non è in env.
  if (!USE_API_KEY) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}

async function buildMultimodalPrompt(
  text: string,
  attachments: ClientAttachment[],
  projectPath: string,
): Promise<AsyncIterable<import('@anthropic-ai/claude-agent-sdk').SDKUserMessage>> {
  type ContentBlockParam = import('@anthropic-ai/sdk/resources/messages/messages').ContentBlockParam;
  const content: ContentBlockParam[] = [];

  for (const att of attachments) {
    const filePath = path.join(projectPath, att.originalPath);
    const data = await readFile(filePath);
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: att.mime as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        data: data.toString('base64'),
      },
    });
  }

  if (text.length > 0) {
    content.push({ type: 'text', text });
  }

  async function* gen() {
    yield {
      type: 'user' as const,
      message: { role: 'user' as const, content },
      parent_tool_use_id: null,
    };
  }
  return gen();
}

async function runClaude(
  prompt: string,
  sessionId: string | undefined,
  model: string | undefined,
  permissionMode: string | undefined,
  send: (m: ServerMsg) => void,
  registerAbort: (ac: AbortController) => void,
  attachments?: ClientAttachment[],
): Promise<void> {
  const project = activeProject(settings);
  const ac = new AbortController();
  registerAbort(ac);

  // ─── REMOTE: claude gira sul server SSH via subprocess ssh ───
  if (project.remote) {
    await runClaudeRemote(project, prompt, sessionId, model, permissionMode, send, ac);
    return;
  }

  // ─── LOCAL: claude-agent-sdk in-process ───
  const opts: Parameters<typeof query>[0]['options'] = {
    cwd: project.path,
    permissionMode: (permissionMode || PERMISSION_MODE) as
      'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
    abortController: ac,
    includePartialMessages: true,
    env: buildClaudeEnv(),
  };
  if (model) opts.model = model;
  if (sessionId) opts.resume = sessionId;
  if (process.env.SUBLODEX_CLAUDE_BIN) {
    (opts as unknown as Record<string, unknown>).pathToClaudeCodeExecutable =
      process.env.SUBLODEX_CLAUDE_BIN;
  }

  const hasImages = attachments && attachments.length > 0;
  const promptInput: Parameters<typeof query>[0]['prompt'] = hasImages
    ? await buildMultimodalPrompt(prompt, attachments, project.path)
    : prompt;

  try {
    log.info('claude', 'starting', {
      prompt: prompt.slice(0, 80),
      cwd: project.path,
      images: hasImages ? attachments.length : 0,
    });
    for await (const msg of query({ prompt: promptInput, options: opts })) {
      send({ type: 'event', event: msg as unknown as Record<string, unknown> });
    }
    log.info('claude', 'done');
  } catch (err) {
    if (ac.signal.aborted) {
      log.info('claude', 'aborted by user');
    } else {
      const errMsg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
      log.error('claude', 'fatal', { err: errMsg });
      send({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  send({ type: 'done' });
}

/** Esegue claude sul server remoto via SSH. Stream-json arriva su stdout
 *  riga per riga, lo inoltriamo al WS come eventi.
 *  Note: senza --include-partial-messages (non è un flag CLI), gli `input_json_delta`
 *  per i tool non arrivano. Il file editor non avrà streaming live, ma tutto il
 *  resto (assistant text, tool_use complete, result) funziona. */
async function runClaudeRemote(
  project: Project, prompt: string, sessionId: string | undefined,
  model: string | undefined, permissionMode: string | undefined,
  send: (m: ServerMsg) => void, ac: AbortController,
): Promise<void> {
  const flags: string[] = [
    '-p', shellQuote(prompt),
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', permissionMode ? shellQuote(permissionMode) : PERMISSION_MODE,
  ];
  if (model) flags.push('--model', shellQuote(model));
  if (sessionId) flags.push('--resume', shellQuote(sessionId));

  const remoteCmd = `cd ${shellQuote(project.path)} && claude ${flags.join(' ')}`;
  const { argv, env } = buildSshCommand(project.remote!, { tty: true, remoteShell: remoteCmd });
  const proc = Bun.spawn(argv, { stdio: ['ignore', 'pipe', 'pipe'], env });

  ac.signal.addEventListener('abort', () => { try { proc.kill(); } catch { /* */ } });

  // Lo stream-json di claude esce per riga su stdout
  let buf = '';
  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let stderrBuf = '';
  // Limite buffer di assemblaggio: protegge da loop runaway che generassero
  // una singola "riga" enorme senza mai newline. Truncamento a 8MB con
  // best-effort: parsiamo quello che abbiamo e resettiamo per riprendere
  // senza far esplodere la memoria del bun server.
  const MAX_BUF_BYTES = 8 * 1024 * 1024;

  // Leggi stderr in parallelo per debug se la richiesta fallisce
  (async () => {
    const r = proc.stderr.getReader();
    while (true) {
      const { value, done } = await r.read();
      if (done) break;
      stderrBuf += dec.decode(value);
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
    }
  })();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      if (buf.length > MAX_BUF_BYTES) {
        // Drop preventivo del buffer: log e reset. Non killiamo il proc
        // (potrebbe stabilizzarsi), ma evitiamo accumulo illimitato.
        log.warn('claude:remote', 'stdout buffer exceeded without newline — truncating', { maxBytes: MAX_BUF_BYTES });
        buf = buf.slice(-1024); // tieni una coda minima per riallineare
      }
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const ev = JSON.parse(t);
          send({ type: 'event', event: ev });
        } catch {
          // riga non-JSON (es. messaggio diagnostico ssh)
        }
      }
    }
    // Flush finale: se l'ultima riga arriva senza '\n' rimane in buf.
    // Pre-fix: l'evento veniva perso silenziosamente.
    const tail = buf.trim();
    if (tail) {
      try {
        const ev = JSON.parse(tail);
        send({ type: 'event', event: ev });
      } catch {
        // tail non-JSON (es. trailing newline mancante su un diag SSH)
      }
      buf = '';
    }
  } catch (err) {
    if (!ac.signal.aborted) {
      send({ type: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  const code = await proc.exited;
  if (code !== 0 && !ac.signal.aborted && stderrBuf.trim()) {
    send({ type: 'error', error: `remote claude exited ${code}: ${stderrBuf.trim()}` });
  }
  send({ type: 'done' });
}

/* ---------- file tree ---------- */

type FileNode = { name: string; path: string; isDir: boolean; children?: FileNode[] };

async function listTree(rel: string, depth = 4): Promise<FileNode[]> {
  if (depth === 0) return [];
  const abs = safeResolveInActive(rel);
  if (!abs) return [];
  let entries;
  try { entries = await readdir(abs, { withFileTypes: true }); }
  catch { return []; }
  const out: FileNode[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '__pycache__') continue;
    const childRel = path.join(rel, e.name);
    if (e.isDirectory()) {
      out.push({ name: e.name, path: childRel, isDir: true, children: await listTree(childRel, depth - 1) });
    } else {
      out.push({ name: e.name, path: childRel, isDir: false });
    }
  }
  out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  return out;
}

/** Remote file tree: usa `find` sul host con max depth + esclusioni standard.
 *  Output one-path-per-line, lo trasformiamo nella stessa struttura nidificata
 *  del tree locale. */
async function listRemoteTree(remote: RemoteConfig, root: string): Promise<FileNode[]> {
  // -mindepth 1 esclude la cartella stessa ('.'). Usiamo "find ... -print" invece
  // di -prune poi -print per evitare che una cartella attesa non emetta nulla.
  const cmd = `cd ${shellQuote(root)} && find . -mindepth 1 -maxdepth 4 \\( -path './node_modules' -o -path './.git' -o -path './dist' -o -path './__pycache__' -o -name '.*' \\) -prune -o \\( -type f -o -type d \\) -print 2>/dev/null | head -2000`;
  const r = await sshExec(remote, cmd);
  // Non usiamo r.ok: sshpass può ritornare exit != 0 anche con stdout valido.
  // Ci basta avere righe utili.
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l && l !== '.');
  if (lines.length === 0) {
    // log diagnostico solo se davvero non c'è nulla
    if (r.stderr) log.warn('tree', 'empty remote tree', { root, stderr: r.stderr.slice(0, 300) });
    return [];
  }
  // Costruzione albero
  type N = FileNode & { _kids?: Map<string, N> };
  const rootNode: N = { name: '.', path: '.', isDir: true, _kids: new Map() };

  // ssh `find` non distingue dir vs file out-of-the-box senza opzioni: lo facciamo con `find -type d` separato
  // Per semplicità: tutto ciò che ha figli è dir, le foglie sono file.
  for (const raw of lines) {
    const rel = raw.startsWith('./') ? raw.slice(2) : raw;
    const parts = rel.split('/');
    let cur = rootNode;
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      acc = acc ? `${acc}/${seg}` : seg;
      const isLeaf = i === parts.length - 1;
      let child = cur._kids!.get(seg);
      if (!child) {
        child = { name: seg, path: acc, isDir: !isLeaf, _kids: new Map() };
        cur._kids!.set(seg, child);
      } else if (!isLeaf) {
        child.isDir = true;
      }
      cur = child;
    }
  }

  function materialize(n: N): FileNode {
    const kids = Array.from(n._kids?.values() ?? []).map(materialize);
    kids.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return { name: n.name, path: n.path, isDir: n.isDir, ...(n.isDir ? { children: kids } : {}) };
  }

  return Array.from(rootNode._kids!.values()).map(materialize)
    .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}

/* ---------- git helpers ---------- */

type GitFileStatus = {
  path: string;
  /** stato dell'index (HEAD vs staging): null se non staged */
  staged: 'A' | 'M' | 'D' | 'R' | 'U' | null;
  /** stato del workdir (staging vs disk): null se non modificato */
  workdir: 'M' | 'D' | 'U' | '?' | null;
};

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

/** Esegue un comando git nel progetto attivo, locale o remoto.
 *  Ritorna `{ ok, stdout, stderr }`. Niente shell escaping casereccio:
 *  per remote usiamo `cd <path> && git ...` quotato bene. */
async function runGit(
  project: Project,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  if (project.remote) {
    const cmd = `cd ${shellQuote(project.path)} && git ${args.map(shellQuote).join(' ')} 2>&1`;
    const r = await sshExec(project.remote, cmd);
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, code: r.code };
  }
  // locale
  const proc = Bun.spawn(['git', ...args], {
    cwd: project.path,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, stdout, stderr, code };
}

/** Parsa l'output di `git status --porcelain=v2 -b -z` in struttura tipata. */
function parseGitStatusV2(out: string): GitStatus {
  const lines = out.split('\0').filter((l) => l.length > 0);
  let branch = '';
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  const files: GitFileStatus[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim();
    } else if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line.startsWith('1 ')) {
      // Ordinary changed: "1 XY sub mH mI mW hH hI path"
      const parts = line.split(' ');
      const xy = parts[1] ?? '..';
      const filePath = parts.slice(8).join(' ');
      files.push({
        path: filePath,
        staged: parseStagedCode(xy[0]),
        workdir: parseWorkdirCode(xy[1]),
      });
    } else if (line.startsWith('2 ')) {
      // Renamed/Copied: "2 XY sub mH mI mW hH hI X<rename-score> path<sep>orig"
      const parts = line.split(' ');
      const xy = parts[1] ?? '..';
      // path is in parts.slice(9), then \t, then origPath. With -z separator
      // is \0 too — il path vero è la riga successiva. Skippiamo per semplicità
      // e mostriamo solo quello senza orig.
      const rest = parts.slice(9).join(' ');
      const filePath = rest.split('\t')[0] ?? rest;
      files.push({
        path: filePath,
        staged: parseStagedCode(xy[0]),
        workdir: parseWorkdirCode(xy[1]),
      });
      // Con -z il separatore della renamed è un \0 separato → skip next line
      // (non possiamo sapere se l'orig path è nella linea successiva senza
      // più context; lasciamo i due file come due entry distinte se appare).
    } else if (line.startsWith('? ')) {
      // Untracked: "? path"
      files.push({
        path: line.slice(2),
        staged: null,
        workdir: '?',
      });
    } else if (line.startsWith('! ')) {
      // Ignored — skip
    }
  }

  return { isGitRepo: true, branch, upstream, ahead, behind, files };
}

function parseStagedCode(c: string): GitFileStatus['staged'] {
  if (c === 'A' || c === 'M' || c === 'D' || c === 'R' || c === 'U') return c;
  return null;
}
function parseWorkdirCode(c: string): GitFileStatus['workdir'] {
  if (c === 'M' || c === 'D' || c === 'U' || c === '?') return c;
  return null;
}

async function readGitStatus(project: Project): Promise<GitStatus> {
  const r = await runGit(project, ['status', '--porcelain=v2', '--branch', '-z']);
  if (!r.ok) {
    // Non è un repo git, oppure git non è installato sul remote
    return { isGitRepo: false };
  }
  return parseGitStatusV2(r.stdout);
}

async function readGitDiff(project: Project, file: string, staged: boolean): Promise<string> {
  const args = ['diff'];
  if (staged) args.push('--cached');
  args.push('--', file);
  const r = await runGit(project, args);
  return r.ok ? r.stdout : `[git diff failed]\n${r.stderr}`;
}

/* ---------- claude code plugins / extensions ---------- */

type PluginInstall = {
  id: string;
  name: string;
  marketplace: string;
  scope: string;
  installPath: string;
  version?: string;
  installedAt?: string;
  lastUpdated?: string;
  gitCommitSha?: string;
  enabled: boolean;
  manifest?: Record<string, unknown> | null;
  /** sintesi delle capability dichiarate nel manifest */
  exposes: {
    commands: number;
    agents: number;
    skills: number;
    hooks: number;
    mcpServers: number;
    lspServers: number;
  };
  description?: string;
};

type Marketplace = {
  name: string;
  source: Record<string, unknown>;
  installLocation?: string;
  lastUpdated?: string;
};

type McpServer = {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string; // per remote MCP
  scope: 'user' | 'project';
};

type HookEntry = {
  event: string;
  matcher?: string;
  command: string;
  type?: string;
  scope: 'user' | 'project';
};

/** "Pacchetto estensione" non registrato come plugin Claude ma agganciato
 *  via hooks (es. claude-reforge installato come `npm i -g @ccplug/...`).
 *  Lo deduciamo dai path negli `hooks[].command`. */
type ExtensionPackage = {
  name: string;            // "@ccplug/claude-reforge" o "claude-reforge"
  packageRoot: string;     // path comune in node_modules
  hooks: Array<{ event: string; matcher?: string; scope: 'user' | 'project' }>;
  scope: 'user' | 'project' | 'mixed';
};

type PluginsState = {
  plugins: PluginInstall[];
  extensionPackages: ExtensionPackage[];
  marketplaces: Marketplace[];
  mcpServers: McpServer[];
  hooks: HookEntry[];
  /** globalmente abilitati per il progetto (dal merge user+project settings) */
  enabledMap: Record<string, boolean>;
  paths: {
    claudeHome: string;
    installedPluginsFile: string;
    knownMarketplacesFile: string;
    userSettingsFile: string;
    projectMcpFile: string;
    projectSettingsFile: string;
  };
};

async function readJsonSafe<T>(p: string): Promise<T | null> {
  try {
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw) as T;
  } catch { return null; }
}

function countCommands(m: any): number {
  if (!m) return 0;
  const c = m.commands;
  if (Array.isArray(c)) return c.length;
  if (c && typeof c === 'object') return Object.keys(c).length;
  return 0;
}
function countList(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  if (v && typeof v === 'object') return Object.keys(v as object).length;
  if (typeof v === 'string') return 1;
  return 0;
}

async function readPluginsState(project: Project): Promise<PluginsState> {
  const claudeHome = path.join(os.homedir(), '.claude');
  const installedPluginsFile = path.join(claudeHome, 'plugins', 'installed_plugins.json');
  const knownMarketplacesFile = path.join(claudeHome, 'plugins', 'known_marketplaces.json');
  const userSettingsFile = path.join(claudeHome, 'settings.json');
  const projectMcpFile = path.join(project.path, '.mcp.json');
  const projectSettingsFile = path.join(project.path, '.claude', 'settings.json');

  const installed = await readJsonSafe<{
    version: number;
    plugins: Record<string, Array<{
      scope: string;
      installPath: string;
      version?: string;
      installedAt?: string;
      lastUpdated?: string;
      gitCommitSha?: string;
      projectPath?: string;
    }>>;
  }>(installedPluginsFile);

  const knownMarketplaces = await readJsonSafe<Record<string, {
    source: Record<string, unknown>;
    installLocation?: string;
    lastUpdated?: string;
  }>>(knownMarketplacesFile);

  const userSettings = await readJsonSafe<any>(userSettingsFile);
  const projectMcp = await readJsonSafe<any>(projectMcpFile);
  const projectSettings = await readJsonSafe<any>(projectSettingsFile);

  // Plugin entries
  const plugins: PluginInstall[] = [];
  const enabledMap: Record<string, boolean> = {
    ...(userSettings?.enabledPlugins ?? {}),
    ...(projectSettings?.enabledPlugins ?? {}),
  };

  if (installed?.plugins) {
    for (const [pluginId, installs] of Object.entries(installed.plugins)) {
      for (const inst of installs) {
        const [name, marketplace] = pluginId.split('@', 2);
        const manifestPath = path.join(inst.installPath, '.claude-plugin', 'plugin.json');
        const manifest = await readJsonSafe<any>(manifestPath);
        plugins.push({
          id: pluginId,
          name: name || pluginId,
          marketplace: marketplace || '(local)',
          scope: inst.scope,
          installPath: inst.installPath,
          version: inst.version,
          installedAt: inst.installedAt,
          lastUpdated: inst.lastUpdated,
          gitCommitSha: inst.gitCommitSha,
          enabled: enabledMap[pluginId] === true,
          manifest,
          description: typeof manifest?.description === 'string' ? manifest.description : undefined,
          exposes: {
            commands: countCommands(manifest),
            agents: countList(manifest?.agents),
            skills: countList(manifest?.skills),
            hooks: manifest?.hooks ? Object.keys(manifest.hooks).length : 0,
            mcpServers: manifest?.mcpServers ? Object.keys(manifest.mcpServers).length : 0,
            lspServers: manifest?.lspServers ? Object.keys(manifest.lspServers).length : 0,
          },
        });
      }
    }
  }
  // Sort: enabled first, then by name
  plugins.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // Marketplaces
  const marketplaces: Marketplace[] = knownMarketplaces
    ? Object.entries(knownMarketplaces).map(([name, m]) => ({
        name,
        source: m.source ?? {},
        installLocation: m.installLocation,
        lastUpdated: m.lastUpdated,
      }))
    : [];

  // MCP servers — flatten user + project
  const mcpServers: McpServer[] = [];
  for (const [name, cfg] of Object.entries((userSettings?.mcpServers ?? {}) as Record<string, any>)) {
    mcpServers.push({
      name, scope: 'user',
      command: cfg?.command, args: cfg?.args, env: cfg?.env, url: cfg?.url,
    });
  }
  for (const [name, cfg] of Object.entries((projectMcp?.mcpServers ?? {}) as Record<string, any>)) {
    mcpServers.push({
      name, scope: 'project',
      command: cfg?.command, args: cfg?.args, env: cfg?.env, url: cfg?.url,
    });
  }

  // Hooks — user + project
  const hooks: HookEntry[] = [];
  const collectHooks = (src: 'user' | 'project', cfg: any) => {
    const h = cfg?.hooks;
    if (!h || typeof h !== 'object') return;
    for (const [event, arr] of Object.entries(h)) {
      if (!Array.isArray(arr)) continue;
      for (const group of arr) {
        const matcher = (group as any)?.matcher;
        const inner = (group as any)?.hooks;
        if (Array.isArray(inner)) {
          for (const hk of inner) {
            if (hk?.command) {
              hooks.push({
                event,
                matcher: matcher || undefined,
                command: hk.command,
                type: hk.type,
                scope: src,
              });
            }
          }
        }
      }
    }
  };
  collectHooks('user', userSettings);
  collectHooks('project', projectSettings);

  // Inferenza "extension packages": ricava pacchetti npm dagli hook command
  // che eseguono `node /path/to/node_modules/<pkg>/...`. Cattura anche
  // pacchetti scoped (`@scope/name`) e .npm/_npx (npx run on-demand).
  const pkgMap = new Map<string, ExtensionPackage>();
  // regex: matcha node_modules/<scope-pkg-or-pkg>/<rest>
  const nmRe = /node_modules\/(@[^\s/'"]+\/[^\s/'"]+|[^\s/'"@.][^\s/'"]+)\//;
  // regex per `~/.claude/plugins/<marketplace>/<pkg>/<version>/...`
  const cacheRe = /\.claude\/plugins\/cache\/[^/]+\/([^/]+)\/[^/]+\//;
  for (const h of hooks) {
    const cmd = h.command;
    let m = nmRe.exec(cmd);
    let pkgName: string | null = null;
    let pkgRoot: string | null = null;
    if (m) {
      pkgName = m[1];
      const idx = cmd.indexOf(`node_modules/${pkgName}/`);
      pkgRoot = cmd.slice(0, idx + `node_modules/${pkgName}`.length).replace(/^.*?(\/.*)/, '$1');
    } else {
      m = cacheRe.exec(cmd);
      if (m) {
        pkgName = m[1];
        const idx = cmd.indexOf(`/cache/`);
        pkgRoot = cmd.slice(idx);
      }
    }
    if (!pkgName) continue;
    const key = pkgName;
    if (!pkgMap.has(key)) {
      pkgMap.set(key, {
        name: pkgName,
        packageRoot: pkgRoot ?? '',
        hooks: [],
        scope: h.scope,
      });
    }
    const ep = pkgMap.get(key)!;
    ep.hooks.push({ event: h.event, matcher: h.matcher, scope: h.scope });
    if (ep.scope !== h.scope) ep.scope = 'mixed';
  }
  const extensionPackages = [...pkgMap.values()]
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    plugins,
    extensionPackages,
    marketplaces,
    mcpServers,
    hooks,
    enabledMap,
    paths: {
      claudeHome,
      installedPluginsFile,
      knownMarketplacesFile,
      userSettingsFile,
      projectMcpFile,
      projectSettingsFile,
    },
  };
}

/* ---------- server ---------- */

// Auth + CSP + HTML token injection: spostato in src-server/auth.ts (Fase 3.1).
import {
  AUTH_ENABLED,
  AUTH_TOKEN,
  tokenFromRequest,
  timingSafeEqualStr,
  htmlHeaders,
  injectAuthToken,
} from './src-server/auth';

const server = Bun.serve<WsData, {}>({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req, server) {
    const url = new URL(req.url);

    // ----- Auth gate -----
    // Solo le rotte API e WS sono protette. Le statiche servono l'HTML che
    // contiene il token, e gli asset (JS/CSS/img). Niente token = niente
    // chiamate API, quindi non c'è leak.
    if (AUTH_ENABLED) {
      const isApi = url.pathname.startsWith('/api/');
      const isWs = url.pathname === '/ws';
      if (isApi || isWs) {
        const t = tokenFromRequest(req, url);
        if (!t || !timingSafeEqualStr(t, AUTH_TOKEN!)) {
          return new Response('unauthorized', { status: 401 });
        }
      }
    }

    if (url.pathname === '/ws') {
      const ok = server.upgrade(req, {
        data: { id: crypto.randomUUID(), kind: 'ai' } satisfies WsData,
      });
      return ok ? undefined : new Response('upgrade failed', { status: 400 });
    }

    // (Il route `/pty` WebSocket è stato rimosso: il PTY ora è gestito
    // nativamente dal lato Rust via portable-pty. Il bun server non spawna
    // più subprocess Node per il terminale.)

    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, settings: redactSettings(settings) });
    }

    if (url.pathname === '/api/diagnostics' && req.method === 'GET') {
      return Response.json(await getDiagnostics());
    }

    if (url.pathname === '/api/usage' && req.method === 'GET') {
      // Cache TTL 60s: la quota Claude non cambia ogni secondo, e la
      // UsageCard sul frontend è polled di frequente. Riduciamo il
      // round-trip verso api.claude.ai e i timeout occasionali.
      try {
        const u = await getUsageCached();
        return Response.json(u);
      } catch (err) {
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }

    if (url.pathname === '/api/login' && req.method === 'POST') {
      // spawn `claude /login`: il binario apre il browser per OAuth.
      // Restituiamo stdout/stderr al client appena il processo termina.
      // Forziamo l'env senza API key, sennò claude non capisce che vogliamo loggarci.
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      // Timeout: se l'utente non completa il flow OAuth, killiamo il processo
      // dopo 5 minuti per evitare zombie process. Configurabile via env var.
      const LOGIN_TIMEOUT_MS = Number(process.env.SUBLODEX_LOGIN_TIMEOUT_MS) || 5 * 60_000;
      return new Promise<Response>((resolve) => {
        const proc = spawn('claude', ['/login'], { stdio: ['ignore', 'pipe', 'pipe'], env });
        let out = '';
        let err = '';
        let resolved = false;
        const settle = (resp: Response): void => {
          if (resolved) return;
          resolved = true;
          clearTimeout(killTimer);
          resolve(resp);
        };
        const killTimer = setTimeout(() => {
          try { proc.kill('SIGTERM'); } catch { /* */ }
          // Grace period prima di SIGKILL.
          setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* */ } }, 3_000);
          settle(Response.json({
            ok: false,
            timedOut: true,
            error: `login timed out after ${Math.round(LOGIN_TIMEOUT_MS / 1000)}s`,
            stdout: out.trim(),
            stderr: err.trim(),
          }, { status: 504 }));
        }, LOGIN_TIMEOUT_MS);
        proc.stdout.on('data', (c: Buffer) => { out += c.toString(); });
        proc.stderr.on('data', (c: Buffer) => { err += c.toString(); });
        proc.on('close', (code) => {
          settle(Response.json({
            ok: code === 0,
            code,
            stdout: out.trim(),
            stderr: err.trim(),
          }));
        });
        proc.on('error', (e) => {
          settle(Response.json({ ok: false, error: e.message }, { status: 500 }));
        });
      });
    }

    if (url.pathname === '/api/logout' && req.method === 'POST') {
      const env = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      return new Promise<Response>((resolve) => {
        const proc = spawn('claude', ['/logout'], { stdio: ['ignore', 'pipe', 'pipe'], env });
        let out = '', err = '';
        proc.stdout.on('data', (c: Buffer) => { out += c.toString(); });
        proc.stderr.on('data', (c: Buffer) => { err += c.toString(); });
        proc.on('close', (code) => {
          resolve(Response.json({ ok: code === 0, code, stdout: out.trim(), stderr: err.trim() }));
        });
        proc.on('error', (e) => resolve(Response.json({ ok: false, error: e.message }, { status: 500 })));
      });
    }

    if (url.pathname === '/api/settings' && req.method === 'GET') {
      return Response.json(redactSettings(settings));
    }

    if (url.pathname === '/api/settings' && req.method === 'PUT') {
      const body = (await req.json()) as Partial<Settings>;
      // Costruisci il candidate, poi unredact: ogni progetto incoming con
      // `remote.password === SENTINEL` ripristina la password originale dal
      // settings in memoria (match per id). L'utente vede asterischi in UI;
      // se non li tocca, la password rimane invariata.
      const candidate: Settings = {
        activeId: body.activeId ?? settings.activeId,
        projects: (body.projects ?? settings.projects).map((p) => {
          // Migrazione retrocompatibile: vecchio `remoteHost` → `remote.host`
          const legacy = (p as any).remoteHost as string | undefined;
          let remote = p.remote;
          if (!remote && legacy && legacy.trim()) {
            remote = { host: legacy.trim() };
          }
          if (remote && remote.host && remote.host.trim()) {
            remote = {
              host: remote.host.trim(),
              ...(remote.port ? { port: Number(remote.port) || 22 } : {}),
              ...(remote.user?.trim() ? { user: remote.user.trim() } : {}),
              ...(remote.password ? { password: remote.password } : {}),
              ...(remote.identityFile?.trim() ? { identityFile: remote.identityFile.trim() } : {}),
              ...(remote.remoteUrl?.trim() ? { remoteUrl: remote.remoteUrl.trim() } : {}),
              ...(remote.shellType ? { shellType: remote.shellType } : {}),
              ...(remote.agentForwarding ? { agentForwarding: true } : {}),
            };
          } else {
            remote = undefined;
          }
          return {
            id: p.id ?? crypto.randomUUID(),
            name: (p.name ?? '').trim() || 'progetto',
            path: p.path ? (remote ? p.path.trim() : path.resolve(p.path)) : '',
            instructions: typeof p.instructions === 'string' ? p.instructions : '',
            ...(remote ? { remote } : {}),
          };
        }),
      };
      // Riapplica le password reali dove arriva il sentinel (= utente non ha
      // toccato il campo password in UI). Va fatto PRIMA della validazione
      // per non far cadere progetti con sentinel (che non è una password vera).
      const merged = unredactSettings(candidate, settings);
      const err = validateSettings(merged);
      if (err) return new Response(err, { status: 400 });

      // crea le cartelle dei progetti LOCALI che non esistono. Per i remoti
      // non possiamo (e non vogliamo) toccare il filesystem remoto qui.
      for (const p of merged.projects) {
        if (p.remote) continue;
        try { await mkdir(p.path, { recursive: true }); }
        catch (e) { return new Response(`mkdir ${p.path}: ${(e as Error).message}`, { status: 400 }); }
        try {
          const st = await stat(p.path);
          if (!st.isDirectory()) return new Response(`${p.path} is not a directory`, { status: 400 });
        } catch (e) {
          return new Response(`stat ${p.path}: ${(e as Error).message}`, { status: 400 });
        }
      }

      settings = merged;
      await persistSettings(settings);
      // CLAUDE.md è scritto in background: per progetti remoti l'SSH può
      // essere lento e bloccherebbe la response. Errori vengono solo loggati.
      for (const p of settings.projects) {
        void writeClaudeMdFor(p).catch((err) => {
          log.warn('settings', 'CLAUDE.md write failed', { project: p.name, err: String(err) });
        });
      }
      return Response.json(redactSettings(settings));
    }

    if (url.pathname === '/api/test-ssh' && req.method === 'POST') {
      let remote: RemoteConfig;
      try { remote = (await req.json()) as RemoteConfig; }
      catch { return Response.json({ ok: false, error: 'invalid json body' }, { status: 400 }); }
      if (!remote?.host || !remote.host.trim()) {
        return Response.json({ ok: false, error: 'host is required' });
      }
      // Probe distintive: prefissi univoci su ogni riga così posso recuperarle
      // anche se MOTD / banner / sshpass mangiano roba. Cerco ovunque (stdout+stderr).
      const probe = `echo "__SX_HOST__$(hostname)"; echo "__SX_OS__$(uname -s)"; if command -v claude >/dev/null 2>&1; then echo "__SX_CLAUDE__yes"; else echo "__SX_CLAUDE__no"; fi`;
      const r = await sshExec(remote, probe, undefined, 10_000);

      const all = r.stdout + '\n' + r.stderr;
      const grab = (re: RegExp) => {
        const m = all.match(re);
        return m ? m[1].trim().replace(/\r$/, '') : null;
      };
      const hostname = grab(/__SX_HOST__([^\r\n]*)/);
      const os = grab(/__SX_OS__([^\r\n]*)/);
      const claude = grab(/__SX_CLAUDE__(yes|no)/);

      if (hostname || os || claude) {
        return Response.json({
          ok: true,
          hostname: hostname ?? '',
          os: os ?? '',
          claudeInstalled: claude === 'yes',
        });
      }
      // Niente marker → vera fail
      return Response.json({
        ok: false,
        code: r.code,
        error: (r.stderr || r.stdout || `ssh exited ${r.code} with no output`).trim().slice(0, 800),
        raw: { stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 400) },
      });
    }

    if (url.pathname === '/api/ssh-hosts' && req.method === 'GET') {
      const cfgPath = path.join(os.homedir(), '.ssh', 'config');
      try {
        const raw = await readFile(cfgPath, 'utf8');
        const hosts = parseSshConfig(raw);
        return Response.json({ hosts });
      } catch {
        return Response.json({ hosts: [] });
      }
    }

    if (url.pathname === '/api/pick-folder' && req.method === 'POST') {
      let cmd: string;
      let args: string[];
      if (process.platform === 'darwin') {
        cmd = 'osascript';
        args = ['-e', 'POSIX path of (choose folder with prompt "Choose the project folder")'];
      } else if (process.platform === 'win32') {
        // PowerShell FolderBrowserDialog. STA mode is required for WinForms.
        // A topmost dummy form is parented to the dialog so it doesn't get
        // hidden behind the main app window.
        const ps = [
          "Add-Type -AssemblyName System.Windows.Forms;",
          "$f = New-Object System.Windows.Forms.FolderBrowserDialog;",
          "$f.Description = 'Choose the project folder';",
          "$f.ShowNewFolderButton = $true;",
          "$top = New-Object System.Windows.Forms.Form;",
          "$top.TopMost = $true;",
          "$r = $f.ShowDialog($top);",
          "$top.Dispose();",
          "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }",
        ].join(' ');
        cmd = 'powershell.exe';
        args = ['-NoProfile', '-STA', '-Command', ps];
      } else {
        // Linux / others: try zenity (GNOME) — falls through to error if missing.
        cmd = 'zenity';
        args = ['--file-selection', '--directory', '--title=Choose the project folder'];
      }
      return new Promise<Response>((resolve) => {
        const proc = spawn(cmd, args);
        let out = '';
        proc.stdout.on('data', (c: Buffer) => { out += c.toString(); });
        proc.on('close', (code) => {
          const picked = out.trim().replace(/[\/\\]$/, '');
          if (code === 0 && picked) {
            resolve(Response.json({ path: picked }));
          } else {
            resolve(Response.json({ canceled: true }));
          }
        });
        proc.on('error', (e) => {
          resolve(Response.json(
            { error: `folder picker failed: ${e.message}` },
            { status: 501 },
          ));
        });
      });
    }

    if (url.pathname === '/api/file' && req.method === 'GET') {
      const p = url.searchParams.get('path');
      if (!p) return new Response('missing path', { status: 400 });
      const project = activeProject(settings);
      const resolved = resolveProjectPath(project, p);
      if (!resolved.ok) return new Response(resolved.error, { status: resolved.status });
      const abs = resolved.abs;
      if (project.remote) {
        const r = await sshExec(project.remote, `cat -- ${shellQuote(abs)}`);
        // Non ci affidiamo a r.ok (sshpass exit code inaffidabile). Se stderr
        // contiene errori SSH veri (Permission denied, Connection refused, …)
        // allora è un fail; altrimenti restituiamo lo stdout così com'è.
        if (isSshFatalError(r.stderr)) {
          log.warn('file:GET', 'remote read failed', { abs, stderr: r.stderr });
          return new Response('', { status: 200 });
        }
        return new Response(r.stdout, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      try {
        const content = await readFile(abs, 'utf8');
        return new Response(content, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      } catch {
        return new Response('', { status: 200 });
      }
    }

    if (url.pathname === '/api/file' && req.method === 'PUT') {
      const p = url.searchParams.get('path');
      if (!p) return new Response('missing path', { status: 400 });
      const project = activeProject(settings);
      const resolved = resolveProjectPath(project, p);
      if (!resolved.ok) return new Response(resolved.error, { status: resolved.status });
      const abs = resolved.abs;
      const content = await req.text();
      if (project.remote) {
        const dir = abs.replace(/\/[^/]*$/, '') || '/';
        const r = await sshExec(
          project.remote,
          `mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(abs)} && echo OK_${'WRITE'}`,
          content,
        );
        // Verifico marker invece dell'exit code
        const ok = r.stdout.includes('OK_WRITE') && !isSshFatalError(r.stderr);
        return new Response(ok ? 'ok' : `remote write failed: ${r.stderr || r.stdout}`, { status: ok ? 200 : 500 });
      }
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
      return new Response('ok');
    }

    if (url.pathname === '/api/file' && req.method === 'DELETE') {
      const p = url.searchParams.get('path');
      if (!p) return new Response('missing path', { status: 400 });
      const project = activeProject(settings);
      const resolved = resolveProjectPath(project, p);
      if (!resolved.ok) return new Response(resolved.error, { status: resolved.status });
      const abs = resolved.abs;
      // Difesa in profondità: rifiuta una delete che combaci esattamente con
      // la root del progetto (resolveProjectPath la consente per coerenza con
      // listTree, ma `rm -rf` sulla root sarebbe disastroso).
      if (abs === project.path) {
        return new Response('forbidden: cannot delete project root', { status: 403 });
      }
      if (project.remote) {
        const r = await sshExec(project.remote, `rm -rf -- ${shellQuote(abs)} && echo OK_DEL`);
        const ok = r.stdout.includes('OK_DEL') && !isSshFatalError(r.stderr);
        return new Response(ok ? 'ok' : (r.stderr || 'remote delete failed'), { status: ok ? 200 : 500 });
      }
      try {
        await rm(abs, { recursive: true, force: true });
        return new Response('ok');
      } catch (err) {
        return new Response(`delete failed: ${(err as Error).message}`, { status: 500 });
      }
    }

    /* ---------- attachments: upload + serve ---------- */

    // Upload di una coppia (originale, thumbnail) come multipart/form-data.
    // Campi attesi: `original` (File), `thumb` (Blob webp), `width`, `height`.
    // Il client genera la thumbnail (512px lato lungo, webp q≈0.78) per non
    // dipendere da Sharp/native libs lato server (problematico in bundle Tauri).
    //
    // Il path passato a Claude resta SEMPRE l'originale; la UI userà la
    // thumbnail per il rendering in scrollback. Vedi src-server/attachments.ts
    // per dettagli sul layout filesystem (.sublodex/uploads vs .sublodex/thumbs).
    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const projectId = url.searchParams.get('projectId');
      if (!projectId) return new Response('missing projectId', { status: 400 });
      if (!isValidProjectId(projectId)) return new Response('invalid projectId', { status: 400 });

      // L'upload è SEMPRE per il progetto attivo. Sanity check: il projectId
      // passato dal client deve combaciare con l'attivo, altrimenti un client
      // potrebbe iniettare file in un progetto diverso da quello che pensa
      // l'utente. (Difesa in profondità — il content è già confinato al
      // .sublodex/ del progetto attivo lato server.)
      const project = activeProject(settings);
      if (project.id !== projectId) {
        return new Response('projectId mismatch with active project', { status: 409 });
      }

      let form: FormData;
      try {
        form = await req.formData();
      } catch (err) {
        return new Response(`invalid multipart: ${(err as Error).message}`, { status: 400 });
      }

      const original = form.get('original');
      const thumb = form.get('thumb');
      if (!(original instanceof File) || !(thumb instanceof Blob)) {
        return new Response('missing original or thumb', { status: 400 });
      }

      // Validazione mime + size sull'ORIGINALE.
      if (!ALLOWED_MIMES.has(original.type)) {
        return new Response(`unsupported mime: ${original.type}`, { status: 415 });
      }
      if (original.size > MAX_BYTES) {
        return new Response(`file too large: ${original.size} > ${MAX_BYTES}`, { status: 413 });
      }
      if (original.size === 0) {
        return new Response('empty file', { status: 400 });
      }
      // Validazione thumbnail: deve essere webp e sotto al cap (defense-in-depth
      // contro client che spacciano un file enorme per "thumb").
      if (thumb.type && thumb.type !== 'image/webp') {
        return new Response(`thumb must be image/webp, got ${thumb.type}`, { status: 415 });
      }
      if (thumb.size > MAX_THUMB_BYTES) {
        return new Response(`thumb too large: ${thumb.size}`, { status: 413 });
      }
      if (thumb.size === 0) {
        return new Response('empty thumb', { status: 400 });
      }

      const ext = extFromMime(original.type);
      if (!ext) return new Response('unsupported mime', { status: 415 });

      // Dimensioni dell'originale (per evitare CLS sul rendering UI).
      // Inviate dal client come stringhe; sanitizziamo.
      const widthStr = form.get('width');
      const heightStr = form.get('height');
      const width = typeof widthStr === 'string' ? Number.parseInt(widthStr, 10) : NaN;
      const height = typeof heightStr === 'string' ? Number.parseInt(heightStr, 10) : NaN;
      const safeWidth = Number.isFinite(width) && width > 0 && width < 100_000 ? width : undefined;
      const safeHeight = Number.isFinite(height) && height > 0 && height < 100_000 ? height : undefined;

      const filenameRaw = (original as File).name || '';
      // Sanitize filename: solo per display, non lo usiamo come path.
      const filename = filenameRaw.length > 0 && filenameRaw.length < 256 ? filenameRaw : undefined;

      const { id, originalRel, thumbnailRel } = buildAttachmentPaths(ext);

      const originalBytes = new Uint8Array(await original.arrayBuffer());
      const thumbBytes = new Uint8Array(await thumb.arrayBuffer());

      try {
        if (project.remote) {
          await ensureSubLodeXGitignoreRemote(project.remote, project.path, sshExec);
          await writeAttachmentRemote(
            project.remote, project.path,
            originalRel, thumbnailRel,
            originalBytes, thumbBytes,
            sshExec,
          );
        } else {
          await ensureSubLodeXGitignoreLocal(project.path);
          await writeAttachmentLocal(
            project.path,
            originalRel, thumbnailRel,
            originalBytes, thumbBytes,
          );
        }
      } catch (err) {
        log.error('upload', 'write failed', { err: (err as Error).message });
        return new Response(`write failed: ${(err as Error).message}`, { status: 500 });
      }

      log.info('upload', 'ok', {
        id, mime: original.type, size: original.size,
        remote: !!project.remote,
      });

      return Response.json({
        id,
        originalPath: originalRel,
        thumbnailPath: thumbnailRel,
        mime: original.type,
        size: original.size,
        width: safeWidth,
        height: safeHeight,
        filename,
      });
    }

    // Serve i bytes di una thumbnail (o di un originale ancora vivo) come
    // immagine binaria, per consumo via `<img src="/api/blob?...">`.
    //
    // Auth: il monkey-patch fetch del client passa il Bearer in header solo
    // su `window.fetch`. Le `<img>` usano una nuova request senza header, quindi
    // il client passa il token in query (`?token=...`) — già supportato da
    // tokenFromRequest. CSP `img-src 'self'` permette il same-origin.
    //
    // Allow-list: oltre a resolveProjectPath (che confina al project root),
    // consentiamo SOLO path sotto .sublodex/{uploads,thumbs}/ — non vogliamo
    // trasformare /api/blob in un file reader generico.
    if (url.pathname === '/api/blob' && req.method === 'GET') {
      const p = url.searchParams.get('path');
      if (!p) return new Response('missing path', { status: 400 });
      const project = activeProject(settings);
      if (!isAttachmentRel(p)) {
        return new Response('forbidden: not an attachment path', { status: 403 });
      }
      const resolved = resolveProjectPath(project, p);
      if (!resolved.ok) return new Response(resolved.error, { status: resolved.status });
      const abs = resolved.abs;
      const ext = (p.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? '').toLowerCase();
      const ct = mimeFromExt(ext);
      // I path sono uuid → contenuto immutabile. Cache aggressivo sicuro.
      const cacheHeaders: Record<string, string> = {
        'content-type': ct,
        'cache-control': 'public, max-age=31536000, immutable',
      };

      if (project.remote) {
        const bytes = await readAttachmentRemote(project.remote, abs, sshExec);
        if (!bytes) return new Response('not found', { status: 404 });
        // Estraiamo un ArrayBuffer "puro" (slice copia + scarta SharedArrayBuffer).
        // Necessario perché TS 5.5+ ha stretto i tipi su Uint8Array.buffer
        // (può essere ArrayBufferLike che include SharedArrayBuffer), e
        // Blob/BodyInit accettano solo ArrayBuffer puro. Copia O(N) trascurabile
        // su file ≤ 5 MB rispetto al round-trip ssh che li ha portati qui.
        const copy = bytes.slice().buffer as ArrayBuffer;
        return new Response(copy, { headers: cacheHeaders });
      }
      try {
        const f = Bun.file(abs);
        if (!(await f.exists())) return new Response('not found', { status: 404 });
        return new Response(f, { headers: cacheHeaders });
      } catch {
        return new Response('not found', { status: 404 });
      }
    }

    if (url.pathname === '/api/conversation/sessions' && req.method === 'GET') {
      const projectId = url.searchParams.get('projectId');
      if (!projectId) return new Response('missing projectId', { status: 400 });
      if (!isValidProjectId(projectId)) return new Response('invalid projectId', { status: 400 });
      const sessions = await listSessions(projectId);
      return Response.json({ sessions });
    }

    if (url.pathname === '/api/conversation/sessions/all' && req.method === 'GET') {
      // Lista sessioni per TUTTI i progetti noti dai settings.
      // Usato dal pannello sessioni per mostrare la cronologia globale
      // raggruppata per progetto. Ogni gruppo include name + sortKey
      // (max updatedAt session, o lastUsedAt project) per ordinare i gruppi.
      const groups: Array<{
        projectId: string;
        projectName: string;
        lastUsedAt: number;
        sortKey: number;
        sessions: Awaited<ReturnType<typeof listSessions>>;
      }> = [];
      for (const p of settings.projects) {
        if (!isValidProjectId(p.id)) continue;
        const sessions = await listSessions(p.id);
        const mostRecent = sessions.length > 0 ? sessions[0].updatedAt : 0;
        groups.push({
          projectId: p.id,
          projectName: p.name,
          lastUsedAt: p.lastUsedAt ?? 0,
          sortKey: Math.max(mostRecent, p.lastUsedAt ?? 0),
          sessions,
        });
      }
      groups.sort((a, b) => b.sortKey - a.sortKey);
      return Response.json({ groups });
    }

    if (url.pathname === '/api/conversation/sessions' && req.method === 'POST') {
      const projectId = url.searchParams.get('projectId');
      if (!projectId) return new Response('missing projectId', { status: 400 });
      if (!isValidProjectId(projectId)) return new Response('invalid projectId', { status: 400 });
      const id = await createNewSession(projectId);
      return Response.json({ id });
    }

    if (url.pathname === '/api/conversation' && req.method === 'GET') {
      const projectId = url.searchParams.get('projectId');
      if (!projectId) return new Response('missing projectId', { status: 400 });
      if (!isValidProjectId(projectId)) return new Response('invalid projectId', { status: 400 });
      const sid = await resolveSessionId(projectId, url.searchParams.get('sessionId'));
      const file = sessionFilePath(projectId, sid);
      try {
        const data = await readFile(file, 'utf8');
        // arricchisco con sessionFsId per il client (così sa quale ha caricato)
        const parsed = JSON.parse(data);
        parsed.__sessionFsId = sid;
        return Response.json(parsed);
      } catch {
        return Response.json({
          messages: [], sessionId: null,
          totalCost: 0, totalInput: 0, totalOutput: 0, turns: 0,
          __sessionFsId: sid,
        });
      }
    }

    if (url.pathname === '/api/conversation' && req.method === 'PUT') {
      const projectId = url.searchParams.get('projectId');
      if (!projectId) return new Response('missing projectId', { status: 400 });
      if (!isValidProjectId(projectId)) return new Response('invalid projectId', { status: 400 });
      const sid = await resolveSessionId(projectId, url.searchParams.get('sessionId'));
      const body = await req.text();
      const file = sessionFilePath(projectId, sid);
      await mkdir(path.dirname(file), { recursive: true });
      // Preserva il `name` user-editable se non è incluso nello snapshot:
      // ogni turno riscrive il file ma non ha motivo di toccare il nome.
      try {
        const incoming = JSON.parse(body);
        if (typeof incoming.name !== 'string') {
          try {
            const prev = JSON.parse(await readFile(file, 'utf8'));
            if (typeof prev.name === 'string') {
              incoming.name = prev.name;
              await writeFile(file, JSON.stringify(incoming, null, 2), 'utf8');
              return new Response('ok');
            }
          } catch { /* file mancante o corrotto: scrivo body così com'è */ }
        }
      } catch { /* body non-JSON: scrivo raw */ }
      await writeFile(file, body, 'utf8');
      return new Response('ok');
    }

    if (url.pathname === '/api/conversation/sessions' && req.method === 'PATCH') {
      const projectId = url.searchParams.get('projectId');
      const sessionId = url.searchParams.get('sessionId');
      if (!projectId || !sessionId) return new Response('missing params', { status: 400 });
      if (!isValidProjectId(projectId)) return new Response('invalid projectId', { status: 400 });
      let body: { name?: string };
      try { body = await req.json() as { name?: string }; }
      catch { return new Response('invalid json', { status: 400 }); }
      const file = sessionFilePath(projectId, sessionId);
      try {
        const raw = await readFile(file, 'utf8');
        const data = JSON.parse(raw);
        data.name = (body.name ?? '').trim() || undefined;
        await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
        return new Response('ok');
      } catch (e) {
        return new Response(`rename failed: ${(e as Error).message}`, { status: 500 });
      }
    }

    if (url.pathname === '/api/conversation' && req.method === 'DELETE') {
      const projectId = url.searchParams.get('projectId');
      if (!projectId) return new Response('missing projectId', { status: 400 });
      if (!isValidProjectId(projectId)) return new Response('invalid projectId', { status: 400 });
      const sidParam = url.searchParams.get('sessionId');
      if (sidParam) {
        const file = sessionFilePath(projectId, sidParam);
        try { await rm(file); } catch { /* */ }
        return new Response('ok');
      }
      // sessionId omesso → cancella TUTTE le session del progetto (compat
      // col vecchio comportamento di "wipe conversation").
      try { await rm(sessionsDir(projectId), { recursive: true, force: true }); } catch { /* */ }
      return new Response('ok');
    }

    if (url.pathname === '/api/tree' && req.method === 'GET') {
      const project = activeProject(settings);
      if (project.remote) {
        const tree = await listRemoteTree(project.remote, project.path);
        return Response.json({ root: project.path, tree });
      }
      const tree = await listTree('.', 4);
      return Response.json({ root: project.path, tree });
    }

    if (url.pathname === '/api/git/status' && req.method === 'GET') {
      const project = activeProject(settings);
      const status = await readGitStatus(project);
      return Response.json(status);
    }

    if (url.pathname === '/api/git/diff' && req.method === 'GET') {
      const project = activeProject(settings);
      const file = url.searchParams.get('path') ?? '';
      // file vuoto = diff dell'intero working tree (legittimo). Se valorizzato,
      // deve essere un path relativo dentro il progetto.
      if (file && !isSafeRelativePath(file)) {
        return new Response('invalid path', { status: 400 });
      }
      const staged = url.searchParams.get('staged') === '1';
      const diff = await readGitDiff(project, file, staged);
      return new Response(diff, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    if (url.pathname === '/api/git/generate-commit-msg' && req.method === 'POST') {
      const project = activeProject(settings);
      // Preferiamo lo staged diff se esiste; altrimenti usiamo il working tree
      // così l'utente può generare il messaggio PRIMA dello staging (per
      // capire cosa sta per committare).
      const stagedR = await runGit(project, ['diff', '--cached']);
      let diff = stagedR.ok ? stagedR.stdout : '';
      let usingStaged = !!diff.trim();
      if (!usingStaged) {
        const unstagedR = await runGit(project, ['diff']);
        diff = unstagedR.ok ? unstagedR.stdout : '';
        // Aggiungiamo anche i file untracked: il diff non li include ma vanno
        // menzionati per dare contesto al modello.
        const statusUntracked = await runGit(project, ['ls-files', '--others', '--exclude-standard']);
        if (statusUntracked.ok && statusUntracked.stdout.trim()) {
          diff += '\n\n--- UNTRACKED FILES (new files not yet staged) ---\n' + statusUntracked.stdout;
        }
      }
      if (!diff.trim()) {
        return Response.json({ error: 'no changes to summarize' }, { status: 400 });
      }
      const stagedDiff = diff;

      const statResult = await runGit(project,
        usingStaged ? ['diff', '--cached', '--stat'] : ['diff', '--stat']);
      const diffStat = statResult.ok ? statResult.stdout : '';

      const logResult = await runGit(project, ['log', '--oneline', '-10']);
      const recentLog = logResult.ok ? logResult.stdout : '';

      const maxDiff = 15000;
      const diffTruncated = stagedDiff.length > maxDiff
        ? stagedDiff.slice(0, maxDiff) + '\n\n[...diff truncated, see --stat above for full scope...]'
        : stagedDiff;

      const prompt = [
        'You are a commit message generator. Output ONLY the commit message, nothing else.',
        'No quotes, no explanation, no markdown, no preamble.',
        '',
        'Rules:',
        '- Use Conventional Commits: type(scope): description',
        '- Types: feat, fix, refactor, style, chore, docs, test, perf, ci, build',
        '- Scope is optional, use the most relevant module/area name',
        '- First line max 72 chars',
        '- If multiple significant changes, add a blank line then bullet points',
        '- Be specific about WHAT changed, not generic ("update files" is bad)',
        '- Analyze the actual code changes to understand the intent',
        '',
        '--- RECENT COMMITS (for style reference) ---',
        recentLog,
        '',
        '--- DIFF STAT (full overview of changed files) ---',
        diffStat,
        '',
        '--- STAGED DIFF (code changes) ---',
        diffTruncated,
      ].join('\n');

      try {
        let result = '';
        const opts: Parameters<typeof query>[0]['options'] = {
          cwd: project.path,
          permissionMode: 'plan' as const,
          abortController: new AbortController(),
          env: buildClaudeEnv(),
          maxTurns: 1,
        };
        for await (const msg of query({ prompt, options: opts })) {
          const ev = msg as unknown as Record<string, unknown>;
          if (ev.type === 'assistant' && typeof ev.message === 'object' && ev.message) {
            const content = (ev.message as { content?: unknown[] }).content;
            if (Array.isArray(content)) {
              for (const b of content) {
                if (typeof b === 'object' && b && (b as { type: string }).type === 'text') {
                  result += (b as { text: string }).text;
                }
              }
            }
          }
        }
        return Response.json({ message: result.trim() });
      } catch (err) {
        log.error('generate-commit-msg', 'failed', { err: String(err) });
        return Response.json(
          { error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }

    if (url.pathname === '/api/git/stage' && req.method === 'POST') {
      const project = activeProject(settings);
      const { path: file } = (await req.json().catch(() => ({}))) as { path?: string };
      if (!file || !isSafeRelativePath(file)) {
        return Response.json({ error: 'invalid path' }, { status: 400 });
      }
      const ok = await runGit(project, ['add', '--', file]);
      return Response.json(ok);
    }

    if (url.pathname === '/api/git/unstage' && req.method === 'POST') {
      const project = activeProject(settings);
      const { path: file } = (await req.json().catch(() => ({}))) as { path?: string };
      if (!file || !isSafeRelativePath(file)) {
        return Response.json({ error: 'invalid path' }, { status: 400 });
      }
      const ok = await runGit(project, ['reset', 'HEAD', '--', file]);
      return Response.json(ok);
    }

    if (url.pathname === '/api/git/commit' && req.method === 'POST') {
      const project = activeProject(settings);
      const { message } = (await req.json().catch(() => ({}))) as { message?: string };
      if (!message?.trim()) return Response.json({ error: 'message required' }, { status: 400 });
      const ok = await runGit(project, ['commit', '-m', message]);
      return Response.json(ok);
    }

    if (url.pathname === '/api/git/pull' && req.method === 'POST') {
      const project = activeProject(settings);
      const ok = await runGit(project, ['pull', '--ff-only']);
      return Response.json(ok);
    }

    if (url.pathname === '/api/git/push' && req.method === 'POST') {
      const project = activeProject(settings);
      const ok = await runGit(project, ['push']);
      return Response.json(ok);
    }

    if (url.pathname === '/api/git/log' && req.method === 'GET') {
      const project = activeProject(settings);
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 50)));
      // Tab come separatore: %an può contenere spazi ma non tab.
      const r = await runGit(project, [
        'log',
        '--pretty=format:%H%x09%h%x09%an%x09%ad%x09%s',
        '--date=short',
        `-n${limit}`,
      ]);
      if (!r.ok) return Response.json({ commits: [] });
      const commits = r.stdout
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => {
          const [hash, abbrev, author, date, ...rest] = l.split('\t');
          return { hash, abbrev, author, date, subject: rest.join('\t') };
        });
      return Response.json({ commits });
    }

    if (url.pathname === '/api/git/branches' && req.method === 'GET') {
      const project = activeProject(settings);
      // Output formato: "<refname>\t<sha>\t<upstream>\t<HEAD?>"
      const r = await runGit(project, [
        'for-each-ref',
        '--format=%(refname:short)%09%(objectname:short)%09%(upstream:short)%09%(HEAD)',
        'refs/heads/',
      ]);
      if (!r.ok) return Response.json({ branches: [], current: null });
      const branches = r.stdout
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => {
          const [name, sha, upstream, head] = l.split('\t');
          return {
            name,
            sha,
            upstream: upstream || undefined,
            current: head === '*',
          };
        });
      const current = branches.find((b) => b.current)?.name ?? null;
      return Response.json({ branches, current });
    }

    if (url.pathname === '/api/git/checkout' && req.method === 'POST') {
      const project = activeProject(settings);
      const { branch, create } = (await req.json().catch(() => ({}))) as { branch?: string; create?: boolean };
      if (!branch || !isSafeRef(branch)) {
        return Response.json({ error: 'invalid branch name' }, { status: 400 });
      }
      const args = create ? ['checkout', '-b', branch] : ['checkout', branch];
      const ok = await runGit(project, args);
      return Response.json(ok);
    }

    if (url.pathname === '/api/git/show' && req.method === 'GET') {
      const project = activeProject(settings);
      const hash = url.searchParams.get('hash') ?? '';
      if (!hash || !/^[0-9a-f]{4,40}$/i.test(hash)) {
        return new Response('invalid hash', { status: 400 });
      }
      const r = await runGit(project, ['show', '--patch', '--stat', hash]);
      const text = r.ok ? r.stdout : `[git show failed]\n${r.stderr}`;
      return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    if (url.pathname === '/api/git/diff-range' && req.method === 'GET') {
      const project = activeProject(settings);
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';
      // ref-name validation: solo caratteri "safe" per ref git, escludo
      // metacaratteri shell.
      if (!isSafeRef(from) || !isSafeRef(to)) {
        return new Response('invalid ref', { status: 400 });
      }
      const r = await runGit(project, ['diff', '--patch', '--stat', `${from}...${to}`]);
      const text = r.ok ? r.stdout : `[git diff-range failed]\n${r.stderr}`;
      return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    if (url.pathname === '/api/git/default-branch' && req.method === 'GET') {
      const project = activeProject(settings);
      // origin/HEAD non sempre è settato; provo, fallback a main, poi master.
      const r = await runGit(project, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      if (r.ok) {
        const name = r.stdout.trim().replace(/^origin\//, '');
        return Response.json({ branch: name });
      }
      // Fallback: cerca un ref locale comune
      for (const candidate of ['main', 'master']) {
        const c = await runGit(project, ['rev-parse', '--verify', candidate]);
        if (c.ok) return Response.json({ branch: candidate });
      }
      return Response.json({ branch: null });
    }

    if (url.pathname === '/api/git/fetch-pr' && req.method === 'POST') {
      const project = activeProject(settings);
      const { number } = (await req.json().catch(() => ({}))) as { number?: number | string };
      const num = typeof number === 'string' ? parseInt(number, 10) : number;
      if (!num || !Number.isFinite(num) || num <= 0) {
        return Response.json({ error: 'invalid PR number' }, { status: 400 });
      }
      const branchName = `pr-${num}`;
      // `+refs/pull/N/head:refs/heads/pr-N` — il `+` forza overwrite se la
      // ref locale esiste già (es. fetch ripetuto dopo update del PR remoto).
      const ok = await runGit(project, [
        'fetch', 'origin',
        `+refs/pull/${num}/head:refs/heads/${branchName}`,
      ]);
      return Response.json({ ...ok, branch: branchName });
    }

    if (url.pathname === '/api/git/stage-all' && req.method === 'POST') {
      const project = activeProject(settings);
      const ok = await runGit(project, ['add', '-A']);
      return Response.json(ok);
    }

    if (url.pathname === '/api/git/unstage-all' && req.method === 'POST') {
      const project = activeProject(settings);
      const ok = await runGit(project, ['reset', 'HEAD']);
      return Response.json(ok);
    }

    if (url.pathname === '/api/git/discard' && req.method === 'POST') {
      const project = activeProject(settings);
      const { path: file, untracked } = (await req.json().catch(() => ({}))) as { path?: string; untracked?: boolean };
      if (!file || !isSafeRelativePath(file)) {
        return Response.json({ error: 'invalid path' }, { status: 400 });
      }
      // Per file untracked: rimuoviamo proprio il file (git non sa cos'era).
      // Per tracked: checkout — torna alla versione di HEAD.
      const args = untracked ? ['clean', '-f', '--', file] : ['checkout', 'HEAD', '--', file];
      const ok = await runGit(project, args);
      return Response.json(ok);
    }

    if (url.pathname === '/api/git/stash/list' && req.method === 'GET') {
      const project = activeProject(settings);
      // Format: <ref>\t<branch?>\t<message>
      const r = await runGit(project, [
        'stash', 'list', '--pretty=format:%gd%x09%gs',
      ]);
      if (!r.ok) return Response.json({ stashes: [] });
      const stashes = r.stdout
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => {
          const [ref, ...rest] = l.split('\t');
          return { ref, message: rest.join('\t') };
        });
      return Response.json({ stashes });
    }

    if (url.pathname === '/api/git/stash/save' && req.method === 'POST') {
      const project = activeProject(settings);
      const { message } = (await req.json().catch(() => ({}))) as { message?: string };
      const args = ['stash', 'push'];
      if (message?.trim()) {
        args.push('-m', message.trim());
      }
      const ok = await runGit(project, args);
      return Response.json(ok);
    }

    if (url.pathname === '/api/git/stash/pop' && req.method === 'POST') {
      const project = activeProject(settings);
      const { ref } = (await req.json().catch(() => ({}))) as { ref?: string };
      if (!ref || !isSafeStashRef(ref)) {
        return Response.json({ error: 'invalid stash ref' }, { status: 400 });
      }
      const ok = await runGit(project, ['stash', 'pop', ref]);
      return Response.json(ok);
    }

    if (url.pathname === '/api/git/stash/drop' && req.method === 'POST') {
      const project = activeProject(settings);
      const { ref } = (await req.json().catch(() => ({}))) as { ref?: string };
      if (!ref || !isSafeStashRef(ref)) {
        return Response.json({ error: 'invalid stash ref' }, { status: 400 });
      }
      const ok = await runGit(project, ['stash', 'drop', ref]);
      return Response.json(ok);
    }

    if (url.pathname === '/api/plugins/list' && req.method === 'GET') {
      const project = activeProject(settings);
      const data = await readPluginsState(project);
      return Response.json(data);
    }

    // Static fallback: in production (no vite), serviamo dist/ buildato.
    // - In dev: `__dirname/dist/` (output di vite build)
    // - In .app: il dist sta come Tauri resource, path passato via env
    const distRoot = process.env.SUBLODEX_DIST_DIR
      ? path.resolve(process.env.SUBLODEX_DIST_DIR)
      : path.join(__dirname, 'dist');
    const distFile = path.join(distRoot, url.pathname === '/' ? 'index.html' : url.pathname);
    try {
      const f = Bun.file(distFile);
      if (await f.exists()) {
        // Per index.html iniettiamo il token come `window.__SUBLODEX_TOKEN__`.
        // È l'unico modo di consegnarlo al frontend prima del primo fetch
        // (il browser non passa header su navigation request).
        if (distFile.endsWith('.html')) {
          return new Response(injectAuthToken(await f.text()), {
            headers: htmlHeaders(),
          });
        }
        return new Response(f);
      }
      // SPA fallback: route lato React → index.html
      const indexHtml = Bun.file(path.join(distRoot, 'index.html'));
      if (await indexHtml.exists()) {
        return new Response(injectAuthToken(await indexHtml.text()), {
          headers: htmlHeaders(),
        });
      }
    } catch { /* dist non esiste */ }

    return new Response('not found', { status: 404 });
  },
  websocket: {
    async open(_ws) {
      // L'unico WS aperto qui è quello AI. Il PTY è ora nativo lato Tauri.
      // Niente da fare a `open` — ci sono i campi WsData già impostati.
    },

    async message(ws, raw) {
      const text = typeof raw === 'string' ? raw : raw.toString();

      // ---- AI websocket ----
      let msg: ClientMsg;
      try { msg = JSON.parse(text) as ClientMsg; }
      catch {
        ws.send(JSON.stringify({ type: 'error', error: 'invalid json' } satisfies ServerMsg));
        return;
      }
      if (msg.type === 'send') {
        try {
          await runClaude(
            msg.prompt,
            msg.sessionId,
            msg.model,
            msg.permissionMode,
            (m) => { try { ws.send(JSON.stringify(m)); } catch { /* closed */ } },
            (ac) => { ws.data.activeAbort = ac; },
            msg.attachments,
          );
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'error',
            error: err instanceof Error ? err.message : String(err),
          } satisfies ServerMsg));
        } finally {
          ws.data.activeAbort = undefined;
        }
        return;
      }
      if (msg.type === 'cancel') {
        ws.data.activeAbort?.abort();
        return;
      }
    },

    close(ws) {
      ws.data.activeAbort?.abort();
    },
  },
});

const ap = activeProject(settings);
log.info('boot', 'listening', { url: `http://${server.hostname}:${server.port}` });
log.info('boot', 'active project', { name: ap.name, path: ap.path });
log.info('boot', 'permission', { mode: PERMISSION_MODE });
{
  const diag = await getDiagnostics();
  log.info('boot', 'auth', { method: diag.authMethod, detail: diag.authDetail });
  for (const w of diag.warnings) log.warn('boot', w);
  if (USE_API_KEY) log.info('boot', 'CLAUDE_WEB_USE_API_KEY=1 (API key opt-in)');
}

/* ---------- attachments: cron pruning originali ----------
 * Cancellazione settimanale dei bucket year-month di .sublodex/uploads/
 * più vecchi di RETENTION_DAYS. Le thumbnail (.sublodex/thumbs/) non
 * vengono mai toccate — restano per il rendering dell'history anche
 * quando l'originale è stato pruned. Vedi Attachment in src/lib/types.ts.
 *
 * Schedule: primo giro a 30s dal boot (lasciare al server di stabilizzarsi),
 * poi ogni PRUNE_INTERVAL_MS. Su crash del server il prune semplicemente
 * scatta al boot successivo dopo 30s, niente persistenza necessaria. */
async function pruneAllProjects(): Promise<void> {
  for (const p of settings.projects) {
    try {
      let result: { deletedBuckets: number };
      if (p.remote) {
        result = await pruneOriginalsRemote(p.remote, p.path, RETENTION_DAYS, sshExec);
      } else {
        result = await pruneOriginalsLocal(p.path, RETENTION_DAYS);
      }
      if (result.deletedBuckets > 0) {
        log.info('prune', 'ok', {
          project: p.id, deletedBuckets: result.deletedBuckets,
        });
      }
    } catch (err) {
      log.warn('prune', 'failed', {
        project: p.id, err: (err as Error).message,
      });
    }
  }
}
setTimeout(() => { void pruneAllProjects(); }, 30_000);
setInterval(() => { void pruneAllProjects(); }, PRUNE_INTERVAL_MS);
