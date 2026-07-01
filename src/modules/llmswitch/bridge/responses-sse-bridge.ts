/**
 * /v1/responses SSE-side handler bridge surface.
 *
 * Dedicated SSE transport-facing facade for responses SSE streaming
 * behavior. Response projection and lifecycle facades stay in
 * responses-response-bridge.ts.
 */

// feature_id: server.responses_sse_bridge_surface
// canonical_builders: buildClientSseKeepaliveFrameForHttp

import {
  buildClientSseKeepaliveFrameForHttp as buildClientSseKeepaliveFrameForHttpImpl,
} from './responses-sse-transport.js';

export const buildClientSseKeepaliveFrameForHttp = buildClientSseKeepaliveFrameForHttpImpl;
