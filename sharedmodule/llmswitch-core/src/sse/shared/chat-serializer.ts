import { PassThrough, Readable } from 'node:stream';
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

// Convert a Readable of ChatSseEvent objects into a text SSE stream
export function toSSETextStream(objectEventStream: Readable): PassThrough {
  const out = new PassThrough();
  (async () => {
    try {
      for await (const evt of objectEventStream as any as AsyncIterable<ChatSseEvent>) {
        const frame = serializeChatEventToSSE(evt);
        if (!out.write(frame)) await new Promise(r => out.once('drain', r));
      }
    } catch {
      // emit minimal error frame, then close
      try { out.write('data: {"error":"chat sse serialization failed"}\n\n'); } catch { /* ignore */ }
    } finally {
      try { out.end(); } catch { /* ignore */ }
    }
  })();
  return out;
}
