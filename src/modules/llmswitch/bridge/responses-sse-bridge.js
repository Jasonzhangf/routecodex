/**
 * /v1/responses SSE-side handler bridge surface.
 *
 * Dedicated SSE transport-facing facade for responses SSE streaming.
 * Client projection is delegated to the Rust native owner.
 */
import { buildClientSseKeepaliveFrameForHttp as buildClientSseKeepaliveFrameForHttpImpl } from './responses-sse-transport.js';
import { projectResponsesSseFrameForClientNative, updateResponsesSseTransportTerminalStateNative } from './native-exports.js';
export const buildClientSseKeepaliveFrameForHttp = buildClientSseKeepaliveFrameForHttpImpl;
export function createResponsesSseClientProjectionStateForHttp() {
    return {
        pendingApplyPatchArgumentDeltas: {},
        applyPatchCallIds: [],
        emittedApplyPatchDoneCallIds: [],
    };
}
export function projectResponsesSseFrameForClientForHttp(args) {
    return projectResponsesSseFrameForClientNative(args);
}
export function updateResponsesSseTransportTerminalStateForHttp(input) {
    return updateResponsesSseTransportTerminalStateNative(input);
}
//# sourceMappingURL=responses-sse-bridge.js.map
