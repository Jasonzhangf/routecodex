import type { ProcessedRequest } from '../types/standardized.js';
import { buildProcessedRequestFromChatResponseWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-node-result-semantics.js';

interface BuildProcessedRequestOptions {
  stream?: boolean;
}

export function buildProcessedRequestFromChatResponse(
  chatResponse: any,
  options?: BuildProcessedRequestOptions
): ProcessedRequest {
  const streamingEnabled = options?.stream === true;
  const payload =
    chatResponse && typeof chatResponse === 'object' && !Array.isArray(chatResponse)
      ? (chatResponse as Record<string, unknown>)
      : ({ choices: [] } as Record<string, unknown>);
  return buildProcessedRequestFromChatResponseWithNative(payload, streamingEnabled) as unknown as ProcessedRequest;
}
