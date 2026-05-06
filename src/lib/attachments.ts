/**
 * Client-side helpers per gli attachments immagine del Composer.
 *
 * Pipeline tipica:
 *  1. utente fa drop / paste / click → un File arriva qui
 *  2. validateImageFile() → throw se mime/size non vanno
 *  3. makeThumbnail(file)  → Blob webp 512px lato lungo + dimensioni originali
 *  4. uploadAttachment()    → POST /api/upload → Attachment server-side
 *  5. il Composer lo aggiunge a sendPrompt(text, attachments)
 *
 * Le thumbnail si generano CLIENT-side per evitare di portarsi dietro Sharp
 * o altre native libs sul server (problematico nel bundle Tauri). Niente
 * dipendenze npm: usiamo solo le API browser standard.
 */

import { getAuthToken } from './auth';
import type { Attachment } from './types';

/* ---------- limiti & costanti (allineati al server) ---------- */

export const ALLOWED_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
export const MAX_BYTES = 5 * 1024 * 1024;
export const THUMB_MAX_SIDE = 512;
export const THUMB_QUALITY = 0.78;

/* ---------- types ---------- */

export type PendingAttachment = {
  /** id locale per la chiave React, sostituito dall'`Attachment.id` server-side
   *  dopo l'upload. Non confondere con `uploaded.id`. */
  localId: string;
  file: File;
  thumbnailBlob: Blob;
  /** ObjectURL della thumbnail per l'anteprima nel Composer. Va revocato
   *  quando l'attachment viene rimosso (vedi `revokePending`). */
  previewUrl: string;
  /** Dimensioni dell'IMMAGINE ORIGINALE (non della thumbnail) */
  width: number;
  height: number;
  status: 'idle' | 'uploading' | 'done' | 'error';
  /** Popolato a upload completato. */
  uploaded?: Attachment;
  errorMsg?: string;
};

/* ---------- validazione ---------- */

export class ImageValidationError extends Error {
  constructor(message: string, public reason: 'mime' | 'size' | 'empty') {
    super(message);
    this.name = 'ImageValidationError';
  }
}

/** Fail-fast lato client. Identica logica al server (defense-in-depth). */
export function validateImageFile(file: File): void {
  if (!ALLOWED_MIMES.has(file.type)) {
    throw new ImageValidationError(
      `formato non supportato: ${file.type || 'sconosciuto'} — accettati png/jpeg/webp/gif`,
      'mime',
    );
  }
  if (file.size === 0) {
    throw new ImageValidationError('file vuoto', 'empty');
  }
  if (file.size > MAX_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    throw new ImageValidationError(`troppo grande: ${mb}MB (max 5MB)`, 'size');
  }
}

/* ---------- thumbnail ---------- */

/** Genera una thumbnail WebP a `maxSide` px sul lato lungo, preservando il ratio.
 *
 *  Strategia:
 *    1. createImageBitmap(file) → decodifica in worker pool nativo del browser
 *    2. OffscreenCanvas (con fallback HTMLCanvas su Safari < 16.4)
 *    3. drawImage scalato + convertToBlob({ type: 'image/webp', quality: 0.78 })
 *
 *  Per i GIF animati prendiamo solo il primo frame — sufficiente come preview.
 *  L'originale animato passa intatto a Claude.
 *
 *  Ritorna anche le dimensioni ORIGINALI dell'immagine (servono al renderer
 *  per fissare width/height sull'<img> e prevenire CLS). */
export async function makeThumbnail(file: File, maxSide = THUMB_MAX_SIDE): Promise<{
  blob: Blob;
  width: number;
  height: number;
}> {
  const bitmap = await createImageBitmap(file);
  const origW = bitmap.width;
  const origH = bitmap.height;
  const ratio = Math.min(1, maxSide / Math.max(origW, origH));
  const tw = Math.max(1, Math.round(origW * ratio));
  const th = Math.max(1, Math.round(origH * ratio));

  let blob: Blob;
  if (typeof OffscreenCanvas !== 'undefined' && 'convertToBlob' in OffscreenCanvas.prototype) {
    const canvas = new OffscreenCanvas(tw, th);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      throw new Error('cannot get OffscreenCanvas 2d context');
    }
    ctx.drawImage(bitmap, 0, 0, tw, th);
    blob = await canvas.convertToBlob({ type: 'image/webp', quality: THUMB_QUALITY });
  } else {
    // Fallback per Safari < 16.4: HTMLCanvasElement.toBlob.
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      throw new Error('cannot get canvas 2d context');
    }
    ctx.drawImage(bitmap, 0, 0, tw, th);
    blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
        'image/webp',
        THUMB_QUALITY,
      );
    });
  }
  bitmap.close();
  return { blob, width: origW, height: origH };
}

