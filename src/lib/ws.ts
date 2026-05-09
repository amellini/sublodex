import type { Attachment, ClientMessage, PermissionDecision, ServerMessage } from './types';
import { useStore } from './store';
import { useSettings, activeProject } from './settings';
import { useUI } from './ui';
import { saveConversation } from './conversation';
import { wsTokenQuery } from './auth';
import { useOpenspecState } from './openspecState';
import { buildArchivePrompt, SYNC_SENTINEL } from './openspecPrompts';

// projectId/sessionFsId vengono catturati a `sendPrompt` e passati qui:
// se l'utente cambia progetto durante lo stream, vogliamo persistere la
// risposta nel progetto da cui è partita, non in quello attivo al `done`.
function persistCurrentConversation(projectId: string, sessionFsId: string | undefined): void {
  const s = useStore.getState();
  void saveConversation(projectId, {
    messages: s.messages,
    sessionId: s.sessionId,
    totalCost: s.totalCost,
    totalInput: s.totalInput,
    totalOutput: s.totalOutput,
    turns: s.turns,
    lastTurnInput: s.lastTurnInput,
  }, sessionFsId);
}

let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
/** Tentativi di riconnessione consecutivi falliti. Resettato a 0 ogni
 *  volta che `onopen` parte (= nuova connessione stabilita). Usato per
 *  backoff esponenziale con jitter. */
let reconnectAttempts = 0;
/** Snapshot di progetto + sessione catturato a `sendPrompt`. Necessario per
 *  evitare che uno switch di progetto mid-stream faccia persistere la
 *  risposta nel progetto sbagliato (issue #2). */
let _pendingProjectId: string | null = null;
let _pendingSessionFsId: string | undefined = undefined;

/** Backoff esponenziale con jitter: 1s, 2s, 4s, 8s, 16s, max 30s.
 *  Jitter ±25% per evitare che N client riprovino in sincrono dopo
 *  un riavvio del server. */
function nextReconnectDelayMs(): number {
  const base = Math.min(1000 * Math.pow(2, reconnectAttempts), 30_000);
  const jitter = base * (Math.random() * 0.5 - 0.25); // ±25%
  return Math.max(500, Math.round(base + jitter));
}

export function connect(): void {
  if (socket && socket.readyState <= WebSocket.OPEN) return;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Token in query string: WebSocket browser API non accetta header custom.
  // Se auth è disabilitata (dev) wsTokenQuery() ritorna '' → URL pulita.
  const ws = new WebSocket(`${proto}://${location.host}/ws${wsTokenQuery()}`);
  socket = ws;

  ws.onopen = () => {
    // Connessione stabilita → reset del contatore. Se cade di nuovo,
    // ripartiamo dal backoff minimo.
    reconnectAttempts = 0;
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data) as ServerMessage;
      const store = useStore.getState();
      if (msg.type === 'event') {
        store.ingestEvent(msg.event);
        // Persisti subito dopo system/init: a questo punto il sessionId Claude
        // è nel store e il messaggio utente è già in messages. Così anche se
        // l'utente fa F5 *durante* lo streaming, il turno non va perso.
        if (msg.event.type === 'system' && _pendingProjectId) {
          persistCurrentConversation(_pendingProjectId, _pendingSessionFsId);
        }
      } else if (msg.type === 'permission_request') {
        store.setPendingPermission({ id: msg.id, toolName: msg.toolName, input: msg.input });
      } else if (msg.type === 'done') {
        store.setStreaming(false);
        store.setPendingPermission(null);
        if (_pendingProjectId) persistCurrentConversation(_pendingProjectId, _pendingSessionFsId);
        _pendingProjectId = null;
        _pendingSessionFsId = undefined;
        // Hook per i comandi opsx: il `done` è il segnale "Claude ha finito il
        // turno". Lo usiamo per chiudere il loop su Apply (marca applied),
        // Archive (rimuove + reload tree), Propose (reload tree).
        void handleOpsxDone();
      }
      else if (msg.type === 'error') {
        store.setError(msg.error);
        store.setStreaming(false);
        store.setPendingPermission(null);
        if (_pendingProjectId) persistCurrentConversation(_pendingProjectId, _pendingSessionFsId);
        _pendingProjectId = null;
        _pendingSessionFsId = undefined;
        // Su errore: NON marchiamo applied/clear, ma resettiamo il pending così
        // il prossimo lancio non riceve un side-effect tardivo.
        useOpenspecState.getState().setPending(null);
      }
    } catch (err) {
      console.error('ws parse error:', err);
    }
  };

  ws.onclose = () => {
    socket = null;
    // Se il WS si chiude *durante* uno streaming, l'UI resterebbe bloccata
    // in stato "streaming". Resettiamo lo stato e segnaliamo l'errore per
    // far ripartire l'utente con un nuovo prompt una volta riconnessi.
    const store = useStore.getState();
    if (store.isStreaming) {
      store.setStreaming(false);
      store.setError('connessione persa durante la risposta — riprova');
      // Non persistiamo: la conversazione corrente è incompleta. Sarà
      // persistita normalmente al prossimo `done`.
    }
    store.setPendingPermission(null);
    // Stream interrotto a metà → invalidiamo le pending: al prossimo
    // `sendPrompt` verranno ricatturate dal progetto allora attivo.
    _pendingProjectId = null;
    _pendingSessionFsId = undefined;
    if (reconnectTimer !== null) return;
    const delay = nextReconnectDelayMs();
    reconnectAttempts += 1;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  ws.onerror = (e) => console.error('ws error', e);
}

