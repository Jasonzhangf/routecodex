/**
 * /v1/responses SSE-side handler bridge surface.
 *
 * Dedicated SSE transport-facing facade for responses SSE/JSON streaming
 * behaviors. Lifecycle persistence stays in responses-response-bridge.ts.
 */
import type { ResponsesRequestContextForHttp } from './responses-response-bridge.js';
import { buildResponsesRequestLogContextForHttp as buildResponsesRequestLogContextForHttpImpl, importResponsesHandlerCoreDist as importResponsesHandlerCoreDistImpl, prepareResponsesJsonClientDispatchPlanForHttp as prepareResponsesJsonClientDispatchPlanForHttpImpl, requireResponsesHandlerCoreDist as requireResponsesHandlerCoreDistImpl } from './responses-response-bridge.js';
import { buildClientSseKeepaliveFrameForHttp as buildClientSseKeepaliveFrameForHttpImpl, shouldDropClientSseFrameForHttp as shouldDropClientSseFrameForHttpImpl } from './responses-sse-transport.js';
import { updateResponsesContractProbeFromSseChunkNative } from './native-exports.js';
export type { ResponsesRequestContextForHttp };
export declare const buildClientSseKeepaliveFrameForHttp: typeof buildClientSseKeepaliveFrameForHttpImpl;
export declare const buildResponsesRequestLogContextForHttp: typeof buildResponsesRequestLogContextForHttpImpl;
export declare const importResponsesHandlerCoreDist: typeof importResponsesHandlerCoreDistImpl;
export declare const prepareResponsesJsonClientDispatchPlanForHttp: typeof prepareResponsesJsonClientDispatchPlanForHttpImpl;
export declare const requireResponsesHandlerCoreDist: typeof requireResponsesHandlerCoreDistImpl;
export declare const shouldDropClientSseFrameForHttp: typeof shouldDropClientSseFrameForHttpImpl;
export declare const updateResponsesContractProbeFromSseChunkForHttp: typeof updateResponsesContractProbeFromSseChunkNative;
