import type { AdapterContext, ChatEnvelope } from '../../types/chat-envelope.js';
import type { FormatEnvelope } from '../../types/format-envelope.js';
import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from '../../types/json.js';
import { buildAnthropicRequestFromOpenAIChat } from '../../../codecs/anthropic-openai-codec.js';
import { buildAnthropicFromOpenAIChatWithNative } from '../../../../router/virtual-router/engine-selection/native-compat-action-semantics.js';
import { encodeMetadataPassthrough } from '../../../metadata-passthrough.js';
import { isHubStageTimingDetailEnabled, logHubStageTiming } from '../../pipeline/hub-stage-timing.js';
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
  appendPreservedFieldAudit,
  appendUnsupportedFieldAudit,
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

function getAnthropicSemanticsNode(chat: ChatEnvelope): JsonObject | undefined {
  if (!chat.semantics || typeof chat.semantics !== 'object') {
    return undefined;
  }
  const node = chat.semantics.anthropic;
  return node && isJsonObject(node) ? (node as JsonObject) : undefined;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);
const DEFAULT_HEAVY_INPUT_THRESHOLD = 120_000;

function readBooleanEnv(names: string[], fallback: boolean): boolean {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined) {
      continue;
    }
    const normalized = String(raw).trim().toLowerCase();
    if (TRUTHY.has(normalized)) {
      return true;
    }
    if (FALSY.has(normalized)) {
      return false;
    }
  }
  return fallback;
}

