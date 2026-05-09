/**
 * Tipi per gli eventi di `claude --output-format stream-json --verbose`,
 * + il modello UI usato dal frontend.
 */

export type StreamEvent =
  | SystemInitEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | StreamEventWrap
  | { type: string; [k: string]: unknown };

export type SystemInitEvent = {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model?: string;
  cwd?: string;
};

export type AssistantEvent = {
  type: 'assistant';
  message: { id: string; role: 'assistant'; content: ContentBlock[] };
  session_id?: string;
};

export type UserEvent = {
  type: 'user';
  message: { role: 'user'; content: ContentBlock[] };
  session_id?: string;
};

export type ResultEvent = {
  type: 'result';
  subtype?: string;
  result?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    /** Token letti dalla cache (già presenti nel context window) */
    cache_read_input_tokens?: number;
    /** Token scritti in cache in questo turno (anche loro nel context window) */
    cache_creation_input_tokens?: number;
  };
  /** Per-model breakdown — contiene contextWindow e maxOutputTokens reali. */
  modelUsage?: Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    contextWindow: number;
    maxOutputTokens: number;
  }>;
  session_id?: string;
};

/** Eventi grezzi del SDK Anthropic, esposti da --verbose */
export type StreamEventWrap = {
  type: 'stream_event';
  event: SdkStreamEvent;
  parent_tool_use_id?: string | null;
  session_id?: string;
};

export type SdkStreamEvent =
  | { type: 'message_start'; message: { id: string; role: 'assistant' } }
  | { type: 'content_block_start'; index: number; content_block: ContentBlockStart }
  | { type: 'content_block_delta'; index: number; delta: BlockDelta }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta?: unknown }
  | { type: 'message_stop' }
  | { type: 'ping' };

export type ContentBlockStart =
  | { type: 'text'; text?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export type BlockDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string };

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;
export type TextBlock = { type: 'text'; text: string };
export type ToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
};

/* ---- type guards per StreamEvent ----
 *
 * Il tipo `StreamEvent` ha un fallback `{type:string;[k:string]:unknown}`
 * (per accomodare future varianti del SDK), che impedisce a TS di fare
 * narrowing automatico su `event.type === 'system'` ecc. — perché il
 * fallback combacia con qualsiasi `type`. Questi guard ripristinano la
 * discriminazione lato chiamante (store.ts), senza dover usare `as any`.
 */
export function isSystemInitEvent(e: StreamEvent): e is SystemInitEvent {
  return e.type === 'system' && (e as { subtype?: unknown }).subtype === 'init';
}
export function isAssistantEvent(e: StreamEvent): e is AssistantEvent {
  return e.type === 'assistant'
    && typeof (e as { message?: unknown }).message === 'object'
    && (e as { message?: { id?: unknown } }).message != null;
}
export function isUserEvent(e: StreamEvent): e is UserEvent {
  return e.type === 'user'
    && typeof (e as { message?: unknown }).message === 'object'
    && (e as { message?: unknown }).message != null;
}
export function isStreamEventWrap(e: StreamEvent): e is StreamEventWrap {
  return e.type === 'stream_event';
}
export function isResultEvent(e: StreamEvent): e is ResultEvent {
  return e.type === 'result';
}

export type PermissionDecision = 'allow' | 'allow_always' | 'deny';

export type ServerMessage =
  | { type: 'event'; event: StreamEvent }
  | { type: 'permission_request'; id: string; toolName: string; input: unknown }
  | { type: 'done' }
  | { type: 'error'; error: string };

export type ClientMessage =
  | { type: 'send'; prompt: string; sessionId?: string; model?: string; permissionMode?: string; attachments?: Attachment[] }
  | { type: 'permission_response'; id: string; decision: PermissionDecision; payload?: string }
  | { type: 'cancel' };

/* ---- modello UI ---- */

export type UIMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  blocks: UIBlock[];
  /** Allegati immagine associati al turno utente. Mai presenti su
   *  assistant/system. Le references agli originali (.sublodex/uploads/...)
   *  vengono iniettate nella stringa `prompt` lato client prima del WS send,
   *  così il backend Claude resta invariato. La UI usa SOLO i thumbnailPath
   *  per il rendering in scrollback (vedi Attachment). */
  attachments?: Attachment[];
};

