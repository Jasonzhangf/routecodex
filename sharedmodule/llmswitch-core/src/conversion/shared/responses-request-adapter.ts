import {
  buildChatRequestFromResponses as buildChatRequestFromResponsesImpl,
  captureResponsesContext as captureResponsesContextImpl
} from '../responses/responses-openai-bridge.js';
import type {
  BuildChatRequestResult,
  ResponsesRequestContext
} from '../responses/responses-openai-bridge/types.js';
import { normalizeProviderProtocolTokenWithNative } from '../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

function assertResponsesNativeBoundary(): void {
  // Keep adapter as a thin boundary while forcing native capability presence.
  normalizeProviderProtocolTokenWithNative('openai-responses');
}

export function captureResponsesContext(
  payload: Record<string, unknown>,
  dto?: { route?: { requestId?: string } }
): ResponsesRequestContext {
  assertResponsesNativeBoundary();
  return captureResponsesContextImpl(payload, dto);
}

export function buildChatRequestFromResponses(
  payload: Record<string, unknown>,
  context: ResponsesRequestContext
): BuildChatRequestResult {
  assertResponsesNativeBoundary();
  return buildChatRequestFromResponsesImpl(payload, context);
}
