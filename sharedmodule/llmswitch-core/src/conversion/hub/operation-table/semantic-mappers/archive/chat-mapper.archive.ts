import type { SemanticMapper } from '../../../format-adapters/index.js';
import type {
  AdapterContext,
  ChatEnvelope,
  ChatMessage,
  ChatSemantics,
  ChatToolDefinition,
  ChatToolOutput,
  MissingField
} from '../../../types/chat-envelope.js';
import type { FormatEnvelope } from '../../../types/format-envelope.js';
import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from '../../../types/json.js';
import {
  normalizeChatMessageContentWithNative,
  normalizeOpenaiChatMessagesWithNative
} from '../../../../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';
import { ensureProtocolState } from '../../../../protocol-state.js';
import { mapReqInboundBridgeToolsToChatWithNative } from '../../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

const ALLOW_ARCHIVE_IMPORTS =
  process.env.LLMSWITCH_ALLOW_ARCHIVE_IMPORTS === '1' ||
  process.env.ROUTECODEX_ALLOW_ARCHIVE_IMPORTS === '1';

if (!ALLOW_ARCHIVE_IMPORTS) {
  throw new Error(
    '[archive] chat-mapper.archive is fail-closed. Set LLMSWITCH_ALLOW_ARCHIVE_IMPORTS=1 only for explicit parity/compare scripts.'
  );
}

interface ChatPayload extends JsonObject {
  messages?: JsonValue[];
  tools?: JsonValue[];
  tool_outputs?: JsonValue[];
}

const CHAT_PARAMETER_KEYS: readonly string[] = [
  'model',
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'frequency_penalty',
  'presence_penalty',
  'logit_bias',
  'response_format',
  'parallel_tool_calls',
  'tool_choice',
  'seed',
  'user',
  'metadata',
  'stop',
  'stop_sequences',
  'stream'
];

const KNOWN_TOP_LEVEL_FIELDS = new Set<string>([
  'messages',
  'tools',
  'tool_outputs',
  ...CHAT_PARAMETER_KEYS,
  'stageExpectations',
  'stages'
]);

interface NormalizedMessages {
  messages: ChatMessage[];
  systemSegments: string[];
  toolOutputs: ChatToolOutput[];
  missingFields: MissingField[];
}

function flattenSystemContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(flattenSystemContent).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.content === 'string') return obj.content;
    if (Array.isArray(obj.content)) return obj.content.map(flattenSystemContent).join('\n');
  }
  return '';
}

function normalizeToolContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content ?? '');
  }
}

function maybeAugmentRouteCodexApplyPatchPrecheck(content: string): string {
  if (!content || typeof content !== 'string') {
    return content;
  }
  if (content.includes('[RouteCodex precheck]')) {
    return content;
  }
  const lower = content.toLowerCase();
  if (!lower.includes('failed to parse function arguments')) {
    return content;
  }
  if (content.includes('missing field `input`')) {
    return `${content}\n\n[RouteCodex precheck] apply_patch 参数解析失败：缺少字段 "input"。当前 RouteCodex 期望 { input, patch } 形态，并且两个字段都应包含完整统一 diff 文本。`;
  }
  if (content.includes('invalid type: map, expected a string')) {
    return `${content}\n\n[RouteCodex precheck] apply_patch 参数类型错误：检测到 JSON 对象（map），但客户端期望字符串。请先对参数做 JSON.stringify 再写入 arguments，或直接提供 { patch: "<统一 diff>" } 形式。`;
  }
  return content;
}

export function maybeAugmentApplyPatchErrorContent(content: string, toolName?: string): string {
  if (!content) return content;
  const lower = content.toLowerCase();
  const isApplyPatch =
    (typeof toolName === 'string' && toolName.trim() === 'apply_patch') ||
    lower.includes('apply_patch verification failed');
  if (!isApplyPatch) {
    return content;
  }
  // 避免重复追加提示。
  if (content.includes('[apply_patch hint]')) {
    return content;
  }
  const hint =
    '\n\n[apply_patch hint] 在使用 apply_patch 之前，请先读取目标文件的最新内容，并基于该内容生成补丁；同时确保补丁格式符合工具规范（统一补丁格式或结构化参数），避免上下文不匹配或语法错误。';
  return content + hint;
}

