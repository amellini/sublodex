import { create } from 'zustand';
import { parsePartial } from './partialJson';
import { useSettings } from './settings';
import type {
  AssistantEvent,
  Attachment,
  PlanUsage,
  ResultEvent,
  StreamEvent,
  StreamEventWrap,
  UIBlock,
  UIMessage,
} from './types';
import {
  isAssistantEvent,
  isStreamEventWrap,
  isSystemInitEvent,
  isUserEvent,
} from './types';

type ToolStreamState = {
  name: string;
  /** index del content_block dentro il messaggio corrente (per matchare i delta) */
  index: number;
  partialJson: string;
  parsed: Record<string, unknown> | null;
  filePath?: string;
};

export type StreamSpeed = 'instant' | 'fast' | 'normal' | 'slow';

/** Char accodati per "tick" (~30ms). Speed 'instant' bypassa il typewriter
 *  e mostra subito il contenuto pieno. */
const TICK_MS = 30;
const SPEED_CHARS_PER_TICK: Record<StreamSpeed, number> = {
  instant: Infinity,
  fast:    10,   // ~333 char/s — vedi il flusso ma non rallenta
  normal:   3,   // ~100 char/s — comodo da leggere riga per riga
  slow:     1,   // ~33 char/s — typewriter teatrale, una battuta alla volta
};

export type StreamingFile = {
  /** Contenuto totale ricevuto finora dai delta */
  full: string;
  /** Contenuto attualmente mostrato (cresce gradualmente verso full) */
  displayed: string;
  /** Tool_result è arrivato? Quando true e displayed===full, l'entry viene rimossa */
  finished: boolean;
};

type Store = {
  messages: UIMessage[];
  sessionId?: string;
  isStreaming: boolean;
  activeFile?: string;
  /** ordine dei tab editor aperti */
  openFiles: string[];
  /** contenuti "in scrittura" — full=tutto ciò che è arrivato, displayed=tipo typewriter */
  streamingFiles: Record<string, StreamingFile>;
  /** velocità del typewriter per la live file write */
  streamSpeed: StreamSpeed;
  lastError?: string;

  /** preferenze runtime per claude (passate al server ad ogni turno) */
  model?: string;
  permissionMode: string;

  /** Richiesta di permesso pendente dal server (canUseTool callback).
   *  Quando non-null, l'UI mostra il prompt corrispondente (PermissionPrompt
   *  generico, oppure overlay Approva/Rivedi se toolName === 'ExitPlanMode',
   *  oppure QuestionCard se toolName === 'AskUserQuestion'). */
  pendingPermission: { id: string; toolName: string; input: unknown } | null;

  /** modello effettivamente in uso, riportato da claude nei `system/init` events */
  runtimeModel?: string;

  /** statistica cumulata dai `result` events */
  totalCost: number;
  totalInput: number;
  totalOutput: number;
  turns: number;

  /** Token totali dell'ultimo turno nel context window (input + cache_creation + cache_read).
   *  È il valore corretto per "quanto contesto è in uso", perché Claude Code usa
   *  il prompt caching: la maggior parte dei token sono cache_read e sarebbero
   *  invisibili usando solo input_tokens. */
  lastTurnInput: number;
  lastTurnOutput: number;
  /** Dimensione reale del context window del modello, ricavata da modelUsage.contextWindow.
   *  0 = non ancora ricevuto (usa fallback 200k). */
  modelContextWindow: number;

  appendUserMessage: (text: string, attachments?: Attachment[]) => void;
  appendSystemMessage: (text: string) => void;
  appendUsageCard: (data: PlanUsage) => void;
  ingestEvent: (event: StreamEvent) => void;
  setStreaming: (v: boolean) => void;
  setActiveFile: (path?: string) => void;
  closeFile: (path: string) => void;
  setError: (err?: string) => void;
  setModel: (m?: string) => void;
  setPermissionMode: (m: string) => void;
  setPendingPermission: (p: Store['pendingPermission']) => void;
  setStreamSpeed: (s: StreamSpeed) => void;
  resetSession: () => void;

  /** carica una conversazione persistita: rimpiazza messages + sessionId + statistiche.
   *  Lo stato volatile (streaming, activeFile, openFiles) viene azzerato. */
  hydrateConversation: (snap: {
    messages?: UIMessage[];
    sessionId?: string | null;
    totalCost?: number; totalInput?: number; totalOutput?: number; turns?: number;
    lastTurnInput?: number;
  }) => void;
};

