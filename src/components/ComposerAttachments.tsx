/**
 * Chip di preview degli attachments in fase di compose.
 *
 * Mostra una thumbnail 48x48 + nome troncato + remove. Stato visuale:
 *   - uploading → bordo accent + spinner
 *   - error     → bordo red + tooltip con messaggio
 *   - done      → bordo neutro
 *
 * NB: questo è il chip nella COMPOSER bar (pre-send). Per il render delle
 * immagini nei messaggi già inviati c'è MessageAttachment in Message.tsx
 * (Fase 5).
 */

import type { PendingAttachment } from '../lib/attachments';

export function ComposerAttachmentChip({
  att,
  onRemove,
}: {
  att: PendingAttachment;
  onRemove: () => void;
}) {
  const cls =
    'composer-att' +
    (att.status === 'uploading' ? ' composer-att--uploading' : '') +
    (att.status === 'error' ? ' composer-att--error' : '');

  const label = att.file.name && att.file.name.length > 0
    ? att.file.name
    : `screenshot.${(att.file.type.split('/')[1] ?? 'png')}`;

  const sizeKb = (att.file.size / 1024).toFixed(0);
  const tooltip =
    att.status === 'error'
      ? att.errorMsg || 'Errore upload'
      : `${label} · ${sizeKb} KB · ${att.width}×${att.height}`;

  return (
    <div className={cls} title={tooltip}>
      <img
        className="composer-att__thumb"
        src={att.previewUrl}
        alt=""
        width={40}
        height={40}
        draggable={false}
      />
      <div className="composer-att__meta">
        <div className="composer-att__name">{label}</div>
        <div className="composer-att__sub">
          {att.status === 'uploading' && 'Caricamento…'}
          {att.status === 'error' && (att.errorMsg || 'Errore')}
          {att.status === 'done' && `${sizeKb} KB`}
          {att.status === 'idle' && `${sizeKb} KB`}
        </div>
      </div>
      <button
        className="composer-att__remove"
        onClick={onRemove}
        title="Rimuovi allegato"
        type="button"
      >
        ✕
      </button>
    </div>
  );
}
