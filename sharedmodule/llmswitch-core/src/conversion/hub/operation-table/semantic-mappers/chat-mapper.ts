import type { SemanticMapper } from '../../format-adapters/index.js';
import type {
  AdapterContext,
  ChatEnvelope,
} from '../../types/chat-envelope.js';
import type { FormatEnvelope } from '../../types/format-envelope.js';
import { isHubStageTimingDetailEnabled, logHubStageTiming } from '../../pipeline/hub-stage-timing.js';
import {
  mapOpenaiChatFromChatWithNative,
  mapOpenaiChatToChatWithNative
} from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-semantic-mappers.js';
import {
  maybeAugmentApplyPatchErrorContent,
  tryMapOpenaiChatToChatFast,
  type ChatPayload
} from './chat-mapper-fastpath.js';

export { maybeAugmentApplyPatchErrorContent };

export class ChatSemanticMapper implements SemanticMapper {
  async toChat(format: FormatEnvelope, ctx: AdapterContext): Promise<ChatEnvelope> {
    const payload = (format.payload ?? {}) as ChatPayload;
    const fastMapped = tryMapOpenaiChatToChatFast(payload, ctx);
    if (fastMapped) {
      return fastMapped;
    }
    return mapOpenaiChatToChatWithNative(
      payload as Record<string, unknown>,
      ctx as unknown as Record<string, unknown>
    ) as unknown as ChatEnvelope;
  }

  async fromChat(chat: ChatEnvelope, ctx: AdapterContext): Promise<FormatEnvelope> {
    const requestId = typeof ctx.requestId === 'string' && ctx.requestId.trim().length ? ctx.requestId : 'unknown';
    const forceDetailLog = isHubStageTimingDetailEnabled();
    logHubStageTiming(requestId, 'req_outbound.chat.build_request', 'start');
    const startedAt = Date.now();
    const result = mapOpenaiChatFromChatWithNative(
      chat as unknown as Record<string, unknown>,
      ctx as unknown as Record<string, unknown>
    ) as unknown as FormatEnvelope;
    logHubStageTiming(requestId, 'req_outbound.chat.build_request', 'completed', {
      elapsedMs: Date.now() - startedAt,
      forceLog: forceDetailLog
    });
    return result;
  }
}
