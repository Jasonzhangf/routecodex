import type {
  StandardizedRequest
} from './types/standardized.js';
import type {
  AdapterContext,
  ChatEnvelope
} from './types/chat-envelope.js';
import type { JsonObject } from './types/json.js';
import {
  chatEnvelopeToStandardizedWithNative
} from '../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';
import {
  standardizedToChatEnvelopeWithNative
} from '../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';

export interface ChatToStandardizedOptions {
  adapterContext: AdapterContext;
  endpoint: string;
  requestId?: string;
}

export interface StandardizedToChatOptions {
  adapterContext: AdapterContext;
}

export function chatEnvelopeToStandardized(
  chat: ChatEnvelope,
  options: ChatToStandardizedOptions
): StandardizedRequest {
  return chatEnvelopeToStandardizedWithNative({
    chatEnvelope: chat as unknown as Record<string, unknown>,
    adapterContext: options.adapterContext as unknown as Record<string, unknown>,
    endpoint: options.endpoint,
    requestId: options.requestId
  }) as unknown as StandardizedRequest;
}

export function standardizedToChatEnvelope(
  request: StandardizedRequest,
  options: StandardizedToChatOptions
): ChatEnvelope {
  return standardizedToChatEnvelopeWithNative({
    request: request as unknown as JsonObject,
    adapterContext: options.adapterContext as unknown as Record<string, unknown>
  }) as unknown as ChatEnvelope;
}