/* ---------- upload ---------- */

/** POST /api/upload con multipart. L'auth token viene aggiunto
 *  automaticamente dal monkey-patch in lib/auth.ts. */
export async function uploadAttachment(
  projectId: string,
  file: File,
  thumbnail: Blob,
  width: number,
  height: number,
): Promise<Attachment> {
  const fd = new FormData();
  fd.append('original', file, file.name || 'image');
  // Forziamo il filename della thumbnail: alcuni server reject blob senza nome.
  fd.append('thumb', thumbnail, 'thumb.webp');
  fd.append('width', String(width));
  fd.append('height', String(height));
  const res = await fetch(`/api/upload?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: fd,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`upload failed (${res.status}): ${text}`);
  }
  return (await res.json()) as Attachment;
}

/* ---------- helpers extraction (drop / paste / file picker) ---------- */
/* Tre funzioni esplicite invece di una "smart" che indovina il tipo: il
 * runtime browser non ci permette di distinguere FileList da
 * DataTransferItemList in modo affidabile (entrambe hanno solo `length`),
 * quindi facciamo branch lato chiamante. */

/** Da `<input type="file">` change event. */
export function imagesFromFileList(fl: FileList | null | undefined): File[] {
  if (!fl) return [];
  const out: File[] = [];
  for (let i = 0; i < fl.length; i++) {
    const f = fl[i];
    if (f && f.type.startsWith('image/')) out.push(f);
  }
  return out;
}

/** Da `dragover`/`drop` event (`e.dataTransfer`). Prefer `.files` (drop di
 *  file da explorer) e fallback su `.items` per immagini "embed" trascinate
 *  da pagine web (raro ma succede). */
export function imagesFromDataTransfer(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  if (dt.files && dt.files.length > 0) return imagesFromFileList(dt.files);
  return imagesFromDataTransferItems(dt.items);
}

/** Da `paste` event (`e.clipboardData.items`) o `dataTransfer.items`.
 *  Itera DataTransferItem prendendo solo `kind === 'file'` con mime image/*. */
export function imagesFromDataTransferItems(
  items: DataTransferItemList | null | undefined,
): File[] {
  if (!items) return [];
  const out: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

/* ---------- /api/blob URL builder ---------- */

/** Costruisce l'URL per `<img src>` di una thumbnail / originale.
 *  Il token viene messo in query string: le `<img>` non passano per
 *  window.fetch e quindi il monkey-patch non aggancia l'header.
 *
 *  Il path è il `Attachment.thumbnailPath` o `originalPath` (entrambi
 *  relativi al project root). */
export function blobUrl(projectId: string, relPath: string): string {
  const params = new URLSearchParams({ projectId, path: relPath });
  const token = getAuthToken();
  if (token) params.set('token', token);
  return `/api/blob?${params.toString()}`;
}

/* ---------- pipeline end-to-end ---------- */

/** Flusso completo per un singolo File: validazione + thumbnail + upload.
 *  Il Composer chiama questa per ogni file droppato/incollato/scelto.
 *
 *  Il caller deve pre-creare un PendingAttachment con `status: 'uploading'`
 *  per mostrare lo spinner; questa funzione ritorna l'Attachment finale
 *  (server-side) o lancia un errore. */
export async function processAndUpload(
  projectId: string,
  file: File,
): Promise<{ uploaded: Attachment; thumbnail: Blob; width: number; height: number }> {
  validateImageFile(file);
  const { blob: thumbnail, width, height } = await makeThumbnail(file);
  const uploaded = await uploadAttachment(projectId, file, thumbnail, width, height);
  return { uploaded, thumbnail, width, height };
}

/** Revoca l'objectURL di una preview pendente. Da chiamare quando
 *  l'attachment viene rimosso o il messaggio inviato. */
export function revokePending(p: PendingAttachment): void {
  try { URL.revokeObjectURL(p.previewUrl); } catch { /* best effort */ }
}
