import type { AnthropicSseEvent } from '../../types/index.js';

export function serializeAnthropicEventToSSE(event: AnthropicSseEvent): string {
  const payload = event.data ?? {};
  const type =
    event.event ||
    event.type ||
    (typeof (payload as Record<string, unknown>)?.type === 'string'
      ? (payload as Record<string, string>).type
      : 'message');

  return [`event: ${type}`, `data: ${JSON.stringify(payload)}`].join('\n') + '\n\n';
}
