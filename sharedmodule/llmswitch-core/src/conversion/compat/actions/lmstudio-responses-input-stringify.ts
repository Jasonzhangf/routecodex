import type { JsonObject } from '../../hub/types/json.js';
import type { AdapterContext } from '../../hub/types/chat-envelope.js';
import { buildNativeReqOutboundCompatAdapterContext } from '../../hub/pipeline/compat/native-adapter-context.js';
import { applyLmstudioResponsesInputStringifyWithNative } from '../../../router/virtual-router/engine-selection/native-compat-action-semantics.js';

const PROFILE = 'chat:lmstudio';
const DEFAULT_PROVIDER_PROTOCOL = 'openai-responses';
const DEFAULT_ENTRY_ENDPOINT = '/v1/responses';

function buildLmstudioCompatContext(
  adapterContext?: AdapterContext,
  options?: { stringifyEnabled?: boolean }
): Record<string, unknown> {
  const nativeContext = buildNativeReqOutboundCompatAdapterContext(adapterContext);
  const rtNode =
    nativeContext.__rt && typeof nativeContext.__rt === 'object' && !Array.isArray(nativeContext.__rt)
      ? { ...(nativeContext.__rt as Record<string, unknown>) }
      : {};
  if (options?.stringifyEnabled) {
    rtNode.lmstudioStringifyInputEnabled = true;
  }

  return {
    ...nativeContext,
    ...(Object.keys(rtNode).length ? { __rt: rtNode } : {}),
    compatibilityProfile: PROFILE,
    providerProtocol:
      nativeContext.providerProtocol ??
      adapterContext?.providerProtocol ??
      DEFAULT_PROVIDER_PROTOCOL,
    entryEndpoint:
      nativeContext.entryEndpoint ??
      adapterContext?.entryEndpoint ??
      DEFAULT_ENTRY_ENDPOINT
  };
}

/**
 * Legacy compatibility shim:
 * Some older LM Studio builds rejected the array form of `input` ("Invalid type for 'input'").
 * Convert canonical Responses input items into a single `input` string.
 *
 * ⚠️ Default is OFF (modern LM Studio accepts array input). Enable only if you hit that legacy error:
 * - `LLMSWITCH_LMSTUDIO_STRINGIFY_INPUT=1`
 * - or `ROUTECODEX_LMSTUDIO_STRINGIFY_INPUT=1`
 *
 * This is applied via compat profile `chat:lmstudio` and only when `providerProtocol === 'openai-responses'`.
 */
export function stringifyLmstudioResponsesInput(payload: JsonObject, adapterContext?: AdapterContext): JsonObject {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  if (!adapterContext) {
    return payload;
  }
  const enabled =
    process.env.LLMSWITCH_LMSTUDIO_STRINGIFY_INPUT === '1' ||
    process.env.ROUTECODEX_LMSTUDIO_STRINGIFY_INPUT === '1';
  if (!enabled) {
    return payload;
  }

  return applyLmstudioResponsesInputStringifyWithNative(
    payload as unknown as Record<string, unknown>,
    buildLmstudioCompatContext(adapterContext, { stringifyEnabled: true })
  ) as unknown as JsonObject;
}