function readPositiveIntEnv(names: string[], fallback: number): number {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined) {
      continue;
    }
    const parsed = Number.parseInt(String(raw).trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

function shouldUseNativeBuild(ctx: AdapterContext): boolean {
  const enabled = readBooleanEnv(
    [
      'ROUTECODEX_HUB_FASTPATH_ANTHROPIC_NATIVE_BUILD',
      'RCC_HUB_FASTPATH_ANTHROPIC_NATIVE_BUILD',
      // backward-compatible manual knob
      'ROUTECODEX_HUB_ANTHROPIC_NATIVE_BUILD',
      'RCC_HUB_ANTHROPIC_NATIVE_BUILD',
    ],
    false,
  );
  if (!enabled) {
    return false;
  }
  const threshold = readPositiveIntEnv(
    [
      'ROUTECODEX_HUB_FASTPATH_INPUT_TOKEN_THRESHOLD',
      'RCC_HUB_FASTPATH_INPUT_TOKEN_THRESHOLD',
    ],
    DEFAULT_HEAVY_INPUT_THRESHOLD,
  );
  const rt = (ctx as Record<string, unknown>).__rt;
  if (
    rt &&
    typeof rt === 'object' &&
    (rt as Record<string, unknown>).hubFastpathHeavyInput === true
  ) {
    return true;
  }
  const estimatedInputTokens = (ctx as Record<string, unknown>).estimatedInputTokens;
  return (
    typeof estimatedInputTokens === 'number' &&
    Number.isFinite(estimatedInputTokens) &&
    estimatedInputTokens >= threshold
  );
}

function hasAnthropicSystemSemantic(chat: ChatEnvelope): boolean {
  try {
    const sysNode =
      chat.semantics && typeof chat.semantics === 'object'
        ? (chat.semantics as Record<string, unknown>).system
        : undefined;
    if (!sysNode || typeof sysNode !== 'object' || Array.isArray(sysNode)) {
      return false;
    }
    return Object.prototype.hasOwnProperty.call(
      sysNode as Record<string, unknown>,
      'blocks',
    );
  } catch {
    return false;
  }
}

function hasChatSystemMessage(chat: ChatEnvelope): boolean {
  return Array.isArray(chat.messages)
    && chat.messages.some((message) => {
      if (!message || typeof message !== 'object') {
        return false;
      }
      return message.role === 'system';
    });
}

export function buildAnthropicFormatEnvelopeFromChat(
  chat: ChatEnvelope,
  ctx: AdapterContext,
): FormatEnvelope {
  const requestId =
    typeof ctx.requestId === 'string' && ctx.requestId.trim().length
      ? ctx.requestId
      : 'unknown';
  const forceDetailLog = isHubStageTimingDetailEnabled();
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
  if (trimmedParameters && Object.prototype.hasOwnProperty.call(trimmedParameters, 'response_format')) {
    appendUnsupportedFieldAudit(chat, {
      field: 'response_format',
      targetProtocol: 'anthropic-messages',
      reason: 'structured_output_not_supported'
    });
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
  if (trimmedParameters && Object.prototype.hasOwnProperty.call(trimmedParameters, 'tool_choice')) {
    appendPreservedFieldAudit(chat, {
      field: 'tool_choice',
      targetProtocol: 'anthropic-messages',
      reason: 'preserved_verbatim_top_level'
    });
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
    const anthropicSemantics = getAnthropicSemanticsNode(chat);
    if (!hasChatSystemMessage(chat)) {
      const sysBlocks = anthropicSemantics?.systemBlocks;
      if (Array.isArray(sysBlocks) && sysBlocks.length > 0) {
        baseRequest.system = jsonClone(sysBlocks as JsonValue[]) as JsonValue;
      } else {
        const sysNode = chat.semantics && typeof chat.semantics === 'object' ? (chat.semantics as any).system : undefined;
        if (sysNode && typeof sysNode === 'object' && !Array.isArray(sysNode) && (sysNode as any).blocks !== undefined) {
          baseRequest.system = jsonClone((sysNode as any).blocks as JsonValue) as JsonValue;
        }
      }
    }
  } catch {
    // ignore
  }
  try {
    const anthropicSemantics = getAnthropicSemanticsNode(chat);
    const extras = chat.semantics && typeof chat.semantics === 'object' ? (chat.semantics as any).providerExtras : undefined;
    const mirror = anthropicSemantics?.messageContentShape;
    if (mirror !== undefined) {
      baseRequest.__anthropicMirror = jsonClone(mirror as JsonValue) as JsonObject;
    } else {
      const legacyMirror = extras && typeof extras === 'object' && !Array.isArray(extras) ? (extras as any).anthropicMirror : undefined;
      if (legacyMirror && typeof legacyMirror === 'object' && !Array.isArray(legacyMirror)) {
        baseRequest.__anthropicMirror = jsonClone(legacyMirror as JsonValue) as JsonObject;
      }
    }
    const providerMetadata = anthropicSemantics?.providerMetadata ??
      (extras && typeof extras === 'object' && !Array.isArray(extras) ? (extras as any).providerMetadata : undefined);
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

  const useNativeBuild = shouldUseNativeBuild(ctx);
  let payloadSource: Record<string, unknown>;
  if (useNativeBuild) {
    logHubStageTiming(requestId, 'req_outbound.anthropic.build_request_native', 'start');
    const nativeBuildStartedAt = Date.now();
    try {
      payloadSource = buildAnthropicFromOpenAIChatWithNative(baseRequest, {
        requestId:
          typeof ctx.requestId === 'string' && ctx.requestId.trim().length
            ? ctx.requestId
            : undefined,
        entryEndpoint:
          typeof ctx.entryEndpoint === 'string' && ctx.entryEndpoint.trim().length
            ? ctx.entryEndpoint
            : undefined,
      });
      if (
        hasAnthropicSystemSemantic(chat) &&
        !Object.prototype.hasOwnProperty.call(
          payloadSource as Record<string, unknown>,
          'system',
        )
      ) {
        throw new Error('native_missing_system_semantic_replay');
      }
      logHubStageTiming(requestId, 'req_outbound.anthropic.build_request_native', 'completed', {
        elapsedMs: Date.now() - nativeBuildStartedAt,
        forceLog: forceDetailLog,
      });
    } catch {
      logHubStageTiming(requestId, 'req_outbound.anthropic.build_request_native', 'completed', {
        elapsedMs: Date.now() - nativeBuildStartedAt,
        forceLog: true,
        fallbackToJs: true,
      });
      logHubStageTiming(requestId, 'req_outbound.anthropic.build_request_js_fallback', 'start');
      const jsFallbackStartedAt = Date.now();
      payloadSource = buildAnthropicRequestFromOpenAIChat(baseRequest, {
        requestId,
      });
      logHubStageTiming(requestId, 'req_outbound.anthropic.build_request_js_fallback', 'completed', {
        elapsedMs: Date.now() - jsFallbackStartedAt,
        forceLog: forceDetailLog,
      });
    }
  } else {
    logHubStageTiming(requestId, 'req_outbound.anthropic.build_request_js', 'start');
    const jsBuildStartedAt = Date.now();
    payloadSource = buildAnthropicRequestFromOpenAIChat(baseRequest, {
      requestId,
    });
    logHubStageTiming(requestId, 'req_outbound.anthropic.build_request_js', 'completed', {
      elapsedMs: Date.now() - jsBuildStartedAt,
      forceLog: forceDetailLog,
    });
  }

  logHubStageTiming(requestId, 'req_outbound.anthropic.payload_sanitize', 'start');
  const sanitizeStartedAt = Date.now();
  const payload = sanitizeAnthropicPayload({
    ...(payloadSource as JsonObject),
  } as JsonObject);
  if (baseRequest.thinking !== undefined) {
    payload.thinking = jsonClone(baseRequest.thinking as JsonValue) as JsonValue;
  }
  if (baseRequest.output_config !== undefined) {
    payload.output_config = jsonClone(baseRequest.output_config as JsonValue) as JsonValue;
  }
  logHubStageTiming(requestId, 'req_outbound.anthropic.payload_sanitize', 'completed', {
    elapsedMs: Date.now() - sanitizeStartedAt,
    forceLog: forceDetailLog,
  });

  return {
    protocol: 'anthropic-messages',
    direction: 'response',
    payload,
    meta: {
      context: ctx
    }
  };
}
