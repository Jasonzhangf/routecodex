import type { AdapterContext, ChatEnvelope } from '../../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { StandardizedRequest } from '../../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js';
import { chatEnvelopeToStandardizedWithNative } from '../../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-inbound-semantics.js';
import { standardizedToChatEnvelopeWithNative } from '../../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-req-outbound-semantics.js';

export function chatEnvelopeToStandardizedDirectNative(
  chat: ChatEnvelope,
  options: { adapterContext: AdapterContext; endpoint: string; requestId?: string },
): StandardizedRequest {
  return chatEnvelopeToStandardizedWithNative({
    chatEnvelope: chat as unknown as Record<string, unknown>,
    adapterContext: options.adapterContext as unknown as Record<string, unknown>,
    endpoint: options.endpoint,
    requestId: options.requestId,
  }) as unknown as StandardizedRequest;
}

export function standardizedToChatEnvelopeDirectNative(
  request: StandardizedRequest,
  options: { adapterContext: AdapterContext },
): ChatEnvelope {
  return standardizedToChatEnvelopeWithNative({
    request: request as unknown as Record<string, unknown>,
    adapterContext: options.adapterContext as unknown as Record<string, unknown>,
  }) as unknown as ChatEnvelope;
}
