import type { UIMessage } from '../lib/types';
import { useSettings, activeProject } from '../lib/settings';
import { Markdown } from './Markdown';
import { ToolCall } from './ToolCall';
import { UsageCard } from './UsageCard';
import { MessageAttachments } from './MessageAttachments';

export function Message({ message }: { message: UIMessage }) {
  const settings = useSettings((s) => s.settings);
  const project = activeProject(settings);

  if (message.role === 'system') {
    return (
      <div className="msg msg--system">
        <div className="msg__role">system</div>
        <div className="msg__body">
          {message.blocks.map((block, i) => {
            if (block.kind === 'text') {
              return <pre key={i} className="msg__system-text">{block.text}</pre>;
            }
            if (block.kind === 'usage') {
              return <UsageCard key={i} data={block.data} />;
            }
            return null;
          })}
        </div>
      </div>
    );
  }

  return (
    <div className={`msg msg--${message.role}`}>
      <div className="msg__role">{message.role === 'user' ? 'you' : 'claude'}</div>
      <div className="msg__body">
        {/* Allegati immagine: solo lato user. Renderizzati PRIMA del testo
            così l'utente vede il contesto visivo del messaggio. Il path
            passato a Claude è già nel testo del prompt (vedi ws.ts). */}
        {message.role === 'user' && message.attachments && message.attachments.length > 0 && project && (
          <MessageAttachments
            projectId={project.id}
            attachments={message.attachments}
          />
        )}
        {message.blocks.map((block, i) => {
          if (block.kind === 'text') {
            return message.role === 'user' ? (
              <div key={i} className="msg__user-text">{block.text}</div>
            ) : (
              <Markdown key={i}>{block.text}</Markdown>
            );
          }
          if (block.kind === 'tool') {
            return <ToolCall key={block.id} block={block} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}
