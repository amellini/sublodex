/** Prompt templates per il workflow regen di OpenSpec.
 *
 *  OpenSpec convenzione: ogni "change" è una directory con file fissi
 *  `proposal.md` (sorgente), `design.md` (deriva da proposal),
 *  `tasks.md` (deriva da proposal + design).
 *
 *  Il regen è scriptato come prompt naturale alla session attiva del
 *  progetto: Claude legge i file di riferimento e sovrascrive il target. */

export type RegenTarget = 'design' | 'tasks';

export function buildRegenPrompt(target: RegenTarget, changeDir: string): string {
  if (target === 'design') {
    return [
      `After changes in \`${changeDir}/proposal.md\`, analyze the spec`,
      `and regenerate \`${changeDir}/design.md\` accordingly.`,
      `Read the current proposal.md as source of truth and overwrite design.md`,
      `with the updated technical design. Preserve any decisions that are still valid.`,
    ].join(' ');
  }
  return [
    `After changes in \`${changeDir}/proposal.md\` and \`${changeDir}/design.md\`,`,
    `analyze both specs and regenerate \`${changeDir}/tasks.md\` accordingly.`,
    `Read proposal.md and design.md as source of truth and overwrite tasks.md`,
    `with the updated implementation checklist.`,
  ].join(' ');
}

/** Match `<...>/(design|tasks).md` (case-insensitive). Restituisce changeDir
 *  (path della cartella del change, senza trailing slash) e target.
 *  Per `proposal.md` e qualunque altro file ritorna null → niente regen. */
export function regenTargetFor(filePath: string): { target: RegenTarget; changeDir: string } | null {
  const m = filePath.match(/^(.*\/)(design|tasks)\.md$/i);
  if (!m) return null;
  return {
    changeDir: m[1].replace(/\/$/, ''),
    target: m[2].toLowerCase() as RegenTarget,
  };
}

/** Slash command opsx per Apply senza argomento: il plugin auto-rileva la
 *  change in lavorazione (vedi opsx/apply.md "Auto-select if only one active
 *  change exists"). Inviato come prompt utente al claude-agent-sdk, che lo
 *  risolve come slash command perché inizia con `/`. */
export const APPLY_PROMPT = '/opsx:apply';

/** Sentinella testuale che istruiamo Claude a stampare al posto della
 *  AskUserQuestion sul sync delle delta-spec. Stringa volutamente unusual:
 *  doppia parentesi quadra + tutto-maiuscolo + nome progetto, così la regex
 *  di rilevamento è praticamente immune ai falsi positivi nel testo naturale.
 *  Vedi src/lib/ws.ts handleOpsxDone. */
export const SYNC_SENTINEL = '[[SUBLODEX_NEEDS_SYNC_DECISION]]';

/** Costruisce il prompt da inviare per `/opsx:archive <name>` con due
 *  modalità di gestione del sync delle delta-spec (vedi opsx/archive.md
 *  step 4: "Assess delta spec sync state" → AskUserQuestion).
 *
 *  - `autoSync=true` → Claude prende decisione automatica "Sync now (recommended)"
 *    senza chiedere. Il batch va a fondo senza interruzioni umane.
 *  - `autoSync=false` → Claude scrive il sentinel + STOP. Lato client
 *    individuiamo il sentinel su `done`, mostriamo modale Si/No, e in base
 *    alla scelta inviamo `buildSyncReplyPrompt(...)` per riprendere. */
export function buildArchivePrompt(name: string, autoSync: boolean): string {
  if (autoSync) {
    return [
      `/opsx:archive ${name}`,
      ``,
      `IMPORTANT: when you reach the delta-spec sync prompt step, do NOT call`,
      `AskUserQuestion. Automatically pick "Sync now (recommended)" (or`,
      `"Sync anyway" / "Archive now" if already synced) and proceed silently`,
      `to complete the archive.`,
    ].join('\n');
  }
  return [
    `/opsx:archive ${name}`,
    ``,
    `IMPORTANT: when you reach the delta-spec sync prompt step, do NOT call`,
    `AskUserQuestion and do NOT proceed. Instead, write exactly this token`,
    `on a line by itself:`,
    SYNC_SENTINEL,
    `Then STOP the turn immediately, before performing any sync or the mv`,
    `archive operation. The user will reply in the next turn with "YES"`,
    `(sync delta specs then finish archiving) or "NO" (skip sync, just`,
    `finish archiving). Resume from where you stopped using their reply.`,
  ].join('\n');
}

/** Risposta dell'utente alla modale Si/No del sync. Riprende l'archivio
 *  dal punto in cui Claude si era fermato per la sentinella. */
export function buildSyncReplyPrompt(answer: 'yes' | 'no', name: string): string {
  if (answer === 'yes') {
    return [
      `YES — sync the delta specs for "${name}" now (use the openspec-sync-specs`,
      `skill / agent if your archive workflow expects it), then complete the`,
      `archive (move the change folder to openspec/changes/archive/YYYY-MM-DD-${name}/).`,
    ].join(' ');
  }
  return [
    `NO — skip the delta-spec sync for "${name}". Proceed to complete the`,
    `archive (move the change folder to openspec/changes/archive/YYYY-MM-DD-${name}/).`,
  ].join(' ');
}

/** Costruisce il comando per `/opsx:propose` con nome + contesto multiline.
 *  Il newline tra nome e contesto è preservato: opsx tipicamente legge gli
 *  argomenti come "tutto dopo il primo spazio". */
export function buildProposePrompt(name: string, context: string): string {
  return `/opsx:propose ${name} ${context}`;
}

/** True se path è una cartella change diretta sotto openspec/changes/, NON
 *  archiviata. Esclude `openspec/changes/archive` stessa e tutto ciò che ha
 *  `/archive/` nel path. */
export function isChangeFolder(p: string): boolean {
  if (!/^openspec\/changes\/[^/]+$/.test(p)) return false;
  if (p === 'openspec/changes/archive') return false;
  return true;
}

/** True se path è la cartella top-level di una change archiviata
 *  (`openspec/changes/archive/<name>` esatto, non un suo sotto-elemento). */
export function isArchivedChange(p: string): boolean {
  return /^openspec\/changes\/archive\/[^/]+$/.test(p);
}