let counter = 0;
const localId = () => `m${++counter}_${Date.now()}`;

/** Path che claude manda è spesso assoluto, dal file tree è relativo.
 *  Normalizziamo entrambi a relativo (rispetto al progetto attivo) così
 *  i tab dedupano correttamente. */
function normalizeFilePath(p: string): string {
  try {
    const s = useSettings.getState().settings;
    if (!s) return p;
    const active = s.projects.find((x) => x.id === s.activeId) ?? s.projects[0];
    if (!active?.path) return p;
    if (p === active.path) return '.';
    if (p.startsWith(active.path + '/')) return p.slice(active.path.length + 1);
  } catch { /* fallback */ }
  return p;
}

const toolStreams = new Map<string, ToolStreamState>();

const DEFAULT_PERMISSION = 'default';

/* ---------- typewriter tick ---------- */

let tickHandle: ReturnType<typeof setInterval> | null = null;

function ensureTypewriterTick() {
  if (tickHandle !== null) return;
  tickHandle = setInterval(() => {
    const state = useStore.getState();
    const charsPerTick = SPEED_CHARS_PER_TICK[state.streamSpeed];

    const entries = Object.entries(state.streamingFiles);
    if (entries.length === 0) {
      if (tickHandle !== null) { clearInterval(tickHandle); tickHandle = null; }
      return;
    }

    let mut = false;
    const next: Record<string, StreamingFile> = {};
    for (const [path, sf] of entries) {
      let displayed = sf.displayed;
      if (displayed.length < sf.full.length) {
        const append = Math.min(charsPerTick, sf.full.length - displayed.length);
        displayed = sf.full.substring(0, displayed.length + append);
        mut = true;
      }
      // Se è arrivato il tool_result (finished) E displayed ha raggiunto full,
      // rimuoviamo l'entry: l'editor refetcha dal disco.
      if (sf.finished && displayed.length >= sf.full.length) {
        mut = true;
        continue;
      }
      next[path] = displayed === sf.displayed ? sf : { ...sf, displayed };
    }
    if (mut) useStore.setState({ streamingFiles: next });
  }, TICK_MS);
}

const SAVED_SPEED = (() => {
  try {
    const v = localStorage.getItem('sublodex.streamSpeed');
    if (v === 'instant' || v === 'fast' || v === 'normal' || v === 'slow') return v as StreamSpeed;
  } catch { /* */ }
  return 'instant' as StreamSpeed;
})();

