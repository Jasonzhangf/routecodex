import type { SemanticMapper } from '../../format-adapters/index.js';
import type { AdapterContext, ChatEnvelope, ChatSemantics, MissingField } from '../../types/chat-envelope.js';
import type { FormatEnvelope } from '../../types/format-envelope.js';
import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from '../../types/json.js';
import { isHubStageTimingDetailEnabled, logHubStageTiming } from '../../pipeline/hub-stage-timing.js';
import { buildOpenAIChatFromAnthropic, buildAnthropicRequestFromOpenAIChat } from '../../../codecs/anthropic-openai-codec.js';
import { encodeMetadataPassthrough, extractMetadataPassthrough } from '../../../metadata-passthrough.js';
import { buildAnthropicToolAliasMapWithNative } from '../../../../router/virtual-router/engine-selection/native-chat-process-governance-semantics.js';
import { ChatSemanticMapper } from './chat-mapper.js';

interface AnthropicPayload extends JsonObject {
  model?: string;
  messages?: JsonValue;
  tools?: JsonValue;
  stop_sequences?: string[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  max_output_tokens?: number;
  metadata?: JsonObject;
  stream?: boolean;
  tool_choice?: JsonValue;
  thinking?: JsonValue;
  system?: JsonValue;
}

const ANTHROPIC_PARAMETER_KEYS: readonly (keyof AnthropicPayload | 'stop')[] = [
  'model',
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'max_output_tokens',
  'metadata',
  'stream',
  'tool_choice',
  'thinking'
];

const ANTHROPIC_TOP_LEVEL_FIELDS = new Set<string>([
  'model',
  'messages',
  'tools',
  'system',
  'stop_sequences',
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'max_output_tokens',
  'metadata',
  'stream',
  'tool_choice',
  'thinking'
]);

const PASSTHROUGH_METADATA_PREFIX = 'rcc_passthrough_';
const PASSTHROUGH_PARAMETERS: readonly string[] = ['tool_choice'];
const RESPONSES_DROPPED_PARAMETER_KEYS: readonly string[] = [
  'prompt_cache_key',
  'response_format',
  'parallel_tool_calls',
  'service_tier',
  'truncation',
  'include',
  'store'
];

function ensureSemantics(chat: ChatEnvelope): ChatSemantics {
  if (!chat.semantics || typeof chat.semantics !== 'object') {
    chat.semantics = {};
  }
  return chat.semantics;
}

function ensureToolsSemanticsNode(chat: ChatEnvelope): JsonObject {
  const semantics = ensureSemantics(chat);
  if (!semantics.tools || !isJsonObject(semantics.tools)) {
    semantics.tools = {};
  }
  return semantics.tools as JsonObject;
}

function markExplicitEmptyTools(chat: ChatEnvelope): void {
  const semantics = ensureSemantics(chat);
  if (!semantics.tools || !isJsonObject(semantics.tools)) {
    semantics.tools = {};
  }
  (semantics.tools as JsonObject).explicitEmpty = true;
}

function readToolsSemantics(chat: ChatEnvelope): JsonObject | undefined {
  if (!chat.semantics || typeof chat.semantics !== 'object') {
    return undefined;
  }
  const node = chat.semantics.tools;
  return node && isJsonObject(node) ? (node as JsonObject) : undefined;
}

function hasExplicitEmptyToolsSemantics(chat: ChatEnvelope): boolean {
  if (!chat.semantics || typeof chat.semantics !== 'object') {
    return false;
  }
  const toolsNode = chat.semantics.tools;
  if (!toolsNode || !isJsonObject(toolsNode)) {
    return false;
  }
  return Boolean((toolsNode as Record<string, unknown>).explicitEmpty);
}

function sanitizeAnthropicPayload(payload: JsonObject): JsonObject {
  for (const key of Object.keys(payload)) {
    if (!ANTHROPIC_TOP_LEVEL_FIELDS.has(key)) {
      delete payload[key];
    }
  }
  return payload;
}

function collectParameters(payload: AnthropicPayload): JsonObject | undefined {
  const params: JsonObject = {};
  for (const key of ANTHROPIC_PARAMETER_KEYS) {
    if (payload[key as keyof AnthropicPayload] !== undefined) {
      params[key] = payload[key as keyof AnthropicPayload] as JsonValue;
    }
  }
  if (Array.isArray(payload.stop_sequences)) {
    params.stop = payload.stop_sequences;
  }
  return Object.keys(params).length ? params : undefined;
}

function mapReasoningEffortToAnthropicBudget(effort: string): number {
  const normalized = effort.trim().toLowerCase();
  if (normalized === 'minimal' || normalized === 'low') return 1024;
  if (normalized === 'medium') return 4096;
  if (normalized === 'high') return 8192;
  return 4096;
}

function buildAnthropicThinkingFromReasoning(reasoning: unknown): JsonObject | undefined {
  if (reasoning === undefined || reasoning === null) {
    return undefined;
  }
  if (typeof reasoning === 'boolean') {
    if (!reasoning) {
      return { type: 'disabled' };
    }
    return { type: 'enabled', budget_tokens: 4096 };
  }
  if (typeof reasoning === 'string') {
    const normalized = reasoning.trim().toLowerCase();
    if (!normalized.length) {
      return undefined;
    }
    if (normalized === 'off' || normalized === 'none' || normalized === 'disabled' || normalized === 'false') {
      return { type: 'disabled' };
    }
    return {
      type: 'enabled',
      budget_tokens: mapReasoningEffortToAnthropicBudget(normalized)
    };
  }
  if (typeof reasoning === 'number' && Number.isFinite(reasoning)) {
    const budget = Math.max(0, Math.floor(reasoning));
    return budget <= 0
      ? ({ type: 'disabled' } as JsonObject)
      : ({ type: 'enabled', budget_tokens: budget } as JsonObject);
  }
  if (!isJsonObject(reasoning as JsonValue)) {
    return undefined;
  }
  const node = reasoning as Record<string, unknown>;
  const enabledRaw = node.enabled;
  if (enabledRaw === false) {
    return { type: 'disabled' };
  }
  const effortRaw =
    typeof node.effort === 'string'
      ? node.effort
      : typeof node.level === 'string'
        ? node.level
        : undefined;
  const budgetRaw =
    typeof node.budget_tokens === 'number'
      ? node.budget_tokens
      : typeof node.budget === 'number'
        ? node.budget
        : typeof node.max_tokens === 'number'
          ? node.max_tokens
          : undefined;
  if (typeof budgetRaw === 'number' && Number.isFinite(budgetRaw)) {
    const budget = Math.max(0, Math.floor(budgetRaw));
    return budget <= 0
      ? ({ type: 'disabled' } as JsonObject)
      : ({ type: 'enabled', budget_tokens: budget } as JsonObject);
  }
  if (typeof effortRaw === 'string' && effortRaw.trim().length) {
    const normalized = effortRaw.trim().toLowerCase();
    if (normalized === 'off' || normalized === 'none' || normalized === 'disabled') {
      return { type: 'disabled' };
    }
    return {
      type: 'enabled',
      budget_tokens: mapReasoningEffortToAnthropicBudget(normalized)
    };
  }
  if (enabledRaw === true) {
    return { type: 'enabled', budget_tokens: 4096 };
  }
  return { type: 'enabled', budget_tokens: 4096 };
}

function normalizeContextToken(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isArkCodingPlanContext(ctx: AdapterContext | undefined): boolean {
  if (!ctx || typeof ctx !== 'object') {
    return false;
  }
  const candidates = [
    normalizeContextToken(ctx.providerId),
    normalizeContextToken((ctx as Record<string, unknown>).providerKey),
    normalizeContextToken((ctx as Record<string, unknown>).runtimeKey)
  ];
  return candidates.some((candidate) => candidate === 'ark-coding-plan' || candidate.startsWith('ark-coding-plan.'));
}

function cloneAnthropicSystemBlocks(value: JsonValue | undefined): JsonValue[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const blocks = Array.isArray(value) ? value : [value];
  if (!blocks.length) {
    return undefined;
  }
  return blocks.map((entry) => jsonClone(entry as JsonValue)) as JsonValue[];
}

function isResponsesOrigin(chat: ChatEnvelope): boolean {
  const semantics = chat?.semantics as Record<string, unknown> | undefined;
  if (semantics && semantics.responses && isJsonObject(semantics.responses as JsonValue)) {
    return true;
  }
  const ctx = chat?.metadata && typeof chat.metadata === 'object'
    ? ((chat.metadata as Record<string, unknown>).context as Record<string, unknown> | undefined)
    : undefined;
  const protocol = typeof ctx?.providerProtocol === 'string' ? ctx.providerProtocol.trim().toLowerCase() : '';
  if (protocol === 'openai-responses') {
    return true;
  }
  const endpoint = typeof ctx?.entryEndpoint === 'string' ? ctx.entryEndpoint.trim().toLowerCase() : '';
  return endpoint === '/v1/responses';
}

function appendMappingAudit(chat: ChatEnvelope, options: {
  bucket: 'dropped' | 'lossy';
  field: string;
  targetProtocol: string;
  reason: string;
  source?: string;
}): void {
  const metadata = chat.metadata && typeof chat.metadata === 'object'
    ? (chat.metadata as Record<string, unknown>)
    : ((chat.metadata = { context: (chat.metadata as any)?.context ?? {} } as any) as unknown as Record<string, unknown>);
  const root =
    metadata.mappingAudit && typeof metadata.mappingAudit === 'object' && !Array.isArray(metadata.mappingAudit)
      ? (metadata.mappingAudit as Record<string, unknown>)
      : ((metadata.mappingAudit = {}) as Record<string, unknown>);
  const current = Array.isArray(root[options.bucket]) ? (root[options.bucket] as Array<Record<string, unknown>>) : [];
  const duplicate = current.find((entry) =>
    entry &&
    entry.field === options.field &&
    entry.targetProtocol === options.targetProtocol &&
    entry.reason === options.reason
  );
  if (!duplicate) {
    current.push({
      field: options.field,
      source: options.source ?? 'chat.parameters',
      targetProtocol: options.targetProtocol,
      reason: options.reason
    });
  }
  root[options.bucket] = current as unknown as JsonValue;
}

function appendDroppedFieldAudit(chat: ChatEnvelope, options: {
  field: string;
  targetProtocol: string;
  reason: string;
}): void {
  appendMappingAudit(chat, {
    bucket: 'dropped',
    ...options
  });
}

function appendLossyFieldAudit(chat: ChatEnvelope, options: {
  field: string;
  targetProtocol: string;
  reason: string;
}): void {
  appendMappingAudit(chat, {
    bucket: 'lossy',
    ...options
  });
}

export class AnthropicSemanticMapper implements SemanticMapper {
  private readonly chatMapper = new ChatSemanticMapper();
  async toChat(format: FormatEnvelope, ctx: AdapterContext): Promise<ChatEnvelope> {
    const payload = (format.payload ?? {}) as AnthropicPayload;
    const missing: MissingField[] = [];
    if (!Array.isArray(payload.messages)) missing.push({ path: 'messages', reason: 'absent' });
    if (typeof payload.model !== 'string') missing.push({ path: 'model', reason: 'absent' });
    const passthrough = extractMetadataPassthrough(payload.metadata, {
      prefix: PASSTHROUGH_METADATA_PREFIX,
      keys: PASSTHROUGH_PARAMETERS
    });

    const openaiPayload = buildOpenAIChatFromAnthropic(payload);
    const canonicalContext: AdapterContext = {
      ...ctx,
      providerProtocol: 'openai-chat',
      entryEndpoint: ctx.entryEndpoint || '/v1/chat/completions'
    };
    const chatEnvelope = await this.chatMapper.toChat(
      {
        protocol: 'openai-chat',
        direction: 'request',
        payload: openaiPayload as JsonObject
      },
      canonicalContext
    );

    const metadata: ChatEnvelope['metadata'] = chatEnvelope.metadata ?? { context: canonicalContext };
    chatEnvelope.metadata = metadata;
    metadata.context = canonicalContext;
    const semantics = ensureSemantics(chatEnvelope);
    if (!semantics.system || !isJsonObject(semantics.system)) {
      semantics.system = {};
    }
    if (!semantics.providerExtras || !isJsonObject(semantics.providerExtras)) {
      semantics.providerExtras = {};
    }
    const systemBlocks = cloneAnthropicSystemBlocks(payload.system);
    if (systemBlocks) {
      (semantics.system as JsonObject).blocks = jsonClone(systemBlocks as JsonValue) as JsonValue;
    }
    if (payload.tools && Array.isArray(payload.tools) && payload.tools.length === 0) {
      markExplicitEmptyTools(chatEnvelope);
    }
    const aliasMap = buildAnthropicToolAliasMapWithNative(payload.tools);
    if (aliasMap) {
      const toolsNode = ensureToolsSemanticsNode(chatEnvelope);
      (toolsNode as JsonObject).toolNameAliasMap = jsonClone(aliasMap as JsonObject as JsonValue) as JsonObject;
    }
    if (Array.isArray(payload.messages) && payload.messages.length) {
      const shapes = payload.messages.map((entry) => {
        if (!entry || typeof entry !== 'object') {
          return 'unknown';
        }
        const rawContent = (entry as Record<string, unknown>).content;
        if (typeof rawContent === 'string') {
          return 'string';
        }
        if (Array.isArray(rawContent)) {
          return 'array';
        }
        if (rawContent === null || rawContent === undefined) {
          return 'null';
        }
        return typeof rawContent;
      });
      const mirrorNode: JsonObject = { messageContentShape: shapes as unknown as JsonValue };
      (semantics.providerExtras as JsonObject).anthropicMirror = jsonClone(mirrorNode) as JsonObject;
    }
    if (missing.length) {
      metadata.missingFields = Array.isArray(metadata.missingFields)
        ? [...metadata.missingFields, ...missing]
        : missing;
    }
    const providerMetadata =
      passthrough.metadata ??
      (payload.metadata && isJsonObject(payload.metadata) ? (jsonClone(payload.metadata) as JsonObject) : undefined);
    if (providerMetadata) {
      (semantics.providerExtras as JsonObject).providerMetadata = jsonClone(providerMetadata) as JsonObject;
    }

    const mergedParameters: JsonObject = { ...(chatEnvelope.parameters ?? {}) };
    const mergeParameters = (source?: JsonObject): void => {
      if (!source) {
        return;
      }
      for (const [key, value] of Object.entries(source)) {
        if (mergedParameters[key] !== undefined) {
          continue;
        }
        mergedParameters[key] = jsonClone(value as JsonValue) as JsonValue;
      }
    };
    mergeParameters(collectParameters(payload));
    if (providerMetadata) {
      mergedParameters.metadata = jsonClone(providerMetadata) as JsonValue;
    }
    if (passthrough.passthrough) {
      for (const [key, value] of Object.entries(passthrough.passthrough)) {
        mergedParameters[key] = jsonClone(value as JsonValue) as JsonValue;
      }
    }
    if (Object.keys(mergedParameters).length) {
      chatEnvelope.parameters = mergedParameters;
    } else {
      delete chatEnvelope.parameters;
    }
    return chatEnvelope;
  }

  async fromChat(chat: ChatEnvelope, ctx: AdapterContext): Promise<FormatEnvelope> {
    const requestId = typeof ctx.requestId === 'string' && ctx.requestId.trim().length ? ctx.requestId : 'unknown';
    const forceDetailLog = isHubStageTimingDetailEnabled();
    logHubStageTiming(requestId, 'req_outbound.anthropic.build_request', 'start');
    const startedAt = Date.now();
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
    const rawReasoning = trimmedParameters?.reasoning;
    const mappedThinking = buildAnthropicThinkingFromReasoning(rawReasoning);
    if (mappedThinking && baseRequest.thinking === undefined) {
      baseRequest.thinking = mappedThinking;
    }
    if (
      baseRequest.thinking === undefined &&
      rawReasoning === undefined &&
      isArkCodingPlanContext(ctx)
    ) {
      baseRequest.thinking = {
        type: 'enabled',
        budget_tokens: mapReasoningEffortToAnthropicBudget('high')
      };
    }
    if (responsesOrigin && trimmedParameters && Object.prototype.hasOwnProperty.call(trimmedParameters, 'reasoning')) {
      appendLossyFieldAudit(chat, {
        field: 'reasoning',
        targetProtocol: 'anthropic-messages',
        reason: 'normalized_to_anthropic_thinking_budget'
      });
    }
    // 出站阶段不再直接透传其它协议的 providerMetadata，避免跨协议打洞；
    // Anthropic 自身入口的 metadata 已在入站阶段通过 collectParameters/encodeMetadataPassthrough
    // 按白名单收集，这里仅依赖这些显式映射结果。
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
        // Only for anthropic-native endpoint: allow restoring anthropic metadata back into outbound.
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
    logHubStageTiming(requestId, 'req_outbound.anthropic.codec_build', 'start');
    const codecBuildStart = Date.now();
    const payloadSource = buildAnthropicRequestFromOpenAIChat(baseRequest);
    logHubStageTiming(requestId, 'req_outbound.anthropic.codec_build', 'completed', {
      elapsedMs: Date.now() - codecBuildStart,
      forceLog: forceDetailLog
    });
    logHubStageTiming(requestId, 'req_outbound.anthropic.payload_clone', 'start');
    const payloadCloneStart = Date.now();
    const payload = sanitizeAnthropicPayload(JSON.parse(JSON.stringify(payloadSource)) as JsonObject);
    sanitizeAnthropicPayload(payload);
    logHubStageTiming(requestId, 'req_outbound.anthropic.payload_clone', 'completed', {
      elapsedMs: Date.now() - payloadCloneStart,
      forceLog: forceDetailLog
    });
    const result: FormatEnvelope = {
      protocol: 'anthropic-messages',
      direction: 'response',
      payload,
      meta: {
        context: ctx
      }
    };
    logHubStageTiming(requestId, 'req_outbound.anthropic.build_request', 'completed', {
      elapsedMs: Date.now() - startedAt,
      forceLog: forceDetailLog
    });
    return result;
  }
}
