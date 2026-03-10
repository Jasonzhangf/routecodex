import type { AdapterContext } from '../../hub/types/chat-envelope.js';
import type { JsonObject } from '../../hub/types/json.js';
import { buildNativeReqOutboundCompatAdapterContext } from '../../hub/pipeline/compat/native-adapter-context.js';
import { applyAnthropicClaudeCodeUserIdWithNative } from '../../../router/virtual-router/engine-selection/native-compat-action-semantics.js';

const PROFILE = 'chat:claude-code';
const DEFAULT_PROVIDER_PROTOCOL = 'anthropic-messages';
const DEFAULT_ENTRY_ENDPOINT = '/v1/messages';

function buildClaudeCodeCompatContext(
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

export function applyAnthropicClaudeCodeUserIdCompat(
  root: JsonObject,
  adapterContext?: AdapterContext,
): void {
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    return;
  }

  const normalized = applyAnthropicClaudeCodeUserIdWithNative(
    root as Record<string, unknown>,
    buildClaudeCodeCompatContext(adapterContext),
  );
  for (const key of Object.keys(root)) {
    if (!(key in normalized)) {
      delete (root as Record<string, unknown>)[key];
    }
  }
  Object.assign(root as Record<string, unknown>, normalized);
}