export const useStore = create<Store>((set, get) => ({
  messages: [],
  isStreaming: false,
  openFiles: [],
  streamingFiles: {},
  streamSpeed: SAVED_SPEED,
  permissionMode: DEFAULT_PERMISSION,
  pendingPermission: null,
  totalCost: 0,
  totalInput: 0,
  totalOutput: 0,
  turns: 0,
  lastTurnInput: 0,
  lastTurnOutput: 0,
  modelContextWindow: 0,

  appendUserMessage: (text, attachments) =>
    set((s) => ({
      messages: [...s.messages, {
        id: localId(),
        role: 'user',
        blocks: [{ kind: 'text', text }],
        // Salviamo solo array non-vuoti per non gonfiare il JSON persistito.
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      }],
      lastError: undefined,
    })),

  appendSystemMessage: (text) =>
    set((s) => ({
      messages: [...s.messages, { id: localId(), role: 'system', blocks: [{ kind: 'text', text }] }],
    })),

  appendUsageCard: (data) =>
    set((s) => ({
      messages: [...s.messages, { id: localId(), role: 'system', blocks: [{ kind: 'usage', data }] }],
    })),

  setStreaming: (v) => set({ isStreaming: v }),

  setStreamSpeed: (s) => {
    try { localStorage.setItem('sublodex.streamSpeed', s); } catch { /* */ }
    set({ streamSpeed: s });
    // Se passi a 'instant' mentre c'è streaming attivo, allinea subito tutti i displayed.
    if (s === 'instant') {
      set((st) => ({
        streamingFiles: Object.fromEntries(
          Object.entries(st.streamingFiles).map(([k, sf]) => [k, { ...sf, displayed: sf.full }]),
        ),
      }));
    }
  },
  setActiveFile: (path) =>
    set((s) => {
      if (path === undefined) return { activeFile: undefined };
      const norm = normalizeFilePath(path);
      const openFiles = s.openFiles.includes(norm) ? s.openFiles : [...s.openFiles, norm];
      return { activeFile: norm, openFiles };
    }),
  closeFile: (path) =>
    set((s) => {
      const openFiles = s.openFiles.filter((p) => p !== path);
      let activeFile = s.activeFile;
      if (activeFile === path) {
        const idx = s.openFiles.indexOf(path);
        activeFile = openFiles[idx] ?? openFiles[idx - 1] ?? openFiles[openFiles.length - 1];
      }
      return { openFiles, activeFile };
    }),
  setError: (err) => set({ lastError: err }),
  setModel: (m) => set({ model: m }),
  setPermissionMode: (m) => set({ permissionMode: m }),
  setPendingPermission: (p) => set({ pendingPermission: p }),

  resetSession: () => {
    toolStreams.clear();
    set({
      messages: [],
      sessionId: undefined,
      runtimeModel: undefined,
      lastError: undefined,
      streamingFiles: {},
      openFiles: [],
      activeFile: undefined,
      pendingPermission: null,
      totalCost: 0,
      totalInput: 0,
      totalOutput: 0,
      turns: 0,
      lastTurnInput: 0,
      lastTurnOutput: 0,
      modelContextWindow: 0,
    });
  },

  hydrateConversation: (snap) => {
    toolStreams.clear();
    set({
      messages: snap.messages ?? [],
      sessionId: snap.sessionId ?? undefined,
      totalCost: snap.totalCost ?? 0,
      totalInput: snap.totalInput ?? 0,
      totalOutput: snap.totalOutput ?? 0,
      turns: snap.turns ?? 0,
      // lastTurnInput è persistito per mantenere la progress bar del context
      // window visibile dopo un reload, anche senza inviare un nuovo messaggio.
      lastTurnInput: snap.lastTurnInput ?? 0,
      // stato volatile sempre resettato
      runtimeModel: undefined,
      lastError: undefined,
      streamingFiles: {},
      openFiles: [],
      activeFile: undefined,
      isStreaming: false,
      lastTurnOutput: 0,
      modelContextWindow: 0,
    });
  },

  ingestEvent: (event) => {
    if (isSystemInitEvent(event)) {
      set({
        sessionId: event.session_id,
        runtimeModel: typeof event.model === 'string' ? event.model : undefined,
      });
      return;
    }

    if (isStreamEventWrap(event)) {
      handleStreamEvent(event, set);
      return;
    }

    if (isAssistantEvent(event)) {
      const msg = event.message;
      const blocks = toUIBlocks(msg.content);
      set((s) => {
        const idx = s.messages.findIndex((m) => m.id === msg.id);
        if (idx === -1) {
          return { messages: [...s.messages, { id: msg.id, role: 'assistant', blocks }] };
        }
        const next = s.messages.slice();
        const prevBlocks = next[idx].blocks;
        const merged: UIBlock[] = blocks.map((b) => {
          if (b.kind !== 'tool') return b;
          const prev = prevBlocks.find((p) => p.kind === 'tool' && p.id === b.id);
          if (prev && prev.kind === 'tool') return { ...b, pending: prev.pending, result: prev.result };
          return b;
        });
        next[idx] = { ...next[idx], blocks: merged };
        return { messages: next };
      });

      // auto-open editor: usa la action setActiveFile che dedup-a + popola openFiles
      for (const b of blocks) {
        if (b.kind !== 'tool') continue;
        const fp = b.input.file_path;
        if (typeof fp === 'string' && (b.name === 'Write' || b.name === 'Edit' || b.name === 'MultiEdit' || b.name === 'Read')) {
          // chiamiamo l'action via getState() per applicare normalizzazione + openFiles
          useStore.getState().setActiveFile(fp);
        }
      }
      return;
    }

    if (isUserEvent(event)) {
      const msg = event.message;
      for (const block of msg.content) {
        if (block.type !== 'tool_result') continue;
        const toolId = block.tool_use_id;
        const content =
          typeof block.content === 'string'
            ? block.content
            : block.content.map((c) => c.text ?? '').join('\n');

        const stream = toolStreams.get(toolId);
        if (stream?.filePath) {
          const normKey = normalizeFilePath(stream.filePath);
          set((s) => {
            const sf = { ...s.streamingFiles };
            const isInstant = s.streamSpeed === 'instant';
            // Instant: niente typewriter da finire, rimuovi subito.
            // Altrimenti: marca finished=true; il tick rimuoverà l'entry
            //             quando displayed avrà raggiunto full.
            if (isInstant) {
              delete sf[normKey];
              delete sf[stream.filePath!];
            } else {
              const prev = sf[normKey] ?? sf[stream.filePath!];
              if (prev) {
                sf[normKey] = { ...prev, finished: true };
              } else {
                delete sf[normKey];
                delete sf[stream.filePath!];
              }
            }
            return { streamingFiles: sf };
          });
          toolStreams.delete(toolId);
        }

        set((s) => ({
          messages: s.messages.map((m) => ({
            ...m,
            blocks: m.blocks.map((b) =>
              b.kind === 'tool' && b.id === toolId
                ? { ...b, result: { content, isError: block.is_error }, pending: false }
                : b,
            ),
          })),
        }));
      }
      return;
    }

    if (event.type === 'result') {
      const r = event as ResultEvent;
      // Debug temporaneo — rimuovere dopo conferma valori corretti.
      // Apri DevTools → Console per vedere il payload completo.
      console.debug('[sublodex:result] payload completo:', event);
      set((s) => {
        // In modalità typewriter, evita di wipare brutalmente: marca finished
        // così il tick può completare l'animazione e poi rimuovere le entry.
        // In 'instant' il wipe è fine perché displayed === full sempre.
        const isInstant = s.streamSpeed === 'instant';
        const nextFiles: Record<string, StreamingFile> = isInstant
          ? {}
          : Object.fromEntries(
              Object.entries(s.streamingFiles).map(([k, sf]) => [k, { ...sf, finished: true }]),
            );
        return {
          totalCost: s.totalCost + (r.total_cost_usd ?? 0),
          totalInput: s.totalInput + (r.usage?.input_tokens ?? 0),
          totalOutput: s.totalOutput + (r.usage?.output_tokens ?? 0),
          turns: s.turns + 1,
          // Il context window reale è la somma di tutti i token inviati all'API:
          // - input_tokens: token nuovi (non cachati) del turno corrente
          // - cache_read_input_tokens: token letti dalla cache (già nel contesto)
          // - cache_creation_input_tokens: token scritti in cache per la prima volta
          // Usare solo input_tokens darebbe valori bassissimi su sessioni lunghe
          // con prompt caching attivo (subscription Pro/Max).
          lastTurnInput: r.usage
            ? (r.usage.input_tokens ?? 0)
              + (r.usage.cache_read_input_tokens ?? 0)
              + (r.usage.cache_creation_input_tokens ?? 0)
            : s.lastTurnInput,
          lastTurnOutput: r.usage?.output_tokens ?? s.lastTurnOutput,
          // Legge il context window reale dal primo entry di modelUsage
          // (tutti i modelli di un turno hanno lo stesso contextWindow).
          modelContextWindow: r.modelUsage
            ? (Object.values(r.modelUsage)[0]?.contextWindow ?? s.modelContextWindow)
            : s.modelContextWindow,
          messages: s.messages.map((m) => ({
            ...m,
            blocks: m.blocks.map((b) =>
              b.kind === 'tool' && b.pending ? { ...b, pending: false } : b,
            ),
          })),
          streamingFiles: nextFiles,
        };
      });
      toolStreams.clear();
      return;
    }
  },
}));

