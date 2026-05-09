import { create } from 'zustand';

/** Stato persistito server-side (`openspec/.sublodex-state.json`) per ricordare
 *  quali change OpenSpec sono già state "applied". Il filesystem da solo non
 *  basta perché `apply` non muove la cartella (lo fa `archive`). Il client
 *  rifletteva questo stato per scegliere se mostrare il bottone Apply o
 *  Archive su ciascuna cartella.
 *
 *  Singleton globale: il backend è già scoped al progetto attivo, quando lo
 *  switch di progetto avviene chiamiamo `loadState()` per re-popolare. */

/** Cosa l'utente ha appena lanciato e di cui aspettiamo il `done` sul WS.
 *  Necessario per chiudere il loop "Apply → marca applied" / "Archive → reload
 *  tree" senza leggere il testo di Claude. Vedi src/lib/ws.ts.
 *
 *  `archive-batch` è la modalità multi-select dal picker: la queue contiene i
 *  nomi delle change da archiviare in sequenza (uno per turno Claude, perché
 *  /opsx:archive prende un solo nome). Il done hook fa shift della queue,
 *  invia il prossimo prompt, e termina quando la queue è vuota.
 *
 *  Sotto-stato `awaitingSync` per il caso autoSync=false: dopo il primo
 *  done, se l'ultimo testo assistente contiene SYNC_SENTINEL settiamo
 *  awaitingSync=true, mostriamo SyncDecisionModal, e NON avanziamo la
 *  queue. La risposta Yes/No dell'utente invia un nuovo prompt che riprende
 *  l'archivio; il done successivo (con awaitingSync di nuovo false) avanza
 *  normalmente. */
export type PendingOpsx =
  | { kind: 'apply'; changeDir: string }
  | { kind: 'archive'; changeDir: string }
  | {
      kind: 'archive-batch';
      queue: string[];
      current: string;
      total: number;
      done: number;
      autoSync: boolean;
      awaitingSync: boolean;
    }
  | { kind: 'propose' }
  | null;

/** Schema di una entry da `openspec list --json`. */
export type OpenspecChange = {
  name: string;
  completedTasks: number;
  totalTasks: number;
  lastModified: string;
  status: 'complete' | 'in-progress' | string;
};

type OpenspecStateStore = {
  /** Mappa changeDir (`openspec/changes/foo`) → ISO timestamp del marcato. */
  applied: Record<string, string>;
  loaded: boolean;
  pending: PendingOpsx;
  setPending: (p: PendingOpsx) => void;
  loadState: () => Promise<void>;
  markApplied: (changeDir: string) => Promise<void>;
  clearApplied: (changeDir: string) => Promise<void>;
  /** Fetch della lista change da `openspec list --json`. Usato dalla
   *  ArchivePickerModal. Non fa caching: la lista cambia spesso (apply/archive
   *  in corso, edit manuali, ...) e il payload è piccolo. */
  fetchChanges: () => Promise<{ changes: OpenspecChange[]; error?: string }>;
};

export const useOpenspecState = create<OpenspecStateStore>((set, get) => ({
  applied: {},
  loaded: false,
  pending: null,
  setPending: (p) => set({ pending: p }),
  loadState: async () => {
    try {
      const r = await fetch('/api/openspec/state');
      if (!r.ok) return;
      const j = (await r.json()) as { applied?: Record<string, string> };
      set({ applied: j.applied ?? {}, loaded: true });
    } catch {
      // Endpoint può fallire se progetto non ha openspec/: in tal caso lo
      // store resta vuoto, il tree non è comunque visibile.
    }
  },
  markApplied: async (changeDir) => {
    const r = await fetch('/api/openspec/state/applied', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changeDir, applied: true }),
    });
    if (!r.ok) return;
    const j = (await r.json()) as { applied?: Record<string, string> };
    if (j.applied) set({ applied: j.applied });
    else set({ applied: { ...get().applied, [changeDir]: new Date().toISOString() } });
  },
  clearApplied: async (changeDir) => {
    const r = await fetch('/api/openspec/state/applied', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changeDir, applied: false }),
    });
    if (!r.ok) return;
    const j = (await r.json()) as { applied?: Record<string, string> };
    if (j.applied) set({ applied: j.applied });
    else {
      const next = { ...get().applied };
      delete next[changeDir];
      set({ applied: next });
    }
  },
  fetchChanges: async () => {
    try {
      const r = await fetch('/api/openspec/changes');
      if (!r.ok) return { changes: [], error: `HTTP ${r.status}` };
      const j = (await r.json()) as { changes?: OpenspecChange[]; error?: string };
      return { changes: j.changes ?? [], error: j.error };
    } catch (err) {
      return { changes: [], error: err instanceof Error ? err.message : String(err) };
    }
  },
}));