/** Soglia oltre la quale consideriamo il WS in backpressure: 1MB di dati
 *  in fase di invio non ancora flushati dal kernel. Per Claude prompt
 *  testuali non si raggiunge mai, ma protegge da paste enormi. */
const WS_BACKPRESSURE_THRESHOLD = 1 * 1024 * 1024;

function rawSend(msg: ClientMessage): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount > WS_BACKPRESSURE_THRESHOLD) {
    console.warn(`ws backpressure: ${socket.bufferedAmount} bytes buffered, dropping send`);
    return false;
  }
  socket.send(JSON.stringify(msg));
  return true;
}

export function sendPrompt(prompt: string, attachments: Attachment[] = []): void {
  const { sessionId, model, permissionMode, appendUserMessage, setStreaming, setError } =
    useStore.getState();
  appendUserMessage(prompt, attachments);
  setStreaming(true);
  setError(undefined);
  const settings = useSettings.getState().settings;
  const active = activeProject(settings);
  if (active) {
    _pendingProjectId = active.id;
    _pendingSessionFsId = useUI.getState().activeSessionByProject[active.id];
  } else {
    _pendingProjectId = null;
    _pendingSessionFsId = undefined;
  }
  const ok = rawSend({
    type: 'send',
    prompt,
    sessionId,
    model,
    permissionMode,
    attachments: attachments.length > 0 ? attachments : undefined,
  });
  if (!ok) {
    setError('server not ready — try again in a moment');
    setStreaming(false);
    _pendingProjectId = null;
    _pendingSessionFsId = undefined;
  }
}

export function cancel(): void {
  rawSend({ type: 'cancel' });
}

/** Invia la risposta dell'utente a una permission_request del server.
 *  `payload` è la risposta libera dell'utente per AskUserQuestion (label
 *  selezionata o testo digitato). Pulisce subito lo stato locale. */
export function respondToPermission(id: string, decision: PermissionDecision, payload?: string): void {
  rawSend({ type: 'permission_response', id, decision, payload });
  useStore.getState().setPendingPermission(null);
}

/** Evento custom DOM emesso quando un comando opsx archive/propose è
 *  completato e il tree va re-fetchato. OpenspecTree monta un listener su
 *  questo evento per chiamare la propria `load()`. Il custom event evita di
 *  passare callback attraverso store/props per un cross-cutting concern
 *  occasionale. */
export const OPENSPEC_TREE_REFRESH_EVENT = 'sublodex:openspec-tree-refresh';

async function handleOpsxDone(): Promise<void> {
  const opsx = useOpenspecState.getState();
  const pending = opsx.pending;
  if (!pending) return;
  if (pending.kind === 'apply') {
    opsx.setPending(null);
    await opsx.markApplied(pending.changeDir);
  } else if (pending.kind === 'archive') {
    opsx.setPending(null);
    await opsx.clearApplied(pending.changeDir);
    window.dispatchEvent(new Event(OPENSPEC_TREE_REFRESH_EVENT));
  } else if (pending.kind === 'propose') {
    opsx.setPending(null);
    window.dispatchEvent(new Event(OPENSPEC_TREE_REFRESH_EVENT));
  } else if (pending.kind === 'archive-batch') {
    // Caso 1: autoSync=false e questo è il done della "fase sync-prompt".
    // Cerchiamo il sentinella nell'ultimo messaggio assistente: se c'è,
    // mettiamo in pausa la queue (awaitingSync=true) e aspettiamo che la
    // SyncDecisionModal raccolga la scelta dell'utente. Niente shift.
    if (!pending.autoSync && !pending.awaitingSync && lastAssistantContains(SYNC_SENTINEL)) {
      opsx.setPending({ ...pending, awaitingSync: true });
      return;
    }
    // Caso 2: questo è il done dell'archive completato (auto-sync mode, oppure
    // dopo che l'utente ha già risposto YES/NO al sentinella). Se proveniamo
    // dal pause-sync, l'utente ha azzerato awaitingSync prima di inviare la
    // reply (vedi SyncDecisionModal); qui siamo sempre con awaitingSync=false.
    const justFinished = pending.current;
    const cleanupKey = `openspec/changes/${justFinished}`;
    if (useOpenspecState.getState().applied[cleanupKey]) {
      await opsx.clearApplied(cleanupKey);
    }
    const remaining = pending.queue.slice();
    if (remaining.length === 0) {
      opsx.setPending(null);
      window.dispatchEvent(new Event(OPENSPEC_TREE_REFRESH_EVENT));
      return;
    }
    const next = remaining.shift()!;
    opsx.setPending({
      kind: 'archive-batch',
      queue: remaining,
      current: next,
      total: pending.total,
      done: pending.done + 1,
      autoSync: pending.autoSync,
      awaitingSync: false,
    });
    sendPrompt(buildArchivePrompt(next, pending.autoSync));
  }
}

/** Cerca una sottostringa nell'ultimo messaggio assistant del thread.
 *  Concatena solo i text-block (tool_use sono altri); ritorna false se
 *  non c'è ancora alcun messaggio assistente. */
function lastAssistantContains(needle: string): boolean {
  const messages = useStore.getState().messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    for (const b of m.blocks) {
      if (b.kind === 'text' && b.text.includes(needle)) return true;
    }
    return false; // primo assistente trovato non contiene → stop
  }
  return false;
}
