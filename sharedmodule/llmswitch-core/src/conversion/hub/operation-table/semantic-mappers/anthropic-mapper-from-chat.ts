import type { AdapterContext, ChatEnvelope } from '../../types/chat-envelope.js';
import type { FormatEnvelope } from '../../types/format-envelope.js';
import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from '../../types/json.js';
import { buildAnthropicRequestFromOpenAIChat } from '../../../codecs/anthropic-openai-codec.js';
import { encodeMetadataPassthrough } from '../../../metadata-passthrough.js';
import {
  applyEffortBudget,
  buildAnthropicThinkingFromConfig,
  mergeAnthropicOutputConfig,
  mergeAnthropicThinkingConfig,
  normalizeAnthropicThinkingConfigFromUnknown,
  resolveConfiguredAnthropicThinkingBudgets,
  resolveConfiguredAnthropicThinkingConfig
} from './anthropic-thinking-config.js';
import {
  appendDroppedFieldAudit,
  appendLossyFieldAudit,
  hasExplicitEmptyToolsSemantics,
  isResponsesOrigin,
} from './anthropic-semantics-audit.js';
import {
  ANTHROPIC_TOP_LEVEL_FIELDS,
  PASSTHROUGH_METADATA_PREFIX,
  PASSTHROUGH_PARAMETERS,
  RESPONSES_DROPPED_PARAMETER_KEYS,
  sanitizeAnthropicPayload,
} from './anthropic-mapper-config.js';

