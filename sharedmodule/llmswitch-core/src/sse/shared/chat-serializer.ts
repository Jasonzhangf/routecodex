// feature_id: sse.chat_stream_projection
import type { ChatSseEvent } from '../types/index.js';

// Serialize an internal ChatSseEvent (object-mode) to SSE wire frames
export function serializeChatEventToSSE(evt: ChatSseEvent): string {
  const lines: string[] = [];
  if (typeof evt.data === 'string') lines.push(`data: ${evt.data}`);
  else lines.push(`data: ${JSON.stringify(evt.data ?? {})}`);
  return lines.join('\n') + '\n\n';
}
