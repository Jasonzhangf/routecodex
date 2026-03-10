import type { ChatEnvelope } from '../hub/types/chat-envelope.js';
import { validateChatEnvelopeWithNative } from '../../router/virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.js';

export type ChatValidationStage = 'req_inbound' | 'req_outbound' | 'resp_inbound' | 'resp_outbound';

export interface ChatEnvelopeValidationOptions {
  stage: ChatValidationStage;
  direction: 'request' | 'response';
  source?: string;
}

export function validateChatEnvelope(chat: ChatEnvelope, options: ChatEnvelopeValidationOptions): void {
  validateChatEnvelopeWithNative(chat, options);
}