function toUIBlocks(content: AssistantEvent['message']['content']): UIBlock[] {
  return content
    .map<UIBlock | null>((c) => {
      if (c.type === 'text') return { kind: 'text', text: c.text };
      if (c.type === 'tool_use') {
        return { kind: 'tool', id: c.id, name: c.name, input: c.input ?? {}, pending: true };
      }
      return null;
    })
    .filter((b): b is UIBlock => b !== null);
}

/* ---------- streaming live (stream_event) ---------- */

function handleStreamEvent(
  wrap: StreamEventWrap,
  set: (fn: (s: Store) => Partial<Store>) => void,
) {
  const ev = wrap.event;
  if (ev.type === 'content_block_start') {
    const cb = ev.content_block;
    if (cb.type === 'tool_use') {
      toolStreams.set(cb.id, {
        name: cb.name,
        index: ev.index,
        partialJson: '',
        parsed: null,
      });
    }
    return;
  }

  if (ev.type === 'content_block_delta') {
    if (ev.delta.type !== 'input_json_delta') return;
    // Matchiamo il delta al tool_use giusto via `index` (non l'ultimo inserito):
    // più robusto se claude emette tool_use multipli in parallelo o se ci sono
    // text/thinking blocks intercalati che hanno lo stesso "ultimo" entry.
    const found = findByIndex(ev.index);
    if (!found) return;
    const [toolId, state] = found;
    state.partialJson += ev.delta.partial_json;
    const parsed = parsePartial(state.partialJson) as Record<string, unknown> | null;
    state.parsed = parsed;

    if (parsed && typeof parsed === 'object') {
      // memorizza il file_path corrente — ma NON aprire il tab finché non
      // sappiamo che è "stabile". Durante lo streaming il path arriva char
      // per char (`/`, `/U`, `/Us`, …): se aprissi un tab ad ogni cambio
      // avresti N tab fantasma con prefissi parziali.
      if (typeof parsed.file_path === 'string') {
        state.filePath = parsed.file_path;
      }

      // Il `content` (o `new_string` per Edit) viene streamato DOPO `file_path`,
      // quindi se è già una stringa significa che il path è completo.
      const writeContent =
        state.name === 'Write' && typeof parsed.content === 'string'
          ? (parsed.content as string)
          : null;
      const editContent =
        state.name === 'Edit' && typeof parsed.new_string === 'string'
          ? `// (edit in arrivo)\n${parsed.new_string as string}`
          : null;
      const liveContent = writeContent ?? editContent;

      if (state.filePath && liveContent !== null) {
        // Una sola transizione di stato: apri tab + popola streamingFiles
        // con la chiave normalizzata. Atomic così l'EditorPane al primo
        // render vede già streamingContent (e skippa il fetch dal disco).
        const fp = state.filePath;
        set((s) => {
          const norm = normalizeFilePath(fp);
          const openFiles = s.openFiles.includes(norm)
            ? s.openFiles
            : [...s.openFiles, norm];
          const prev = s.streamingFiles[norm];
          // Speed 'instant' = no typewriter, displayed = full subito.
          const isInstant = s.streamSpeed === 'instant';
          const nextSF: StreamingFile = {
            full: liveContent,
            displayed: isInstant ? liveContent : (prev?.displayed ?? ''),
            finished: false,
          };
          return {
            activeFile: norm,
            openFiles,
            streamingFiles: { ...s.streamingFiles, [norm]: nextSF },
          };
        });
        // Avvia il tick (no-op se già attivo). Per 'instant' è inutile ma
        // costa nulla: il loop si autoclose la prossima iterazione.
        ensureTypewriterTick();
      }

      set((s) => ({
        messages: s.messages.map((m) => ({
          ...m,
          blocks: m.blocks.map((b) =>
            b.kind === 'tool' && b.id === toolId
              ? { ...b, input: { ...b.input, ...(parsed as Record<string, unknown>) } }
              : b,
          ),
        })),
      }));
    }
    return;
  }

  if (ev.type === 'message_start') {
    const id = ev.message?.id;
    if (id) {
      set((s) => {
        if (s.messages.some((m) => m.id === id)) return {};
        return { messages: [...s.messages, { id, role: 'assistant', blocks: [] }] };
      });
    }
    return;
  }
}

function findByIndex(idx: number): [string, ToolStreamState] | null {
  for (const [k, v] of toolStreams) {
    if (v.index === idx) return [k, v];
  }
  return null;
}
