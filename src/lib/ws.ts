import type { ClientMessage, ServerMessage } from './types';
import { useStore } from './store';
import { useSettings, activeProject } from './settings';
import { useUI } from './ui';
import { saveConversation } from './conversation';
import { wsTokenQuery } from './auth';

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
      if (msg.type === 'event') store.ingestEvent(msg.event);
      else if (msg.type === 'done') {
        store.setStreaming(false);
        if (_pendingProjectId) persistCurrentConversation(_pendingProjectId, _pendingSessionFsId);
        _pendingProjectId = null;
        _pendingSessionFsId = undefined;
      }
      else if (msg.type === 'error') {
        store.setError(msg.error);
        store.setStreaming(false);
        if (_pendingProjectId) persistCurrentConversation(_pendingProjectId, _pendingSessionFsId);
        _pendingProjectId = null;
        _pendingSessionFsId = undefined;
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

export function sendPrompt(prompt: string): void {
  const { sessionId, model, permissionMode, appendUserMessage, setStreaming, setError } =
    useStore.getState();
  appendUserMessage(prompt);
  setStreaming(true);
  setError(undefined);
  // Snapshot del progetto + sessione attivi adesso: se l'utente li cambia
  // prima del `done`, vogliamo persistere comunque qui (issue #2).
  const settings = useSettings.getState().settings;
  const active = activeProject(settings);
  if (active) {
    _pendingProjectId = active.id;
    _pendingSessionFsId = useUI.getState().activeSessionByProject[active.id];
  } else {
    _pendingProjectId = null;
    _pendingSessionFsId = undefined;
  }
  const ok = rawSend({ type: 'send', prompt, sessionId, model, permissionMode });
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
