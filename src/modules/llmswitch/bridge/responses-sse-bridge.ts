/**
 * /v1/responses SSE-side handler bridge surface.
 *
 * Dedicated SSE transport-facing facade for responses SSE/JSON streaming
 * behaviors. Lifecycle persistence stays in responses-response-bridge.ts.
 */

// feature_id: server.responses_sse_bridge_surface
// canonical_builders: shouldDispatchResponsesSseToClientForHttp, resolveResponsesRequestContextForHttp, buildResponsesSseErrorPayloadForHttp, buildResponsesStructuredSseErrorPayloadForHttp, buildResponsesMissingSseBridgeErrorPayloadForHttp, createResponsesJsonToSseConverterForHttp, prepareResponsesJsonBodyForSseBridgeForHttp, buildResponsesPayloadFromChatForHttp

import type { ResponsesRequestContextForHttp } from './responses-response-bridge.js';
import {
  buildResponsesMissingSseBridgeErrorPayloadForHttp as buildResponsesMissingSseBridgeErrorPayloadForHttpImpl,
  buildResponsesPayloadFromChatForHttp as buildResponsesPayloadFromChatForHttpImpl,
  buildResponsesRequestLogContextForHttp as buildResponsesRequestLogContextForHttpImpl,
  buildResponsesSseErrorPayloadForHttp as buildResponsesSseErrorPayloadForHttpImpl,
  buildResponsesStructuredSseErrorPayloadForHttp as buildResponsesStructuredSseErrorPayloadForHttpImpl,
  createChatJsonToSseConverterForHttp as createChatJsonToSseConverterForHttpImpl,
  importResponsesHandlerCoreDist as importResponsesHandlerCoreDistImpl,
  normalizeChatUsagePayloadForHttp as normalizeChatUsagePayloadForHttpImpl,
  prepareResponsesJsonClientDispatchPlanForHttp as prepareResponsesJsonClientDispatchPlanForHttpImpl,
  prepareResponsesJsonSseDispatchPlanForHttp as prepareResponsesJsonSseDispatchPlanForHttpImpl,
  requireResponsesHandlerCoreDist as requireResponsesHandlerCoreDistImpl,
  resolveResponsesRequestContextForHttp as resolveResponsesRequestContextForHttpImpl,
  resolveRelayResponsesClientSseStreamForHttp as resolveRelayResponsesClientSseStreamForHttpImpl,
  shouldDispatchResponsesSseToClientForHttp as shouldDispatchResponsesSseToClientForHttpImpl,
  shouldReprojectRelayResponsesSseForHttp as shouldReprojectRelayResponsesSseForHttpImpl,
} from './responses-response-bridge.js';
import {
  buildClientSseKeepaliveFrameForHttp as buildClientSseKeepaliveFrameForHttpImpl,
  createResponsesJsonToSseConverterForHttp as createResponsesJsonToSseConverterForHttpImpl,
  shouldDropClientSseFrameForHttp as shouldDropClientSseFrameForHttpImpl,
} from './responses-sse-transport.js';

export type { ResponsesRequestContextForHttp };

export const buildClientSseKeepaliveFrameForHttp = buildClientSseKeepaliveFrameForHttpImpl;
export const buildResponsesMissingSseBridgeErrorPayloadForHttp = buildResponsesMissingSseBridgeErrorPayloadForHttpImpl;
export const buildResponsesPayloadFromChatForHttp = buildResponsesPayloadFromChatForHttpImpl;
export const buildResponsesRequestLogContextForHttp = buildResponsesRequestLogContextForHttpImpl;
export const buildResponsesSseErrorPayloadForHttp = buildResponsesSseErrorPayloadForHttpImpl;
export const buildResponsesStructuredSseErrorPayloadForHttp = buildResponsesStructuredSseErrorPayloadForHttpImpl;
export const createChatJsonToSseConverterForHttp = createChatJsonToSseConverterForHttpImpl;
export const createResponsesJsonToSseConverterForHttp = createResponsesJsonToSseConverterForHttpImpl;
export const importResponsesHandlerCoreDist = importResponsesHandlerCoreDistImpl;
export const normalizeChatUsagePayloadForHttp = normalizeChatUsagePayloadForHttpImpl;
export const prepareResponsesJsonClientDispatchPlanForHttp = prepareResponsesJsonClientDispatchPlanForHttpImpl;
export const prepareResponsesJsonSseDispatchPlanForHttp = prepareResponsesJsonSseDispatchPlanForHttpImpl;
export const requireResponsesHandlerCoreDist = requireResponsesHandlerCoreDistImpl;
export const resolveResponsesRequestContextForHttp = resolveResponsesRequestContextForHttpImpl;
export const resolveRelayResponsesClientSseStreamForHttp = resolveRelayResponsesClientSseStreamForHttpImpl;
export const shouldDispatchResponsesSseToClientForHttp = shouldDispatchResponsesSseToClientForHttpImpl;
export const shouldDropClientSseFrameForHttp = shouldDropClientSseFrameForHttpImpl;
export const shouldReprojectRelayResponsesSseForHttp = shouldReprojectRelayResponsesSseForHttpImpl;

export async function prepareResponsesJsonBodyForSseBridgeForHttp(args: {
  body: unknown;
  entryEndpoint?: string;
  requestLabel?: string;
}): Promise<Record<string, unknown> | null> {
  void args.requestLabel;
  if (!args.body || typeof args.body !== 'object' || Array.isArray(args.body)) {
    return null;
  }
  const record = args.body as Record<string, unknown>;
  const isResponsesEndpoint =
    args.entryEndpoint === '/v1/responses'
    || args.entryEndpoint === '/v1/responses.submit_tool_outputs';
  if (
    isResponsesEndpoint
    && (
      record.object === 'response'
      || typeof record.output === 'object'
      || typeof record.status === 'string'
    )
  ) {
    return record;
  }
  return null;
}

export async function reprojectDirectChatToolCallStreamForHttp(args: {
  body: Record<string, unknown>;
  requestId?: string;
}): Promise<import('node:stream').Readable> {
  const converter = await createChatJsonToSseConverterForHttpImpl();
  return await converter.convertResponseToJsonToSse(args.body, {
    requestId: args.requestId,
  }) as import('node:stream').Readable;
}
