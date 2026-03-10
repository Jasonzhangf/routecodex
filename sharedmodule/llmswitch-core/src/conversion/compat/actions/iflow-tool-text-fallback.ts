import type { AdapterContext } from '../../hub/types/chat-envelope.js';
import type { JsonObject } from '../../hub/types/json.js';
import { buildNativeReqOutboundCompatAdapterContext } from '../../hub/pipeline/compat/native-adapter-context.js';
import { applyIflowToolTextFallbackWithNative } from '../../../router/virtual-router/engine-selection/native-compat-action-semantics.js';

const PROFILE = 'chat:iflow';
const DEFAULT_PROVIDER_PROTOCOL = 'openai-chat';
const DEFAULT_ENTRY_ENDPOINT = '/v1/chat/completions';

function buildIflowCompatContext(
  adapterContext?: AdapterContext,
): Record<string, unknown> {
  const nativeContext = buildNativeReqOutboundCompatAdapterContext(adapterContext);
  return {
    ...nativeContext,
    compatibilityProfile:
      nativeContext.compatibilityProfile ??
      adapterContext?.compatibilityProfile ??
      PROFILE,
    providerProtocol:
      nativeContext.providerProtocol ??
      adapterContext?.providerProtocol ??
      DEFAULT_PROVIDER_PROTOCOL,
    entryEndpoint:
      nativeContext.entryEndpoint ??
      adapterContext?.entryEndpoint ??
      DEFAULT_ENTRY_ENDPOINT,
  };
}

export function applyIflowToolTextFallback(
  payload: JsonObject,
  options?: { models?: string[]; routeId?: string },
): JsonObject {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  const adapterContext = options?.routeId
    ? ({ routeId: options.routeId } as AdapterContext)
    : undefined;

  return applyIflowToolTextFallbackWithNative(
    payload as Record<string, unknown>,
    buildIflowCompatContext(adapterContext),
    Array.isArray(options?.models) ? options?.models : [],
  ) as JsonObject;
}
