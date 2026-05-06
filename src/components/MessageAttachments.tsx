/**
 * Render degli attachments dentro i messaggi utente in scrollback.
 *
 * Strategy:
 *  - Inline: thumbnail (~240×200 max) caricata da `/api/blob` con il
 *    `thumbnailPath`. Click → apre il lightbox.
 *  - Lightbox: prova prima a caricare l'ORIGINALE (`originalPath`); se 404
 *    (originale pruned dal cron > 30gg), fallback alla thumbnail con un
 *    badge "originale archiviato".
 *
 *  Le thumbnail sono keep-forever, gli originali sono pruned ogni 7gg sui
 *  bucket year-month più vecchi di 30gg. Vedi src-server/attachments.ts.
 */

import { useEffect, useState } from 'react';
import type { Attachment } from '../lib/types';
import { blobUrl } from '../lib/attachments';

export function MessageAttachments({
  projectId,
  attachments,
}: {
  projectId: string;
  attachments: Attachment[];
}) {
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  return (
    <>
      <div className="msg-atts">
        {attachments.map((a, i) => (
          <MessageAttachmentThumb
            key={a.id}
            projectId={projectId}
            att={a}
            onClick={() => setLightboxIdx(i)}
          />
        ))}
      </div>
      {lightboxIdx !== null && (
        <Lightbox
          projectId={projectId}
          attachments={attachments}
          startIdx={lightboxIdx}
          onClose={() => setLightboxIdx(null)}
        />
      )}
    </>
  );
}

function MessageAttachmentThumb({
  projectId,
  att,
  onClick,
}: {
  projectId: string;
  att: Attachment;
  onClick: () => void;
}) {
  const tooltip = [
    att.filename || 'immagine',
    `${(att.size / 1024).toFixed(0)} KB`,
    att.width && att.height ? `${att.width}×${att.height}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <button
      type="button"
      className="msg-att"
      onClick={onClick}
      title={tooltip}
    >
      <img
        className="msg-att__img"
        src={blobUrl(projectId, att.thumbnailPath)}
        alt={att.filename || 'immagine'}
        width={att.width}
        height={att.height}
        loading="lazy"
        draggable={false}
      />
    </button>
  );
}

/** Lightbox: prova a caricare l'originale, fallback alla thumbnail.
 *  Naviga con frecce / Esc chiude. */
function Lightbox({
  projectId,
  attachments,
  startIdx,
  onClose,
}: {
  projectId: string;
  attachments: Attachment[];
  startIdx: number;
  onClose: () => void;
}) {
  const [idx, setIdx] = useState(startIdx);
  const [origMissing, setOrigMissing] = useState(false);
  const att = attachments[idx];

  // Reset dello stato "missing" quando cambio immagine.
  useEffect(() => { setOrigMissing(false); }, [idx]);

  // Tastiera: Esc / ← / →
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && idx > 0) setIdx(idx - 1);
      else if (e.key === 'ArrowRight' && idx < attachments.length - 1) setIdx(idx + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [idx, attachments.length, onClose]);

  if (!att) return null;

  // Se l'originale non c'è più, mostriamo la thumb con un badge informativo.
  // 404 sul thumbnail invece sarebbe un bug grave (la thumb è keep-forever):
  // mostriamo comunque un placeholder testuale.
  const src = origMissing
    ? blobUrl(projectId, att.thumbnailPath)
    : blobUrl(projectId, att.originalPath);

  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true">
      <button
        className="lightbox__close"
        onClick={onClose}
        aria-label="chiudi"
        type="button"
      >
        ✕
      </button>
      {idx > 0 && (
        <button
          className="lightbox__nav lightbox__nav--prev"
          onClick={(e) => { e.stopPropagation(); setIdx(idx - 1); }}
          aria-label="precedente"
          type="button"
        >
          ‹
        </button>
      )}
      {idx < attachments.length - 1 && (
        <button
          className="lightbox__nav lightbox__nav--next"
          onClick={(e) => { e.stopPropagation(); setIdx(idx + 1); }}
          aria-label="successiva"
          type="button"
        >
          ›
        </button>
      )}
      <div className="lightbox__inner" onClick={(e) => e.stopPropagation()}>
        <img
          className="lightbox__img"
          src={src}
          alt={att.filename || 'immagine'}
          onError={() => {
            // Errore sull'originale: passa alla thumb (defense-in-depth: se la
            // thumb non c'è nemmeno, l'<img> resta vuota — caso bordo che non
            // dovrebbe accadere mai).
            if (!origMissing) setOrigMissing(true);
          }}
        />
        <div className="lightbox__caption">
          {origMissing && (
            <span className="lightbox__badge">archiviata · solo thumbnail</span>
          )}
          <span className="lightbox__filename">{att.filename || `immagine ${idx + 1}/${attachments.length}`}</span>
          {att.width && att.height && (
            <span className="lightbox__dim">{att.width}×{att.height}</span>
          )}
        </div>
      </div>
    </div>
  );
}
