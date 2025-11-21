import type { Readable } from 'stream';

export interface StreamingRouteContext {
  entryEndpoint?: string;
  providerType?: string;
  requestId: string;
  startTime: number;
  pipelineId: string;
}

export interface StreamingRouteInput {
  providerPayload: any;
  processedRequest: any;
  originalRequest: any;
}

export interface PipelineResponseLike {
  data: any;
  metadata: any;
  debug?: any;
}

export async function tryHandleStreamingFastPath(
  input: StreamingRouteInput,
  ctx: StreamingRouteContext,
  debugStages: string[]
): Promise<PipelineResponseLike | null> {
  const { providerPayload, processedRequest, originalRequest } = input;
  const entry = deriveEntryEndpoint(processedRequest, originalRequest) || ctx.entryEndpoint || '/v1/chat/completions';
  const providerType = String(ctx.providerType || '').toLowerCase();
  const allowResponses = entry.toLowerCase() === '/v1/responses';
  const allowChat = entry.toLowerCase() === '/v1/chat/completions';

  const anyProv: any = providerPayload as any;
  if (anyProv && typeof anyProv === 'object' && anyProv.__sse_stream) {
    const upstream: Readable = anyProv.__sse_stream;
    // Responses SSE bridge (normalize shapes, ensure usage) instead of raw passthrough
    if (allowResponses && providerType === 'responses') {
      try {
        const { createResponsesSSEFromUpstreamResponses } = await import('../../llmswitch/bridge.js');
        const bridged = await (createResponsesSSEFromUpstreamResponses as any)(upstream, { requestId: ctx.requestId });
        return wrapStream(bridged as any, ctx, debugStages, 'responses upstream SSE bridged');
      } catch {
        // Fallback to passthrough if bridge fails (fail fast upstream)
        return wrapStream(upstream, ctx, debugStages, 'responses upstream SSE passthrough');
      }
    }
    // Chat passthrough (same-protocol)
    if (allowChat) {
      return wrapStream(upstream, ctx, debugStages, 'chat upstream SSE passthrough');
    }
    // Chat SSE to Responses SSE (existing behavior)
    if (allowResponses && providerType !== 'responses') {
      // New path: aggregate upstream Chat SSE → Chat JSON → synthesize Responses SSE
      const { createResponsesSSEFromUpstreamChat } = await import('../../llmswitch/bridge.js');
      const sse = await (createResponsesSSEFromUpstreamChat as any)(upstream, { requestId: ctx.requestId });
      return wrapStream(sse as any, ctx, debugStages, 'core transformed SSE');
    }
  }

  // Synthetic Chat SSE when client wants SSE but upstream returned JSON
  try {
    const wantsStream = !!((processedRequest as any)?.metadata?.stream === true) || !!((originalRequest as any)?.metadata?.stream === true);
    const isChat = entry.toLowerCase() === '/v1/chat/completions';
    const isJson = !(anyProv && typeof anyProv === 'object' && anyProv.__sse_stream);
    if (wantsStream && isChat && isJson) {
      const { createChatSSEStreamFromChatJson } = await import('../../llmswitch/bridge.js');
      const chatJson = (providerPayload && typeof providerPayload === 'object' && 'data' in (providerPayload as any))
        ? (providerPayload as any).data
        : providerPayload;
      const sse = await (createChatSSEStreamFromChatJson as any)(chatJson, { requestId: ctx.requestId });
      return wrapStream(sse as any, ctx, debugStages, 'chat synthetic SSE');
    }
  } catch { /* ignore */ }

  return null;
}

function deriveEntryEndpoint(processedRequest: any, request: any): string | undefined {
  try {
    const metaP = processedRequest && typeof processedRequest === 'object' ? (processedRequest as any).metadata : undefined;
    const metaR = request && typeof request === 'object' ? (request as any).metadata : undefined;
    return (metaP && metaP.entryEndpoint) || (metaR && metaR.entryEndpoint) || (request && (request as any).entryEndpoint) || (request && (request as any).data?.metadata?.entryEndpoint);
  } catch { return undefined; }
}

function wrapStream(upstream: Readable, ctx: StreamingRouteContext, stages: string[], note: string): PipelineResponseLike {
  const processingTime = Date.now() - ctx.startTime;
  return {
    data: { __sse_responses: upstream },
    metadata: {
      pipelineId: ctx.pipelineId,
      processingTime,
      stages,
      requestId: ctx.requestId
    },
    debug: undefined
  } as any;
}

export async function trySynthesizeResponsesFromJson(
  providerPayload: any,
  processedRequest: any,
  originalRequest: any,
  ctx: StreamingRouteContext,
  debugStages: string[]
): Promise<PipelineResponseLike | null> {
  try {
    const entry = deriveEntryEndpoint(processedRequest, originalRequest) || ctx.entryEndpoint || '/v1/chat/completions';
    const wantsStream = !!((processedRequest as any)?.metadata?.stream === true) || !!((originalRequest as any)?.metadata?.stream === true);
    const isJson = !(providerPayload && typeof providerPayload === 'object' && (providerPayload as any).__sse_stream);
    if (wantsStream && String(entry).toLowerCase() === '/v1/responses' && isJson) {
      const respJson = (providerPayload && typeof providerPayload === 'object' && 'data' in (providerPayload as any))
        ? (providerPayload as any).data
        : providerPayload;
      const { createResponsesSSEFromResponsesJson } = await import('../../llmswitch/bridge.js');
      const sse = await (createResponsesSSEFromResponsesJson as any)(respJson, { requestId: ctx.requestId });
      return wrapStream(sse as any, ctx, debugStages, 'responses synthetic SSE');
    }
  } catch { /* ignore */ }
  return null;
}
