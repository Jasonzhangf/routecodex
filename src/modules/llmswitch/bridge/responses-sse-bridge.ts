/**
 * /v1/responses SSE-side handler bridge surface.
 *
 * Dedicated SSE transport-facing facade for responses SSE/JSON streaming
 * behaviors. Lifecycle persistence stays in responses-response-bridge.ts.
 */

// feature_id: server.responses_sse_bridge_surface
// canonical_builders: buildClientSseKeepaliveFrameForHttp

import type { ResponsesRequestContextForHttp } from './responses-response-bridge.js';
import {
  buildResponsesRequestLogContextForHttp as buildResponsesRequestLogContextForHttpImpl,
  importResponsesHandlerCoreDist as importResponsesHandlerCoreDistImpl,
  prepareResponsesJsonClientDispatchPlanForHttp as prepareResponsesJsonClientDispatchPlanForHttpImpl,
  requireResponsesHandlerCoreDist as requireResponsesHandlerCoreDistImpl,
} from './responses-response-bridge.js';
import {
  buildClientSseKeepaliveFrameForHttp as buildClientSseKeepaliveFrameForHttpImpl,
  shouldDropClientSseFrameForHttp as shouldDropClientSseFrameForHttpImpl,
} from './responses-sse-transport.js';

export type { ResponsesRequestContextForHttp };

export const buildClientSseKeepaliveFrameForHttp = buildClientSseKeepaliveFrameForHttpImpl;
export const buildResponsesRequestLogContextForHttp = buildResponsesRequestLogContextForHttpImpl;
export const importResponsesHandlerCoreDist = importResponsesHandlerCoreDistImpl;
export const prepareResponsesJsonClientDispatchPlanForHttp = prepareResponsesJsonClientDispatchPlanForHttpImpl;
export const requireResponsesHandlerCoreDist = requireResponsesHandlerCoreDistImpl;
export const shouldDropClientSseFrameForHttp = shouldDropClientSseFrameForHttpImpl;
