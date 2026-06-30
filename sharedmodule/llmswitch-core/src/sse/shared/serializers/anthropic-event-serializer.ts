import type { AnthropicSseEvent } from '../../types/index.js';

export function serializeAnthropicEventToSSE(event: AnthropicSseEvent): string {
  const payload = event.data ?? {};
  const type = event.event || event.type;
  if (typeof type !== 'string' || !type.trim()) {
    throw new Error('Invalid Anthropic SSE event: missing event type');
  }

  return [`event: ${type}`, `data: ${JSON.stringify(payload)}`].join('\n') + '\n\n';
}
