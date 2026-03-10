import type { JsonObject } from '../../hub/types/json.js';
import type { AdapterContext } from '../../hub/types/chat-envelope.js';
import { buildNativeReqOutboundCompatAdapterContext } from '../../hub/pipeline/compat/native-adapter-context.js';
import { applyGeminiWebSearchRequestCompatWithNative } from '../../../router/virtual-router/engine-selection/native-compat-action-semantics.js';

const PROFILE = 'chat:gemini';
const DEFAULT_PROVIDER_PROTOCOL = 'gemini-chat';
const DEFAULT_ENTRY_ENDPOINT = '/v1beta/models:generateContent';

function buildGeminiCompatContext(
  adapterContext?: AdapterContext,
): Record<string, unknown> {
  const nativeContext = buildNativeReqOutboundCompatAdapterContext(adapterContext);
  return {
    ...nativeContext,
    compatibilityProfile: PROFILE,
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

export function applyGeminiWebSearchCompat(
  root: JsonObject,
  adapterContext?: AdapterContext,
): JsonObject {
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    return root;
  }

  return applyGeminiWebSearchRequestCompatWithNative(
    root as Record<string, unknown>,
    buildGeminiCompatContext(adapterContext),
  ) as JsonObject;
}
