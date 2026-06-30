import type { GeminiSseEvent } from '../../types/index.js';

export function serializeGeminiEventToSSE(event: GeminiSseEvent): string {
  const payload = event.data ?? {};
  const eventType = event.event ?? event.type;
  if (typeof eventType !== 'string' || !eventType.trim()) {
    throw new Error('Invalid Gemini SSE event: missing event type');
  }
  return [`event: ${eventType}`, `data: ${JSON.stringify(payload)}`].join('\n') + '\n\n';
}
