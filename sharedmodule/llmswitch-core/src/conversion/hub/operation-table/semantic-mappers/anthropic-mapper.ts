import type { SemanticMapper } from '../../format-adapters/index.js';
import type { AdapterContext, ChatEnvelope } from '../../types/chat-envelope.js';
import type { FormatEnvelope } from '../../types/format-envelope.js';
import { isHubStageTimingDetailEnabled, logHubStageTiming } from '../../pipeline/hub-stage-timing.js';
import { ChatSemanticMapper } from './chat-mapper.js';
import {
  type AnthropicPayload,
  sanitizeAnthropicPayload,
} from './anthropic-mapper-config.js';
import { buildAnthropicChatEnvelopeFromPayload } from './anthropic-mapper-to-chat.js';
import { buildAnthropicFormatEnvelopeFromChat } from './anthropic-mapper-from-chat.js';

export { sanitizeAnthropicPayload };

export class AnthropicSemanticMapper implements SemanticMapper {
  private readonly chatMapper = new ChatSemanticMapper();

  async toChat(format: FormatEnvelope, ctx: AdapterContext): Promise<ChatEnvelope> {
    const payload = (format.payload ?? {}) as AnthropicPayload;
    return await buildAnthropicChatEnvelopeFromPayload(payload, ctx, this.chatMapper);
  }

  async fromChat(chat: ChatEnvelope, ctx: AdapterContext): Promise<FormatEnvelope> {
    const requestId = typeof ctx.requestId === 'string' && ctx.requestId.trim().length ? ctx.requestId : 'unknown';
    const forceDetailLog = isHubStageTimingDetailEnabled();
    logHubStageTiming(requestId, 'req_outbound.anthropic.build_request', 'start');
    const startedAt = Date.now();
    const result = buildAnthropicFormatEnvelopeFromChat(chat, ctx);
    logHubStageTiming(requestId, 'req_outbound.anthropic.build_request', 'completed', {
      elapsedMs: Date.now() - startedAt,
      forceLog: forceDetailLog
    });
    return result;
  }
}
