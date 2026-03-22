import type { SemanticMapper } from '../../format-adapters/index.js';
import type {
  AdapterContext,
  ChatEnvelope,
} from '../../types/chat-envelope.js';
import type { FormatEnvelope } from '../../types/format-envelope.js';
import { isHubStageTimingDetailEnabled, logHubStageTiming } from '../../pipeline/hub-stage-timing.js';
import type { GeminiPayload } from './gemini-antigravity-request.js';
import { buildGeminiChatEnvelopeFromGeminiPayload } from './gemini-mapper-to-chat.js';
import { buildGeminiRequestFromChat } from './gemini-mapper-from-chat.js';

export { buildGeminiRequestFromChat };

export class GeminiSemanticMapper implements SemanticMapper {
  async toChat(format: FormatEnvelope, ctx: AdapterContext): Promise<ChatEnvelope> {
    const payload = (format.payload ?? {}) as GeminiPayload;
    return buildGeminiChatEnvelopeFromGeminiPayload(payload, ctx);
  }

  async fromChat(chat: ChatEnvelope, ctx: AdapterContext): Promise<FormatEnvelope> {
    const requestId = typeof ctx.requestId === 'string' && ctx.requestId.trim().length ? ctx.requestId : 'unknown';
    const forceDetailLog = isHubStageTimingDetailEnabled();
    logHubStageTiming(requestId, 'req_outbound.gemini.build_request', 'start');
    const startedAt = Date.now();
    const envelopePayload = buildGeminiRequestFromChat(chat, chat.metadata) as GeminiPayload;
    logHubStageTiming(requestId, 'req_outbound.gemini.build_request', 'completed', {
      elapsedMs: Date.now() - startedAt,
      forceLog: forceDetailLog
    });
    return {
      protocol: 'gemini-chat',
      direction: 'response',
      payload: envelopePayload,
      meta: {
        context: ctx
      }
    };
  }
}
