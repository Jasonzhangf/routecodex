/**
 * /v1/responses SSE-side handler bridge surface.
 *
 * Dedicated SSE transport-facing facade for responses SSE streaming
 * behavior. Response projection and lifecycle facades stay in
 * responses-response-bridge.ts.
 */
import { buildClientSseKeepaliveFrameForHttp as buildClientSseKeepaliveFrameForHttpImpl, shouldDropClientSseFrameForHttp as shouldDropClientSseFrameForHttpImpl, } from './responses-sse-transport.js';
import { updateResponsesSseTransportTerminalStateNative } from './native-exports.js';
export const buildClientSseKeepaliveFrameForHttp = buildClientSseKeepaliveFrameForHttpImpl;
export const shouldDropClientSseFrameForHttp = shouldDropClientSseFrameForHttpImpl;
export const updateResponsesSseTransportTerminalStateForHttp = updateResponsesSseTransportTerminalStateNative;
//# sourceMappingURL=responses-sse-bridge.js.map
