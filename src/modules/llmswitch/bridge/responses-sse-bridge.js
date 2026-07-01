/**
 * /v1/responses SSE-side handler bridge surface.
 *
 * Dedicated SSE transport-facing facade for responses SSE streaming
 * behavior. Response projection and lifecycle facades stay in
 * responses-response-bridge.ts.
 */
import { buildClientSseKeepaliveFrameForHttp as buildClientSseKeepaliveFrameForHttpImpl } from './responses-sse-transport.js';
export const buildClientSseKeepaliveFrameForHttp = buildClientSseKeepaliveFrameForHttpImpl;
//# sourceMappingURL=responses-sse-bridge.js.map
