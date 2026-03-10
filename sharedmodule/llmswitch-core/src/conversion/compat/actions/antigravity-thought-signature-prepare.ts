import type { AdapterContext } from '../../hub/types/chat-envelope.js';
import type { JsonObject } from '../../hub/types/json.js';
import { buildNativeReqOutboundCompatAdapterContext } from '../../hub/pipeline/compat/native-adapter-context.js';
import { prepareAntigravityThoughtSignatureForGeminiRequestWithNative } from '../../../router/virtual-router/engine-selection/native-compat-action-semantics.js';

const PROFILE = 'chat:gemini-cli';
const DEFAULT_PROVIDER_PROTOCOL = 'gemini-chat';
const DEFAULT_ENTRY_ENDPOINT = '/v1beta/models:generateContent';

function buildAntigravityCompatContext(
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

export function prepareAntigravityThoughtSignatureForGeminiRequest(
  payload: JsonObject,
  adapterContext?: AdapterContext,
): JsonObject {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  return prepareAntigravityThoughtSignatureForGeminiRequestWithNative(
    payload as Record<string, unknown>,
    buildAntigravityCompatContext(adapterContext),
  ) as JsonObject;
}