function recordToolCallIssues(message: JsonObject, messageIndex: number, missing: MissingField[]): void {
  const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as JsonValue[]) : undefined;
  if (!toolCalls?.length) return;
  toolCalls.forEach((entry, callIndex) => {
    if (!isJsonObject(entry)) {
      missing.push({
        path: `messages[${messageIndex}].tool_calls[${callIndex}]`,
        reason: 'invalid_tool_call_entry',
        originalValue: jsonClone(entry as JsonValue)
      });
      return;
    }
    const fnBlock = (entry as JsonObject).function;
    if (!isJsonObject(fnBlock)) {
      missing.push({
        path: `messages[${messageIndex}].tool_calls[${callIndex}].function`,
        reason: 'missing_tool_function',
        originalValue: jsonClone(fnBlock as JsonValue)
      });
      return;
    }
    const fnName = (fnBlock as JsonObject).name;
    if (typeof fnName !== 'string' || !fnName.trim().length) {
      missing.push({
        path: `messages[${messageIndex}].tool_calls[${callIndex}].function.name`,
        reason: 'missing_tool_name'
      });
    }
  });
}

function collectSystemRawBlocks(raw: JsonValue | undefined): JsonObject[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const blocks: JsonObject[] = [];
  raw.forEach((entry) => {
    if (!isJsonObject(entry)) return;
    if (String(entry.role ?? '').toLowerCase() !== 'system') return;
    blocks.push(jsonClone(entry as JsonObject) as JsonObject);
  });
  return blocks.length ? blocks : undefined;
}

function normalizeChatMessages(raw: JsonValue | undefined): NormalizedMessages {
  const norm: NormalizedMessages = {
    messages: [],
    systemSegments: [],
    toolOutputs: [],
    missingFields: []
  };

  if (raw === undefined) {
    norm.missingFields.push({ path: 'messages', reason: 'absent' });
    return norm;
  }
  const normalizedRaw = Array.isArray(raw)
    ? (normalizeOpenaiChatMessagesWithNative(raw) as JsonValue[])
    : raw;
  if (!Array.isArray(normalizedRaw)) {
    norm.missingFields.push({ path: 'messages', reason: 'invalid_type', originalValue: jsonClone(raw) });
    return norm;
  }

  normalizedRaw.forEach((value, index) => {
    if (!isJsonObject(value)) {
      norm.missingFields.push({ path: `messages[${index}]`, reason: 'invalid_entry', originalValue: jsonClone(value as JsonValue) });
      return;
    }
    const roleValue = value.role;
    if (typeof roleValue !== 'string') {
      norm.missingFields.push({ path: `messages[${index}].role`, reason: 'missing_role' });
      return;
    }
    const chatMessage = value as ChatMessage;
    if (roleValue !== 'system' && roleValue !== 'tool') {
      const normalizedContent = normalizeChatMessageContentWithNative(chatMessage.content);
      const shouldOverwriteContent = !Array.isArray(chatMessage.content);
      if (shouldOverwriteContent && normalizedContent.contentText !== undefined) {
        chatMessage.content = normalizedContent.contentText;
      }
      if (typeof normalizedContent.reasoningText === 'string' && normalizedContent.reasoningText.trim().length) {
        (chatMessage as any).reasoning_content = normalizedContent.reasoningText.trim();
      }
    }
    norm.messages.push(chatMessage);
    const toolCallCandidate = (value as JsonObject).tool_calls;
    if (Array.isArray(toolCallCandidate) && toolCallCandidate.length) {
      recordToolCallIssues(value as JsonObject, index, norm.missingFields);
    }
    if (roleValue === 'system') {
      const segment = flattenSystemContent(chatMessage.content);
      if (segment.trim().length) {
        norm.systemSegments.push(segment);
      }
      return;
    }
    if (roleValue === 'tool') {
      const rawCallId = (value.tool_call_id ?? value.call_id ?? value.id) as JsonValue;
      const toolCallId = typeof rawCallId === 'string' && rawCallId.trim().length ? rawCallId.trim() : undefined;
      if (!toolCallId) {
        norm.missingFields.push({ path: `messages[${index}].tool_call_id`, reason: 'missing_tool_call_id' });
        return;
      }
      const nameValue =
        typeof value.name === 'string' && value.name.trim().length ? value.name : undefined;
      const normalizedToolOutput = normalizeToolContent(value.content ?? value.output);
      const routeCodexPrechecked = maybeAugmentRouteCodexApplyPatchPrecheck(normalizedToolOutput);
      if (routeCodexPrechecked !== normalizedToolOutput) {
        // Keep tool role message content aligned with outbound provider requests (e.g. Chat→Responses),
        // while avoiding double-injection.
        if (typeof chatMessage.content === 'string' || chatMessage.content === undefined || chatMessage.content === null) {
          chatMessage.content = routeCodexPrechecked;
        } else if (typeof (chatMessage as any).output === 'string') {
          (chatMessage as any).output = routeCodexPrechecked;
        }
      }
      const outputEntry: ChatToolOutput = {
        tool_call_id: toolCallId,
        content: routeCodexPrechecked,
        name: nameValue
      };
      outputEntry.content = maybeAugmentApplyPatchErrorContent(outputEntry.content, outputEntry.name);
      norm.toolOutputs.push(outputEntry);
    }
  });

  return norm;
}

