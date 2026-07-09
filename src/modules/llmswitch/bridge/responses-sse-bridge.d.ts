/**
 * /v1/responses SSE-side handler bridge surface.
 *
 * Dedicated SSE transport-facing facade for responses SSE streaming.
 * Client projection is delegated to the Rust native owner.
 */
import { buildClientSseKeepaliveFrameForHttp as buildClientSseKeepaliveFrameForHttpImpl } from './responses-sse-transport.js';
export declare const buildClientSseKeepaliveFrameForHttp: typeof buildClientSseKeepaliveFrameForHttpImpl;
export type ResponsesSseClientProjectionStateForHttp = {
    pendingApplyPatchArgumentDeltas: Record<string, string>;
    applyPatchCallIds: string[];
    emittedApplyPatchDoneCallIds: string[];
};
export declare function createResponsesSseClientProjectionStateForHttp(): ResponsesSseClientProjectionStateForHttp;
export declare function projectResponsesSseFrameForClientForHttp(args: {
    frame: string;
    eventName?: string;
    data: Record<string, unknown>;
    toolsRaw: unknown[];
    metadata?: Record<string, unknown>;
    state: ResponsesSseClientProjectionStateForHttp;
}): {
    emit: boolean;
    frame: string;
    state: ResponsesSseClientProjectionStateForHttp;
};
export declare function updateResponsesSseTransportTerminalStateForHttp(input: {
    chunk: unknown;
    state: Record<string, unknown> | undefined;
    flushRemainder?: boolean;
}): {
    state: Record<string, unknown>;
    observedTerminal: boolean;
};
