import type { AdapterContext } from '../../hub/types/chat-envelope.js';
import type { JsonObject } from '../../hub/types/json.js';
import type { AnthropicClaudeCodeSystemPromptConfig } from '../../hub/pipeline/compat/compat-types.js';
import { buildNativeReqOutboundCompatAdapterContext } from '../../hub/pipeline/compat/native-adapter-context.js';
import type {
  NativeReqOutboundCompatAdapterContextInput,
  NativeReqOutboundStage3CompatInput
} from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';
import { runReqOutboundStage3CompatWithNative } from '../../../router/virtual-router/engine-selection/native-hub-pipeline-req-outbound-semantics.js';

const PROFILE = 'chat:claude-code';
const DEFAULT_PROVIDER_PROTOCOL = 'anthropic-messages';
const DEFAULT_ENTRY_ENDPOINT = '/v1/messages';

function buildClaudeCodeConfigNode(
  config?: AnthropicClaudeCodeSystemPromptConfig
): Record<string, unknown> | undefined {
  if (!config) {
    return undefined;
  }

  const node: Record<string, unknown> = {};
  if (typeof config.systemText === 'string' && config.systemText.trim()) {
    node.systemText = config.systemText.trim();
  }
  if (typeof config.preserveExistingSystemAsUserMessage === 'boolean') {
    node.preserveExistingSystemAsUserMessage = config.preserveExistingSystemAsUserMessage;
  }
  return Object.keys(node).length ? node : undefined;
}

function buildClaudeCodeCompatContext(
  adapterContext?: AdapterContext,
  config?: AnthropicClaudeCodeSystemPromptConfig
): NativeReqOutboundCompatAdapterContextInput {
  const nativeContext = buildNativeReqOutboundCompatAdapterContext(adapterContext);
  const claudeCode = buildClaudeCodeConfigNode(config);
  return {
    ...nativeContext,
    compatibilityProfile: PROFILE,
    providerProtocol: nativeContext.providerProtocol ?? adapterContext?.providerProtocol ?? DEFAULT_PROVIDER_PROTOCOL,
    entryEndpoint: nativeContext.entryEndpoint ?? adapterContext?.entryEndpoint ?? DEFAULT_ENTRY_ENDPOINT,
    ...(claudeCode ? { claudeCode } : {})
  };
}

function buildClaudeCodeCompatInput(
  payload: JsonObject,
  config?: AnthropicClaudeCodeSystemPromptConfig,
  adapterContext?: AdapterContext
): NativeReqOutboundStage3CompatInput {
  return {
    payload,
    adapterContext: buildClaudeCodeCompatContext(adapterContext, config),
    explicitProfile: PROFILE
  };
}

export function applyAnthropicClaudeCodeSystemPromptCompat(
  payload: JsonObject,
  config?: AnthropicClaudeCodeSystemPromptConfig,
  adapterContext?: AdapterContext
): JsonObject {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  return runReqOutboundStage3CompatWithNative(
    buildClaudeCodeCompatInput(payload, config, adapterContext)
  ).payload;
}