function normalizeStandaloneToolOutputs(raw: JsonValue | undefined, missing: MissingField[]): ChatToolOutput[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const outputs: ChatToolOutput[] = [];
  raw.forEach((entry, index) => {
    if (!isJsonObject(entry)) {
      missing.push({ path: `tool_outputs[${index}]`, reason: 'invalid_entry', originalValue: jsonClone(entry as JsonValue) });
      return;
    }
    const rawCallId = entry.tool_call_id ?? entry.call_id ?? entry.id;
    const toolCallId = typeof rawCallId === 'string' && rawCallId.trim().length ? rawCallId.trim() : undefined;
    if (!toolCallId) {
      missing.push({ path: `tool_outputs[${index}].tool_call_id`, reason: 'missing_tool_call_id' });
      return;
    }
    const nameValue = typeof entry.name === 'string' && entry.name.trim().length ? entry.name : undefined;
    const rawContent = normalizeToolContent(entry.content ?? entry.output);
    const content = maybeAugmentApplyPatchErrorContent(rawContent, nameValue);
    outputs.push({
      tool_call_id: toolCallId,
      content,
      name: nameValue
    });
  });
  return outputs;
}

function normalizeTools(raw: JsonValue | undefined, missing: MissingField[]): ChatToolDefinition[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const tools = mapReqInboundBridgeToolsToChatWithNative(raw as unknown[]) as unknown as ChatToolDefinition[];
  if (tools.length === 0) {
    raw.forEach((entry, index) => {
      missing.push({ path: `tools[${index}]`, reason: 'invalid_entry', originalValue: jsonClone(entry as JsonValue) });
    });
  }
  return tools.length ? tools : undefined;
}

function extractParameters(body: ChatPayload): JsonObject | undefined {
  const params: JsonObject = {};
  for (const key of CHAT_PARAMETER_KEYS) {
    if (body[key] !== undefined) {
      params[key] = body[key] as JsonValue;
    }
  }
  return Object.keys(params).length ? params : undefined;
}

function collectExtraFields(body: ChatPayload): JsonObject | undefined {
  const extras: JsonObject = {};
  for (const [key, value] of Object.entries(body)) {
    if (KNOWN_TOP_LEVEL_FIELDS.has(key)) {
      continue;
    }
    if (value !== undefined) {
      extras[key] = jsonClone(value as JsonValue);
    }
  }
  return Object.keys(extras).length ? extras : undefined;
}

function extractOpenAIExtraFieldsFromSemantics(semantics?: ChatSemantics): JsonObject | undefined {
  if (!semantics || !semantics.providerExtras || !isJsonObject(semantics.providerExtras)) {
    return undefined;
  }
  const openaiExtras = (semantics.providerExtras as JsonObject).openaiChat;
  if (!openaiExtras || !isJsonObject(openaiExtras)) {
    return undefined;
  }
  const stored = (openaiExtras as JsonObject).extraFields;
  if (!stored || !isJsonObject(stored)) {
    return undefined;
  }
  return stored as JsonObject;
}

function hasExplicitEmptyToolsSemantics(semantics?: ChatSemantics): boolean {
  if (!semantics || !semantics.tools || !isJsonObject(semantics.tools)) {
    return false;
  }
  const flag = (semantics.tools as Record<string, unknown>).explicitEmpty;
  return flag === true;
}

