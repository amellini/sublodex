/**
 * Gestione filesystem degli attachments immagine.
 *
 * Layout su disco (sia locale che remoto, identico):
 *
 *   <project.path>/.sublodex/
 *   ├── .gitignore                        # contiene "*\n"
 *   ├── uploads/YYYY-MM/<uuid>.<ext>      # originali, retention 30gg
 *   └── thumbs/YYYY-MM/<uuid>.webp        # thumbnail, keep forever
 *
 * Il bucketing per anno-mese rende il pruning O(numero_di_mesi):
 * cancelliamo intere cartelle invece di fare find -mtime per file.
 *
 * Le thumbnail vengono generate client-side (OffscreenCanvas + WebP) e
 * inviate insieme all'originale dall'endpoint `POST /api/upload`. Il server
 * le salva senza ri-encoding.
 */

import { mkdir, readdir, rm, writeFile, stat, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import type { RemoteConfig } from '../src/lib/types';
import { shellQuote } from './shell-utils';

/* ---------- costanti ---------- */

/** Mime accettati. Allineato ai limiti Anthropic per le immagini. */
export const ALLOWED_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

/** 5 MB per file = limite Anthropic per immagine in input. Lato client
 *  validiamo prima per fail-fast, qui validiamo di nuovo per defense-in-depth
 *  (un client compromesso potrebbe bypassare). */
export const MAX_BYTES = 5 * 1024 * 1024;

/** Massimo dimensione thumbnail accettata. La thumbnail viene generata dal
 *  client a 512px lato lungo in WebP q=0.78 → tipicamente < 50 KB. Qualsiasi
 *  cosa sopra i 256 KB indica un client che bara o un bug nella thumbnail
 *  generation. */
export const MAX_THUMB_BYTES = 256 * 1024;

/** Retention degli originali. Le thumbnail non vengono mai pruned. */
export const RETENTION_DAYS = 30;

/** Frequenza del cron di pruning. Settimanale. */
export const PRUNE_INTERVAL_MS = 7 * 24 * 3600 * 1000;

/* ---------- helpers path ---------- */

/** mappa mime → estensione canonica */
export function extFromMime(mime: string): string | null {
  switch (mime) {
    case 'image/png':  return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/gif':  return 'gif';
    default: return null;
  }
}

/** Genera un id (uuid v4 senza trattini) e i path relativi per (originale, thumb).
 *  Il bucket year-month è calcolato sul wallclock corrente. */
export function buildAttachmentPaths(originalExt: string): {
  id: string;
  yearMonth: string;
  originalRel: string;
  thumbnailRel: string;
} {
  const id = crypto.randomUUID().replace(/-/g, '');
  const now = new Date();
  const yearMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  // Sempre POSIX-style (forward slash) anche su Windows. Sono path relativi
  // che vengono iniettati nel prompt e Claude li interpreta come tali.
  const originalRel = `.sublodex/uploads/${yearMonth}/${id}.${originalExt}`;
  const thumbnailRel = `.sublodex/thumbs/${yearMonth}/${id}.webp`;
  return { id, yearMonth, originalRel, thumbnailRel };
}

/** Risolve un path relativo .sublodex/{uploads,thumbs}/... ad assoluto.
 *  Usa POSIX su remoto, nativo (path.resolve) su locale. */
export function resolveAttachmentAbs(projectPath: string, rel: string, isRemote: boolean): string {
  if (isRemote) {
    // join POSIX, niente normalize: il rel è già pulito (lo costruiamo noi)
    const p = projectPath.endsWith('/') ? projectPath.slice(0, -1) : projectPath;
    return `${p}/${rel}`;
  }
  return path.resolve(projectPath, rel);
}

/* ---------- gitignore ---------- */

/** Garantisce l'esistenza di `<project>/.sublodex/.gitignore` con contenuto `*\n`.
 *  Idempotente: scrive solo se manca. Evita di sporcare il git status del
 *  progetto utente con i file dentro .sublodex/ senza modificargli il suo
 *  .gitignore principale. */
export async function ensureSubLodeXGitignoreLocal(projectPath: string): Promise<void> {
  const subdir = path.join(projectPath, '.sublodex');
  const gi = path.join(subdir, '.gitignore');
  try {
    await access(gi);
    return; // già presente
  } catch { /* manca, lo creiamo */ }
  await mkdir(subdir, { recursive: true });
  await writeFile(gi, '*\n', 'utf8');
}

export async function ensureSubLodeXGitignoreRemote(
  remote: RemoteConfig,
  projectPath: string,
  sshExec: (
    remote: RemoteConfig,
    cmd: string,
    stdin?: string,
    timeoutMs?: number,
  ) => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>,
): Promise<void> {
  const subdir = `${projectPath}/.sublodex`;
  const gi = `${subdir}/.gitignore`;
  // mkdir -p è idempotente; il test -f evita di sovrascrivere se esiste.
  // Lo facciamo in un solo round-trip con una sub-shell.
  const cmd = `mkdir -p ${shellQuote(subdir)} && [ -f ${shellQuote(gi)} ] || printf '*\\n' > ${shellQuote(gi)}`;
  await sshExec(remote, cmd);
}

/* ---------- write ---------- */

/** Scrive originale + thumbnail su filesystem locale. mkdir -p ricorsivo per
 *  i bucket year-month (può essere il primo del mese). */
export async function writeAttachmentLocal(
  projectPath: string,
  originalRel: string,
  thumbRel: string,
  originalBytes: Uint8Array,
  thumbBytes: Uint8Array,
): Promise<void> {
  const origAbs = path.resolve(projectPath, originalRel);
  const thumbAbs = path.resolve(projectPath, thumbRel);
  await Promise.all([
    mkdir(path.dirname(origAbs), { recursive: true }),
    mkdir(path.dirname(thumbAbs), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(origAbs, originalBytes),
    writeFile(thumbAbs, thumbBytes),
  ]);
}

/** Scrive originale + thumbnail su filesystem remoto via sshExec.
 *
 *  Strategia: passiamo i bytes via stdin codificati base64, e sul remoto
 *  facciamo `base64 -d > file`. Bandwidth overhead +33%, ma per immagini
 *  ≤ 5 MB è tranquillamente sotto i 7 MB di traffico, accettabile.
 *
 *  Nota: 1) `sshExec` accetta UN solo stdin string, quindi facciamo DUE
 *  round-trip ssh (originale + thumb) — riusano la stessa TCP grazie a
 *  ControlMaster, quindi il costo è ~10ms ciascuno. 2) Concorrenza: lanciati
 *  in parallelo con Promise.all, nessuna race perché scrivono path diversi. */
export async function writeAttachmentRemote(
  remote: RemoteConfig,
  projectPath: string,
  originalRel: string,
  thumbRel: string,
  originalBytes: Uint8Array,
  thumbBytes: Uint8Array,
  sshExec: (
    remote: RemoteConfig,
    cmd: string,
    stdin?: string,
    timeoutMs?: number,
  ) => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>,
): Promise<void> {
  const origAbs = `${projectPath}/${originalRel}`;
  const thumbAbs = `${projectPath}/${thumbRel}`;
  const origDir = `${projectPath}/${path.posix.dirname(originalRel)}`;
  const thumbDir = `${projectPath}/${path.posix.dirname(thumbRel)}`;

  const origB64 = uint8ToBase64(originalBytes);
  const thumbB64 = uint8ToBase64(thumbBytes);

  // Marker di successo: usiamo un echo dopo il pipe per distinguere errori
  // di scrittura veri da exit code 0 ingannevoli (sshpass).
  const writeCmd = (dir: string, file: string) =>
    `mkdir -p ${shellQuote(dir)} && base64 -d > ${shellQuote(file)} && echo OK_W`;

  const [r1, r2] = await Promise.all([
    sshExec(remote, writeCmd(origDir, origAbs), origB64, 30_000),
    sshExec(remote, writeCmd(thumbDir, thumbAbs), thumbB64, 30_000),
  ]);
  if (!r1.stdout.includes('OK_W')) {
    throw new Error(`remote write original failed: ${r1.stderr || r1.stdout}`);
  }
  if (!r2.stdout.includes('OK_W')) {
    throw new Error(`remote write thumb failed: ${r2.stderr || r2.stdout}`);
  }
}

/* ---------- read (per /api/blob) ---------- */

/** Legge un file dal remoto come Uint8Array (per servirlo via /api/blob).
 *  Usa base64 over stdout per evitare problemi con bytes non-printable. */
export async function readAttachmentRemote(
  remote: RemoteConfig,
  absPath: string,
  sshExec: (
    remote: RemoteConfig,
    cmd: string,
    stdin?: string,
    timeoutMs?: number,
  ) => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>,
): Promise<Uint8Array | null> {
  // `[ -f ]` per fast-fail con marker distinto da errore SSH.
  const cmd = `[ -f ${shellQuote(absPath)} ] && base64 ${shellQuote(absPath)} || echo NOFILE`;
  const r = await sshExec(remote, cmd, undefined, 30_000);
  const out = r.stdout.trim();
  if (out === 'NOFILE' || out.endsWith('NOFILE')) return null;
  if (!out) return null;
  try {
    return base64ToUint8(out);
  } catch {
    return null;
  }
}

/* ---------- prune ---------- */

/** Cancella i bucket year-month di `uploads/` più vecchi del cutoff.
 *  Le thumbnail non vengono mai toccate. */
export async function pruneOriginalsLocal(
  projectPath: string,
  retentionDays: number,
): Promise<{ deletedBuckets: number }> {
  const uploadsDir = path.join(projectPath, '.sublodex', 'uploads');
  let entries: string[];
  try {
    entries = await readdir(uploadsDir);
  } catch {
    return { deletedBuckets: 0 }; // dir inesistente: niente da fare
  }
  const cutoffYM = computeCutoffYearMonth(retentionDays);
  let deleted = 0;
  for (const name of entries) {
    if (!isYearMonthDir(name)) continue;
    if (name >= cutoffYM) continue; // string compare funziona su YYYY-MM
    const bucket = path.join(uploadsDir, name);
    try {
      const s = await stat(bucket);
      if (!s.isDirectory()) continue;
      await rm(bucket, { recursive: true, force: true });
      deleted++;
    } catch { /* ignoriamo errori per-bucket, andiamo avanti */ }
  }
  return { deletedBuckets: deleted };
}

export async function pruneOriginalsRemote(
  remote: RemoteConfig,
  projectPath: string,
  retentionDays: number,
  sshExec: (
    remote: RemoteConfig,
    cmd: string,
    stdin?: string,
    timeoutMs?: number,
  ) => Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>,
): Promise<{ deletedBuckets: number }> {
  const uploadsDir = `${projectPath}/.sublodex/uploads`;
  // ls -1 può fallire silently se la dir non esiste — `2>/dev/null || true`.
  const lsCmd = `ls -1 ${shellQuote(uploadsDir)} 2>/dev/null || true`;
  const lsResult = await sshExec(remote, lsCmd, undefined, 10_000);
  const cutoffYM = computeCutoffYearMonth(retentionDays);
  const buckets = lsResult.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(isYearMonthDir)
    .filter((name) => name < cutoffYM);
  if (buckets.length === 0) return { deletedBuckets: 0 };
  // rm -rf in un singolo comando: tutti i bucket in batch.
  const rmCmd = buckets
    .map((b) => `rm -rf ${shellQuote(`${uploadsDir}/${b}`)}`)
    .join(' && ');
  await sshExec(remote, rmCmd, undefined, 30_000);
  return { deletedBuckets: buckets.length };
}

function isYearMonthDir(name: string): boolean {
  return /^\d{4}-(?:0[1-9]|1[0-2])$/.test(name);
}

/** Calcola il bucket di cutoff: tutto STRETTAMENTE minore di questo viene
 *  cancellato. Se retention=30 e oggi è 2026-05-15, il cutoff è 2026-04
 *  (manteniamo aprile e maggio, cancelliamo marzo e prima). */
function computeCutoffYearMonth(retentionDays: number): string {
  const now = new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 3600 * 1000);
  return `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, '0')}`;
}

/* ---------- base64 helpers ---------- */
// Bun ha Buffer + atob/btoa, ma su Uint8Array nudo dobbiamo passare per
// l'interfaccia Buffer.from per essere safe sui byte non-ASCII.

function uint8ToBase64(u8: Uint8Array): string {
  return Buffer.from(u8).toString('base64');
}

function base64ToUint8(s: string): Uint8Array {
  // Filtra whitespace (newline introdotti da `base64` CLI ogni 76 char).
  const clean = s.replace(/\s+/g, '');
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

/** Helper per il content-type di /api/blob. */
export function mimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'png':  return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'gif':  return 'image/gif';
    default: return 'application/octet-stream';
  }
}

/** Decide se un path è un attachment legittimo (sotto .sublodex/uploads
 *  o .sublodex/thumbs). Usato da /api/blob come allow-list aggiuntiva oltre
 *  a resolveProjectPath, per non trasformare /api/blob in un file reader
 *  generico. */
export function isAttachmentRel(rel: string): boolean {
  // Normalizziamo separatori per Windows (backslash) → POSIX
  const norm = rel.replace(/\\/g, '/');
  return norm.startsWith('.sublodex/uploads/') || norm.startsWith('.sublodex/thumbs/');
}
