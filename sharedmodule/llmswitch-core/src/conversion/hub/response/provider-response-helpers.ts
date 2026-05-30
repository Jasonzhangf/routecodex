import type { AdapterContext } from '../types/chat-envelope.js';
import type { JsonObject } from '../types/json.js';
import type { ChatCompletionLike, ResponseMapper } from './response-mappers.js';
import { ProviderProtocolError } from '../../provider-protocol-error.js';
import { readRuntimeMetadata } from '../../runtime-metadata.js';
import { commitClockReservation, resolveClockConfig } from '../../../servertool/clock/task-store.js';
import {
  detectProviderResponseShapeWithNative,
  isCanonicalChatCompletionPayloadWithNative
} from '../../../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';
import {
  resolveProviderResponseContextHelpersWithNative,
  resolveProviderTypeFromProtocolWithNative,
  resolveClockReservationFromContextWithNative
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics.js';

export type ProviderProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat';
export type ClientProtocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

export type ProviderResponsePlan = {
  createMapper: () => ResponseMapper;
};

export interface ProviderResponseContextSignals {
  isFollowup: boolean;
  toolSurfaceShadowEnabled: boolean;
  clientProtocol: ClientProtocol;
  displayModel?: string;
  clientFacingRequestId: string;
}

export function resolveProviderResponseContextSignals(
  context: AdapterContext,
  entryEndpoint?: string
): ProviderResponseContextSignals {
  const runtimeMeta = readRuntimeMetadata(context as unknown as Record<string, unknown>);
  const resolved = resolveProviderResponseContextHelpersWithNative({
    context,
    serverToolFollowupRaw: (runtimeMeta as any)?.serverToolFollowup,
    entryEndpoint,
    toolSurfaceModeRaw: String(process.env.ROUTECODEX_HUB_TOOL_SURFACE_MODE || '')
  });
  const clientFacingRequestId =
    typeof resolved.clientFacingRequestId === 'string' && resolved.clientFacingRequestId.trim()
      ? resolved.clientFacingRequestId.trim()
      : context.requestId;
  const clientProtocol: ClientProtocol =
    resolved.clientProtocol === 'openai-responses' || resolved.clientProtocol === 'anthropic-messages'
      ? resolved.clientProtocol
      : 'openai-chat';
  return {
    isFollowup: resolved.isServerToolFollowup === true,
    toolSurfaceShadowEnabled: resolved.toolSurfaceShadowEnabled === true,
    clientProtocol,
    displayModel:
      typeof resolved.displayModel === 'string' && resolved.displayModel.trim()
        ? resolved.displayModel.trim()
        : undefined,
    clientFacingRequestId
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unwrapOpenaiChatDataEnvelope(payload: ChatCompletionLike): ChatCompletionLike {
  const row = asRecord(payload);
  const nested = asRecord(row?.data);
  return (nested as ChatCompletionLike | null) ?? payload;
}

function readStructuredProviderBusinessError(payload: ChatCompletionLike): {
  statusCode?: number;
  statusMessage?: string;
  contextLengthExceeded: boolean;
} | null {
  const candidates = [asRecord(payload), asRecord(asRecord(payload)?.data)].filter(Boolean) as Array<Record<string, unknown>>;
  for (const candidate of candidates) {
    const baseResp = asRecord(candidate.base_resp) ?? asRecord(candidate.baseResp);
    const statusCodeRaw = baseResp?.status_code ?? baseResp?.statusCode;
    const statusMessageRaw = baseResp?.status_msg ?? baseResp?.statusMessage;
    const statusCode =
      typeof statusCodeRaw === 'number' && Number.isFinite(statusCodeRaw)
        ? Math.trunc(statusCodeRaw)
        : typeof statusCodeRaw === 'string' && statusCodeRaw.trim()
          ? Number.parseInt(statusCodeRaw.trim(), 10)
          : undefined;
    const statusMessage =
      typeof statusMessageRaw === 'string' && statusMessageRaw.trim()
        ? statusMessageRaw.trim()
        : '';
    if ((statusCode !== undefined && statusCode !== 0) || statusMessage) {
      const normalizedMessage = statusMessage.toLowerCase();
      return {
        ...(statusCode !== undefined ? { statusCode } : {}),
        ...(statusMessage ? { statusMessage } : {}),
        contextLengthExceeded:
          normalizedMessage.includes('context window exceeds limit')
          || normalizedMessage.includes('context_length_exceeded')
          || normalizedMessage.includes('input exceeds limit')
      };
    }
  }
  return null;
}

function buildStructuredProviderBusinessError(args: {
  payload: ChatCompletionLike;
  scope: string;
  protocol?: string;
}): ProviderProtocolError | null {
  const structuredError = readStructuredProviderBusinessError(args.payload);
  if (!structuredError) {
    return null;
  }
  const providerStatusMessage = structuredError.statusMessage || 'provider business error';
  const isProviderStatus2056 = structuredError.statusCode === 2056;
  const upstreamCode = structuredError.contextLengthExceeded
    ? 'context_length_exceeded'
    : (structuredError.statusCode !== undefined ? `provider_status_${structuredError.statusCode}` : 'provider_business_error');
  const error = new ProviderProtocolError(
    `[hub_response] Upstream provider returned structured business error at ${args.scope}: ${providerStatusMessage}`,
    {
      code: isProviderStatus2056 ? 'HTTP_429_2056' : 'MALFORMED_RESPONSE',
      protocol: (args.protocol ?? 'unknown') as ProviderProtocol,
      providerType: resolveProviderTypeFromProtocolWithNative(args.protocol ?? 'unknown'),
      details: {
        detected: 'provider_business_error',
        reason: structuredError.contextLengthExceeded ? 'context_length_exceeded' : 'provider_business_error',
        upstreamCode,
        ...(structuredError.statusCode !== undefined ? { providerStatusCode: structuredError.statusCode } : {}),
        ...(structuredError.statusMessage ? { providerStatusMessage: structuredError.statusMessage } : {}),
        payloadType: typeof (args.payload as any),
        payloadKeys:
          args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload)
            ? Object.keys(args.payload as any).slice(0, 20)
            : undefined
      }
    }
  ) as ProviderProtocolError & { upstreamCode?: string; statusCode?: number; status?: number };
  error.upstreamCode = upstreamCode;
  if (isProviderStatus2056) {
    error.statusCode = 429;
    error.status = 429;
  }
  return error;
}

export async function normalizeClientPayloadToCanonicalChatCompletionOrThrow(args: {
  payload: ChatCompletionLike;
  scope: string;
  context: AdapterContext;
  requestSemantics?: JsonObject;
  registry: Record<ProviderProtocol, ProviderResponsePlan>;
}): Promise<ChatCompletionLike> {
  const { payload, scope, context, requestSemantics, registry } = args;
  const normalizedPayload = unwrapOpenaiChatDataEnvelope(payload);
  if (isCanonicalChatCompletionPayloadWithNative(normalizedPayload)) {
    return normalizedPayload;
  }
  const detected = detectProviderResponseShapeWithNative(normalizedPayload);
  if (detected === 'unknown') {
    const protocol = context?.providerProtocol;
    const structuredError = buildStructuredProviderBusinessError({ payload, scope, protocol });
    if (structuredError) throw structuredError;
    throw new ProviderProtocolError(`[hub_response] Non-canonical response payload at ${scope}`, {
      code: 'MALFORMED_RESPONSE',
      protocol: (protocol ?? 'unknown') as ProviderProtocol,
      providerType: resolveProviderTypeFromProtocolWithNative(protocol ?? 'unknown'),
      details: {
        detected,
        payloadType: typeof (normalizedPayload as any),
        payloadKeys:
          normalizedPayload && typeof normalizedPayload === 'object' && !Array.isArray(normalizedPayload)
            ? Object.keys(normalizedPayload as any).slice(0, 20)
            : undefined
      }
    });
  }
  const detectedPlan = registry[detected];
  const mapper = detectedPlan.createMapper();
  const coerced = await mapper.toChatCompletion(
    { payload: normalizedPayload } as any,
    context,
    { requestSemantics } as any
  );
  if (isCanonicalChatCompletionPayloadWithNative(coerced)) {
    return coerced as ChatCompletionLike;
  }
  const protocol = context?.providerProtocol;
  const structuredError = buildStructuredProviderBusinessError({ payload, scope, protocol });
  if (structuredError) throw structuredError;
  throw new ProviderProtocolError(`[hub_response] Failed to canonicalize response payload at ${scope}`, {
    code: 'MALFORMED_RESPONSE',
      protocol: (protocol ?? 'unknown') as ProviderProtocol,
      providerType: resolveProviderTypeFromProtocolWithNative(protocol ?? 'unknown'),
    details: { detected }
  });
}

export async function maybeCommitClockReservationFromContext(
  context: AdapterContext
): Promise<void> {
  try {
    const runtimeMeta = readRuntimeMetadata(context as unknown as Record<string, unknown>);
    const clockConfig = resolveClockConfig((runtimeMeta as any)?.clock);
    if (!clockConfig) {
      return;
    }
    const reservation = resolveClockReservationFromContextWithNative(
      context as unknown as Record<string, unknown>
    );
    if (!reservation) {
      return;
    }
    await commitClockReservation(reservation as any, clockConfig);
  } catch {
    // best-effort: never break response conversion due to clock persistence errors
  }
}
