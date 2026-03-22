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

export async function coerceClientPayloadToCanonicalChatCompletionOrThrow(args: {
  payload: ChatCompletionLike;
  scope: string;
  context: AdapterContext;
  requestSemantics?: JsonObject;
  registry: Record<ProviderProtocol, ProviderResponsePlan>;
}): Promise<ChatCompletionLike> {
  const { payload, scope, context, requestSemantics, registry } = args;
  if (isCanonicalChatCompletionPayloadWithNative(payload)) {
    return payload;
  }
  const detected = detectProviderResponseShapeWithNative(payload);
  if (detected === 'unknown') {
    const protocol = context?.providerProtocol;
    throw new ProviderProtocolError(`[hub_response] Non-canonical response payload at ${scope}`, {
      code: 'MALFORMED_RESPONSE',
      protocol,
      providerType: resolveProviderTypeFromProtocolWithNative(protocol),
      details: {
        detected,
        payloadType: typeof (payload as any),
        payloadKeys:
          payload && typeof payload === 'object' && !Array.isArray(payload)
            ? Object.keys(payload as any).slice(0, 20)
            : undefined
      }
    });
  }
  const detectedPlan = registry[detected];
  const mapper = detectedPlan.createMapper();
  const coerced = await mapper.toChatCompletion(
    { payload } as any,
    context,
    { requestSemantics } as any
  );
  if (isCanonicalChatCompletionPayloadWithNative(coerced)) {
    return coerced as ChatCompletionLike;
  }
  const protocol = context?.providerProtocol;
  throw new ProviderProtocolError(`[hub_response] Failed to canonicalize response payload at ${scope}`, {
    code: 'MALFORMED_RESPONSE',
    protocol,
    providerType: resolveProviderTypeFromProtocolWithNative(protocol),
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
