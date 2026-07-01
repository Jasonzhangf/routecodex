/**
 * /v1/responses SSE-side handler bridge surface.
 *
 * Dedicated SSE transport-facing facade for responses SSE streaming
 * behavior. Response projection and lifecycle facades stay in
 * responses-response-bridge.ts.
 */
import { buildClientSseKeepaliveFrameForHttp as buildClientSseKeepaliveFrameForHttpImpl } from './responses-sse-transport.js';
import { updateResponsesSseTransportTerminalStateNative } from './native-exports.js';
export declare const buildClientSseKeepaliveFrameForHttp: typeof buildClientSseKeepaliveFrameForHttpImpl;
export declare const updateResponsesSseTransportTerminalStateForHttp: typeof updateResponsesSseTransportTerminalStateNative;
