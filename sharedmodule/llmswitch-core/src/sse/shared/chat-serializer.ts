import type { ChatSseEvent } from '../types/index.js';

// Serialize an internal ChatSseEvent (object-mode) to SSE wire frames
export function serializeChatEventToSSE(evt: ChatSseEvent): string {
  const lines: string[] = [];
  // Standard SSE fields
  if (evt.event) lines.push(`event: ${evt.event}`);
  if (typeof evt.data === 'string') lines.push(`data: ${evt.data}`);
  else lines.push(`data: ${JSON.stringify(evt.data ?? {})}`);
  return lines.join('\n') + '\n\n';
}
