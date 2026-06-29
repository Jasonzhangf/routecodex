import type { AdapterContext } from '../types/chat-envelope.js';
import { planChatProcessSessionUsage } from '../../../native/router-hotpath/native-virtual-router-routing-state.js';

export function saveChatProcessSessionActualUsage(options: {
  context: AdapterContext;
  usage: Record<string, unknown> | undefined;
}): void {
  const capturedChatRequest = (options.context as { capturedChatRequest?: unknown }).capturedChatRequest;
  planChatProcessSessionUsage({
    context: options.context as unknown as Record<string, unknown>,
    usage: options.usage,
    capturedChatRequest:
      capturedChatRequest && typeof capturedChatRequest === 'object' && !Array.isArray(capturedChatRequest)
        ? (capturedChatRequest as Record<string, unknown>)
        : undefined
  });
}
