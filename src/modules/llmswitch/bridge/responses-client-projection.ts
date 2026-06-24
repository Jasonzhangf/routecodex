// feature_id: hub.response_responses_client_projection

import type { ResponsesRequestContextForHttp } from './responses-response-bridge.js';
import { projectResponsesSseFrameForClientNative } from './native-exports.js';

export type ResponsesSseClientProjectionStateForHttp = {
  pendingApplyPatchArgumentDeltas: Record<string, string>;
  applyPatchCallIds: string[];
  emittedApplyPatchDoneCallIds: string[];
};

function readResponsesProjectionToolsForHttp(requestContext?: ResponsesRequestContextForHttp): unknown[] {
  const payloadTools = Array.isArray(requestContext?.payload?.tools) ? requestContext.payload.tools : undefined;
  if (payloadTools?.length) {
    return payloadTools;
  }
  const contextTools = Array.isArray(requestContext?.context?.toolsRaw) ? requestContext.context.toolsRaw : undefined;
  if (contextTools?.length) {
    return contextTools;
  }
  const contextClientTools = Array.isArray(requestContext?.context?.clientToolsRaw)
    ? requestContext.context.clientToolsRaw
    : undefined;
  return contextClientTools?.length ? contextClientTools : [];
}

function readResponsesEventNameFromFrame(frame: string): string | undefined {
  return frame
    .split(/\r?\n/)
    .find((line) => line.startsWith('event:'))
    ?.slice('event:'.length)
    .trim();
}

function readResponsesEventDataFromFrame(frame: string): Record<string, unknown> | undefined {
  const dataText = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!dataText || dataText === '[DONE]') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(dataText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function normalizeClientVisibleResponsesSseFrameForHttp(args: {
  frame: string;
  entryEndpoint?: string;
  requestContext?: ResponsesRequestContextForHttp;
  metadata?: Record<string, unknown>;
  projectionState?: ResponsesSseClientProjectionStateForHttp;
  requestLabel?: string;
}): Promise<string> {
  if (
    args.entryEndpoint !== '/v1/responses'
    && args.entryEndpoint !== '/v1/responses.submit_tool_outputs'
  ) {
    return args.frame;
  }
  const eventName = readResponsesEventNameFromFrame(args.frame);
  if (!eventName || !eventName.startsWith('response.')) {
    return args.frame;
  }
  const data = readResponsesEventDataFromFrame(args.frame);
  if (!data) {
    return args.frame;
  }
  const projected = projectResponsesSseFrameForClientNative({
    frame: args.frame,
    eventName,
    data,
    toolsRaw: readResponsesProjectionToolsForHttp(args.requestContext),
    metadata: args.metadata,
    state: args.projectionState ?? {
      pendingApplyPatchArgumentDeltas: {},
      applyPatchCallIds: [],
      emittedApplyPatchDoneCallIds: [],
    },
  });
  if (args.projectionState) {
    args.projectionState.pendingApplyPatchArgumentDeltas = projected.state.pendingApplyPatchArgumentDeltas ?? {};
    args.projectionState.applyPatchCallIds = projected.state.applyPatchCallIds ?? [];
    args.projectionState.emittedApplyPatchDoneCallIds = projected.state.emittedApplyPatchDoneCallIds ?? [];
  }
  return projected.emit ? projected.frame : '';
}
