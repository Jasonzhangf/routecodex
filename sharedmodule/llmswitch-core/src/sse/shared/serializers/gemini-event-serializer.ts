import type { GeminiSseEvent } from '../../types/index.js';

export function serializeGeminiEventToSSE(event: GeminiSseEvent): string {
  const payload = event.data ?? {};
  const eventType = event.event ?? event.type ?? 'gemini.data';
  return [`event: ${eventType}`, `data: ${JSON.stringify(payload)}`].join('\n') + '\n\n';
}
