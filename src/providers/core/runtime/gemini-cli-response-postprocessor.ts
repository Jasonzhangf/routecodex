import { cacheAntigravitySessionSignature } from '../../../modules/llmswitch/bridge.js';
import type { UnknownObject } from '../../../types/common-types.js';
import type { ProviderContext } from '../api/provider-types.js';

export function postprocessGeminiCliResponse(args: {
  response: unknown;
  context: ProviderContext;
  providerType: string;
  isAntigravityRuntime: boolean;
  antigravityAlias?: string;
}): UnknownObject {
  const processingTime = Date.now() - args.context.startTime;
  const responseRecord =
    args.response && typeof args.response === 'object'
      ? (args.response as {
          data?: unknown;
          status?: number;
          headers?: Record<string, string>;
          __sse_responses?: unknown;
        })
      : undefined;

  if (responseRecord) {
    const sseStream =
      responseRecord.__sse_responses ||
      (responseRecord.data && typeof responseRecord.data === 'object'
        ? (responseRecord.data as { __sse_responses?: unknown }).__sse_responses
        : undefined);
    if (sseStream) {
      return { __sse_responses: sseStream } as UnknownObject;
    }

    const rawData = responseRecord.data ?? args.response;
    let normalizedPayload = rawData as unknown;
    if (rawData && typeof rawData === 'object' && 'response' in (rawData as Record<string, unknown>)) {
      const inner = (rawData as Record<string, unknown>).response;
      if (inner && typeof inner === 'object') {
        normalizedPayload = inner as Record<string, unknown>;
      }
    }

    const payloadObject =
      normalizedPayload && typeof normalizedPayload === 'object'
        ? (normalizedPayload as Record<string, unknown>)
        : undefined;
    const modelFromPayload =
      payloadObject && typeof payloadObject.model === 'string' && payloadObject.model.trim().length
        ? payloadObject.model
        : undefined;
    const usageFromPayload =
      payloadObject && typeof (payloadObject as { usageMetadata?: unknown }).usageMetadata === 'object'
        ? ((payloadObject as { usageMetadata?: UnknownObject }).usageMetadata as UnknownObject)
        : undefined;

    if (args.isAntigravityRuntime && payloadObject) {
      const alias = args.antigravityAlias;
      const aliasKey = alias && alias.trim().length ? `antigravity.${alias.trim()}` : 'antigravity.unknown';
      const sessionId =
        typeof (args.context as { runtimeMetadata?: { metadata?: { antigravitySessionId?: unknown } } }).runtimeMetadata?.metadata?.antigravitySessionId === 'string'
          ? String((args.context as { runtimeMetadata?: { metadata?: { antigravitySessionId?: unknown } } }).runtimeMetadata?.metadata?.antigravitySessionId)
          : args.context.metadata && typeof (args.context.metadata as { antigravitySessionId?: unknown }).antigravitySessionId === 'string'
            ? String((args.context.metadata as { antigravitySessionId?: unknown }).antigravitySessionId)
            : undefined;
      if (sessionId) {
        const candidatesRaw = (payloadObject as { candidates?: unknown }).candidates;
        const candidates = Array.isArray(candidatesRaw) ? (candidatesRaw as Record<string, unknown>[]) : [];
        for (const candidate of candidates) {
          const content =
            candidate && typeof candidate.content === 'object' && candidate.content !== null
              ? (candidate.content as Record<string, unknown>)
              : undefined;
          const partsRaw = content?.parts;
          const parts = Array.isArray(partsRaw) ? (partsRaw as Record<string, unknown>[]) : [];
          for (const part of parts) {
            const signature =
              typeof (part as { thoughtSignature?: unknown }).thoughtSignature === 'string'
                ? String((part as { thoughtSignature?: unknown }).thoughtSignature)
                : typeof (part as { thought_signature?: unknown }).thought_signature === 'string'
                  ? String((part as { thought_signature?: unknown }).thought_signature)
                  : '';
            if (signature) {
              cacheAntigravitySessionSignature(aliasKey, sessionId, signature, 1);
            }
          }
        }
      }
    }

    return {
      data: normalizedPayload,
      status: typeof responseRecord.status === 'number' ? responseRecord.status : undefined,
      headers: responseRecord.headers,
      metadata: {
        requestId: args.context.requestId,
        processingTime,
        providerType: args.providerType,
        model: args.context.model ?? modelFromPayload,
        usage: usageFromPayload
      }
    } as UnknownObject;
  }

  return {
    data: args.response,
    metadata: {
      requestId: args.context.requestId,
      processingTime,
      providerType: args.providerType,
      model: args.context.model
    }
  } as UnknownObject;
}
