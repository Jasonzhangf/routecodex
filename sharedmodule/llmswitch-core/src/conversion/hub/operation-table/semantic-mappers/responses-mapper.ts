import type { SemanticMapper } from '../../format-adapters/index.js';
import type { AdapterContext, ChatEnvelope } from '../../types/chat-envelope.js';
import type { FormatEnvelope } from '../../types/format-envelope.js';
import type { ResponsesPayload } from './responses-mapper-config.js';
import { buildResponsesChatEnvelopeFromPayload } from './responses-mapper-to-chat.js';
import { buildResponsesFormatEnvelopeFromChat } from './responses-mapper-from-chat.js';

export type { ResponsesPayload };
export {
  attachResponsesSemantics,
  mapToolOutputs,
  normalizeMessages,
  normalizeTools,
  readResponsesRequestParametersFromSemantics,
  selectResponsesContextSnapshot,
  serializeSystemContent,
} from './responses-mapper-helpers.js';

export class ResponsesSemanticMapper implements SemanticMapper {
  async toChat(format: FormatEnvelope<ResponsesPayload>, ctx: AdapterContext): Promise<ChatEnvelope> {
    return await buildResponsesChatEnvelopeFromPayload(format, ctx);
  }

  async fromChat(chat: ChatEnvelope, ctx: AdapterContext): Promise<FormatEnvelope> {
    return await buildResponsesFormatEnvelopeFromChat(chat, ctx);
  }
}