/** Allegato immagine. Coppia (originale, thumbnail) generata al momento
 *  dell'upload e persistita su `<project.path>/.sublodex/{uploads,thumbs}/`.
 *
 *  Lifecycle:
 *   - originalPath: pruned dopo `retentionDays` (default 30) dal cron.
 *   - thumbnailPath: keep forever — usata per renderizzare la history anche
 *     quando l'originale non c'è più.
 *
 *  Il path passato a Claude nel prompt è SEMPRE `originalPath`. La UI
 *  carica SEMPRE `thumbnailPath` come `<img src>`. */
export type Attachment = {
  /** uuid v4 senza trattini (32 hex). Identifica la coppia (originale, thumb).
   *  Usato anche come basename del file. */
  id: string;
  /** Path relativo al `project.path`, es. `.sublodex/uploads/2026-05/<id>.png`.
   *  Esiste solo finché non scatta il pruning. È il path che Claude legge. */
  originalPath: string;
  /** Path relativo al `project.path`, es. `.sublodex/thumbs/2026-05/<id>.webp`.
   *  Esiste forever (modulo cancellazione manuale). */
  thumbnailPath: string;
  /** Mime dell'originale: `image/png` | `image/jpeg` | `image/webp` | `image/gif`. */
  mime: string;
  /** Dimensione originale in byte. Solo display (tooltip "1.2 MB"). */
  size: number;
  /** Dimensioni in pixel dell'originale. Servono al renderer per fissare
   *  width/height su `<img>` ed evitare CLS durante il lazy-load. */
  width?: number;
  height?: number;
  /** Nome originale del file se disponibile (drop, file picker). I paste
   *  dalla clipboard di solito arrivano senza nome → undefined. */
  filename?: string;
};

export type UIBlock =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: Record<string, unknown>;
      result?: { content: string; isError?: boolean };
      pending: boolean;
    }
  | { kind: 'usage'; data: PlanUsage };

export type WindowUsage = { utilization: number; resetsAt: number };

export type PlanUsage = {
  status: string;
  rateLimitType?: string;
  fallbackAvailable: boolean;
  windows: Record<string, WindowUsage>;
  overage?: { status: string; resetsAt?: number; disabledReason?: string };
  billing?: PlanBilling;
  weeklyBreakdown?: { name: string; utilization: number; resetsAt?: number }[];
  dailyRoutines?: { used: number; total: number };
  subscriptionType?: string;
  rawHeaders: Record<string, string>;
  debug?: { url: string; status: number; ok: boolean; sample?: string }[];
  fetchedAt: number;
};

export type PlanBilling = {
  currency?: string;
  spent?: number;
  monthlyCap?: number;
  balance?: number;
  autoRecharge?: boolean;
  resetsAt?: number;
};

/* ---- settings ---- */

export type RemoteConfig = {
  /** Hostname o IP. Anche un alias da ~/.ssh/config funziona. */
  host: string;
  port?: number;
  user?: string;
  /** Password — se settata, richiede `sshpass` installato sul server SubLodeX. */
  password?: string;
  /** Path al file della private key (es. ~/.ssh/id_ed25519). */
  identityFile?: string;
  /** URL pubblico del progetto (es. https://myapp.com) — non usato per SSH,
   *  solo per visualizzare un link "open" nell'header. */
  remoteUrl?: string;
  shellType?: 'auto' | 'bash' | 'zsh' | 'sh' | 'fish';
  agentForwarding?: boolean;
};

export type Project = {
  id: string;
  name: string;
  /** Path nel progetto. Se `remote` è settato, è il path SUL server remoto. */
  path: string;
  instructions: string;
  remote?: RemoteConfig;
  /** Ultimo timestamp (epoch ms) in cui il progetto è stato reso attivo via
   *  ProjectSwitcher / SettingsModal. Usato per ordinare la lista dei recenti.
   *  Opzionale: progetti pre-feature non lo hanno e ricadono in fondo. */
  lastUsedAt?: number;
};

export type Settings = {
  activeId: string;
  projects: Project[];
};