export function buildAnthropicFormatEnvelopeFromChat(
  chat: ChatEnvelope,
  ctx: AdapterContext,
): FormatEnvelope {
  const model = chat.parameters?.model;
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('ChatEnvelope.parameters.model is required for anthropic-messages outbound conversion');
  }
  const baseRequest: Record<string, unknown> = {
    model,
    messages: chat.messages,
    tools: chat.tools
  };
  const explicitEmptyTools = hasExplicitEmptyToolsSemantics(chat);

  const trimmedParameters = chat.parameters && typeof chat.parameters === 'object' ? (chat.parameters as JsonObject) : undefined;
  const responsesOrigin = isResponsesOrigin(chat);
  if (trimmedParameters && responsesOrigin) {
    for (const field of RESPONSES_DROPPED_PARAMETER_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(trimmedParameters, field)) {
        continue;
      }
      appendDroppedFieldAudit(chat, {
        field,
        targetProtocol: 'anthropic-messages',
        reason: 'unsupported_semantics_no_equivalent'
      });
    }
  }
  if (trimmedParameters) {
    for (const [key, value] of Object.entries(trimmedParameters)) {
      if (ANTHROPIC_TOP_LEVEL_FIELDS.has(key) || key === 'stop') {
        if (key === 'messages' || key === 'tools') {
          continue;
        }
        baseRequest[key] = value as JsonValue;
      }
    }
  }
  const passthroughMetadata = encodeMetadataPassthrough(chat.parameters as JsonObject | undefined, {
    prefix: PASSTHROUGH_METADATA_PREFIX,
    keys: PASSTHROUGH_PARAMETERS
  });
  if (passthroughMetadata) {
    const rawMetadata = baseRequest.metadata as JsonValue | undefined;
    const existingMetadata = isJsonObject(rawMetadata)
      ? (jsonClone(rawMetadata) as JsonObject)
      : {};
    for (const [key, value] of Object.entries(passthroughMetadata)) {
      existingMetadata[key] = value;
    }
    baseRequest.metadata = existingMetadata;
  }
  if (baseRequest.max_output_tokens && !baseRequest.max_tokens) {
    baseRequest.max_tokens = baseRequest.max_output_tokens;
  }
  const configuredAnthropicThinking = resolveConfiguredAnthropicThinkingConfig(ctx);
  const configuredAnthropicBudgets = resolveConfiguredAnthropicThinkingBudgets(ctx);
  const requestAnthropicThinking =
    normalizeAnthropicThinkingConfigFromUnknown(trimmedParameters?.thinkingConfig) ??
    normalizeAnthropicThinkingConfigFromUnknown(trimmedParameters?.reasoning, {
      effortDefaultsToAdaptive: true
    });
  const mergedAnthropicThinking = mergeAnthropicThinkingConfig(
    configuredAnthropicThinking,
    requestAnthropicThinking
  );
  const effectiveAnthropicThinking = applyEffortBudget(mergedAnthropicThinking, configuredAnthropicBudgets);
  const mappedThinking = buildAnthropicThinkingFromConfig(effectiveAnthropicThinking);
  if (mappedThinking && baseRequest.thinking === undefined) {
    baseRequest.thinking = mappedThinking;
  }
  const mergedOutputConfig = mergeAnthropicOutputConfig(
    baseRequest.output_config as JsonValue | undefined,
    effectiveAnthropicThinking?.effort
  );
  if (mergedOutputConfig) {
    baseRequest.output_config = mergedOutputConfig;
  }
  if (responsesOrigin && trimmedParameters && Object.prototype.hasOwnProperty.call(trimmedParameters, 'reasoning')) {
    appendLossyFieldAudit(chat, {
      field: 'reasoning',
      targetProtocol: 'anthropic-messages',
      reason:
        effectiveAnthropicThinking?.effort
          ? 'normalized_to_anthropic_thinking_and_effort'
          : 'normalized_to_anthropic_thinking'
    });
  }

  if (explicitEmptyTools && (!Array.isArray(chat.tools) || chat.tools.length === 0)) {
    baseRequest.tools = [];
  }
  try {
    const sysNode = chat.semantics && typeof chat.semantics === 'object' ? (chat.semantics as any).system : undefined;
    if (sysNode && typeof sysNode === 'object' && !Array.isArray(sysNode) && (sysNode as any).blocks !== undefined) {
      baseRequest.system = jsonClone((sysNode as any).blocks as JsonValue) as JsonValue;
    }
  } catch {
    // ignore
  }
  try {
    const extras = chat.semantics && typeof chat.semantics === 'object' ? (chat.semantics as any).providerExtras : undefined;
    const mirror = extras && typeof extras === 'object' && !Array.isArray(extras) ? (extras as any).anthropicMirror : undefined;
    if (mirror && typeof mirror === 'object' && !Array.isArray(mirror)) {
      baseRequest.__anthropicMirror = jsonClone(mirror as JsonValue) as JsonObject;
    }
    const providerMetadata =
      extras && typeof extras === 'object' && !Array.isArray(extras) ? (extras as any).providerMetadata : undefined;
    if (providerMetadata && typeof providerMetadata === 'object' && !Array.isArray(providerMetadata)) {
      const existing = baseRequest.metadata && isJsonObject(baseRequest.metadata as any)
        ? (jsonClone(baseRequest.metadata as JsonValue) as JsonObject)
        : {};
      const merged = {
        ...existing,
        ...(jsonClone(providerMetadata as JsonValue) as JsonObject)
      };
      baseRequest.metadata = merged;
    }
  } catch {
    // ignore
  }

  const payloadSource = buildAnthropicRequestFromOpenAIChat(baseRequest);
  const payload = sanitizeAnthropicPayload(JSON.parse(JSON.stringify(payloadSource)) as JsonObject);
  if (baseRequest.thinking !== undefined) {
    payload.thinking = jsonClone(baseRequest.thinking as JsonValue) as JsonValue;
  }
  if (baseRequest.output_config !== undefined) {
    payload.output_config = jsonClone(baseRequest.output_config as JsonValue) as JsonValue;
  }
  sanitizeAnthropicPayload(payload);

  return {
    protocol: 'anthropic-messages',
    direction: 'response',
    payload,
    meta: {
      context: ctx
    }
  };
}
