/**
 * /v1/responses SSE-side handler bridge surface.
 *
 * Dedicated SSE transport-facing facade for responses SSE streaming.
 * Client projection is delegated to the Rust native owner.
 */

// feature_id: server.responses_sse_bridge_surface
// canonical_builders: buildClientSseKeepaliveFrameForHttp, projectResponsesSseFrameForClientForHttp

import {
  buildClientSseKeepaliveFrameForHttp as buildClientSseKeepaliveFrameForHttpImpl,
} from './responses-sse-transport.js';
import {
  projectResponsesSseFrameForClientNative,
} from './native-exports.js';

export const buildClientSseKeepaliveFrameForHttp = buildClientSseKeepaliveFrameForHttpImpl;

export type ResponsesSseClientProjectionStateForHttp = {
  pendingApplyPatchArgumentDeltas: Record<string, string>;
  applyPatchCallIds: string[];
  emittedApplyPatchDoneCallIds: string[];
};

export function createResponsesSseClientProjectionStateForHttp(): ResponsesSseClientProjectionStateForHttp {
  return {
    pendingApplyPatchArgumentDeltas: {},
    applyPatchCallIds: [],
    emittedApplyPatchDoneCallIds: [],
  };
}

export function projectResponsesSseFrameForClientForHttp(args: {
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
} {
  return projectResponsesSseFrameForClientNative(args);
}