function buildOpenAISemantics(options: {
  systemSegments?: string[];
  extraFields?: JsonObject;
  explicitEmptyTools?: boolean;
}): ChatSemantics | undefined {
  const semantics: ChatSemantics = {};
  if (options.systemSegments && options.systemSegments.length) {
    semantics.system = {
      textBlocks: options.systemSegments.map((segment) => segment)
    } as JsonObject;
  }
  if (options.extraFields && Object.keys(options.extraFields).length) {
    semantics.providerExtras = {
      openaiChat: {
        extraFields: jsonClone(options.extraFields) as JsonObject
      }
    } as JsonObject;
  }
  if (options.explicitEmptyTools) {
    semantics.tools = {
      explicitEmpty: true
    } as JsonObject;
  }
  return Object.keys(semantics).length ? semantics : undefined;
}

function applyExtraFields(body: ChatPayload, metadata?: ChatEnvelope['metadata'], semantics?: ChatSemantics): void {
  const sources: JsonObject[] = [];
  const semanticsExtras = extractOpenAIExtraFieldsFromSemantics(semantics);
  if (semanticsExtras) {
    sources.push(semanticsExtras);
  }
  if (!sources.length) {
    return;
  }
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (body[key] !== undefined) {
        continue;
      }
      body[key] = jsonClone(value as JsonValue);
    }
  }
}

export class ChatSemanticMapper implements SemanticMapper {
  async toChat(format: FormatEnvelope, ctx: AdapterContext): Promise<ChatEnvelope> {
    const payload = (format.payload ?? {}) as ChatPayload;
    const normalized = normalizeChatMessages(payload.messages);
    const topLevelOutputs = normalizeStandaloneToolOutputs(payload.tool_outputs, normalized.missingFields);
    const toolOutputs = [...normalized.toolOutputs];
    for (const entry of topLevelOutputs) {
      if (!toolOutputs.find(item => item.tool_call_id === entry.tool_call_id)) {
        toolOutputs.push(entry);
      }
    }
    const metadata: ChatEnvelope['metadata'] = { context: ctx };
    const rawSystemBlocks = collectSystemRawBlocks(payload.messages);
    if (rawSystemBlocks) {
      const protocolState = ensureProtocolState(metadata, 'openai');
      protocolState.systemMessages = jsonClone(rawSystemBlocks) as JsonValue;
    }
    if (normalized.missingFields.length) {
      metadata.missingFields = normalized.missingFields;
    }
    const extraFields = collectExtraFields(payload);
    const explicitEmptyTools = Array.isArray(payload.tools) && payload.tools.length === 0;
    const semantics = buildOpenAISemantics({
      systemSegments: normalized.systemSegments,
      extraFields,
      explicitEmptyTools
    });
    return {
      messages: normalized.messages,
      tools: normalizeTools(payload.tools, normalized.missingFields),
      toolOutputs: toolOutputs.length ? toolOutputs : undefined,
      parameters: extractParameters(payload),
      semantics,
      metadata
    };
  }

  async fromChat(chat: ChatEnvelope, ctx: AdapterContext): Promise<FormatEnvelope> {
    const shouldEmitEmptyTools = hasExplicitEmptyToolsSemantics(chat.semantics);
    const payload: ChatPayload = {
      messages: chat.messages,
      tools: chat.tools ?? (shouldEmitEmptyTools ? [] : undefined),
      ...(chat.parameters || {})
    };
    applyExtraFields(payload, chat.metadata, chat.semantics);
    // Do not forward tool_outputs to provider wire formats. OpenAI Chat
    // endpoints expect tool results to appear as tool role messages, and
    // sending the legacy top-level field causes upstream HTTP 400 responses.
    // Concrete translation happens earlier when responses input is unfolded
    // into ChatEnvelope.messages, so the provider request only needs the
    // canonical message list.
    if (payload.max_tokens === undefined && typeof (payload as JsonObject).max_output_tokens === 'number') {
      payload.max_tokens = (payload as JsonObject).max_output_tokens as JsonValue;
      delete (payload as JsonObject).max_output_tokens;
    }
    return {
      protocol: 'openai-chat',
      direction: 'response',
      payload,
      meta: {
        context: ctx
      }
    };
  }
}
