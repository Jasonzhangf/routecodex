import type { SemanticMapper } from '../../format-adapters/index.js';
import type {
  AdapterContext,
  ChatEnvelope,
  ChatMessage,
  ChatSemantics,
  ChatToolDefinition,
  ChatToolOutput
} from '../../types/chat-envelope.js';
import type { FormatEnvelope } from '../../types/format-envelope.js';
import { ensureProtocolState } from '../../../protocol-state.js';
import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from '../../types/json.js';
import {
  mapOpenaiChatFromChatWithNative,
  mapOpenaiChatToChatWithNative
} from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-semantic-mappers.js';
import { mapReqInboundBridgeToolsToChatWithNative } from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

interface ChatPayload extends JsonObject {
  messages?: JsonValue[];
  tools?: JsonValue[];
  tool_outputs?: JsonValue[];
}

const CHAT_PARAMETER_KEYS = [
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
] as const;

const KNOWN_TOP_LEVEL_FIELDS = new Set<string>([
  'messages',
  'tools',
  'tool_outputs',
  ...CHAT_PARAMETER_KEYS,
  'stageExpectations',
  'stages'
]);

function flattenSystemContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(flattenSystemContent).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    const row = content as Record<string, unknown>;
    if (typeof row.text === 'string') {
      return row.text;
    }
    if (typeof row.content === 'string') {
      return row.content;
    }
    if (Array.isArray(row.content)) {
      return row.content.map(flattenSystemContent).filter(Boolean).join('\n');
    }
  }
  return '';
}

function normalizeToolContent(content: unknown): string {
  if (content === null || content === undefined) {
    return '执行成功（无输出）';
  }
  if (typeof content === 'string') {
    return content.trim().length ? content : '执行成功（无输出）';
  }
  if (typeof content === 'object') {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

function isEmptyAssistantContent(content: unknown): boolean {
  if (content === null || content === undefined) {
    return true;
  }
  if (typeof content === 'string') {
    return content.trim().length === 0;
  }
  if (Array.isArray(content)) {
    const joined = content
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
      .map((entry) => (typeof entry.text === 'string' ? entry.text : ''))
      .join('');
    return joined.trim().length === 0;
  }
  return false;
}

function collectSystemRawBlocks(raw: JsonValue | undefined): JsonObject[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const blocks: JsonObject[] = [];
  for (const entry of raw) {
    if (!isJsonObject(entry)) {
      continue;
    }
    if (String(entry.role ?? '').toLowerCase() !== 'system') {
      continue;
    }
    blocks.push(jsonClone(entry as JsonObject) as JsonObject);
  }
  return blocks.length ? blocks : undefined;
}

function collectExtraFields(payload: ChatPayload): JsonObject | undefined {
  const extras: JsonObject = {};
  for (const [key, value] of Object.entries(payload)) {
    if (KNOWN_TOP_LEVEL_FIELDS.has(key) || value === undefined) {
      continue;
    }
    extras[key] = jsonClone(value as JsonValue);
  }
  return Object.keys(extras).length ? extras : undefined;
}

function extractParameters(payload: ChatPayload): JsonObject | undefined {
  const parameters: JsonObject = {};
  for (const key of CHAT_PARAMETER_KEYS) {
    if (payload[key] !== undefined) {
      parameters[key] = payload[key] as JsonValue;
    }
  }
  return Object.keys(parameters).length ? parameters : undefined;
}

function buildOpenaiSemantics(
  systemSegments: string[],
  extraFields: JsonObject | undefined,
  explicitEmptyTools: boolean
): ChatSemantics | undefined {
  const semantics: ChatSemantics = {};
  if (systemSegments.length > 0) {
    semantics.system = {
      textBlocks: systemSegments
    } as JsonObject;
  }
  if (extraFields && Object.keys(extraFields).length > 0) {
    semantics.providerExtras = {
      openaiChat: {
        extraFields
      }
    } as JsonObject;
  }
  if (explicitEmptyTools) {
    semantics.tools = {
      explicitEmpty: true
    } as JsonObject;
  }
  return Object.keys(semantics).length > 0 ? semantics : undefined;
}

function normalizeAssistantToolCallsFast(message: Record<string, unknown>): Record<string, unknown>[] | undefined | null {
  if (message.tool_calls === undefined) {
    return undefined;
  }
  if (!Array.isArray(message.tool_calls)) {
    return null;
  }
  const normalized: Record<string, unknown>[] = [];
  for (const entry of message.tool_calls) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }
    const toolCall = entry as Record<string, unknown>;
    const functionNode =
      toolCall.function && typeof toolCall.function === 'object' && !Array.isArray(toolCall.function)
        ? (toolCall.function as Record<string, unknown>)
        : undefined;
    if (!functionNode) {
      return null;
    }
    const rawName = typeof functionNode.name === 'string' ? functionNode.name.trim() : '';
    if (!rawName) {
      return null;
    }
    const rawArguments = functionNode.arguments;
    if (rawArguments !== undefined && rawArguments !== null && typeof rawArguments !== 'string') {
      return null;
    }
    const dot = rawName.indexOf('.');
    const normalizedName = dot >= 0 ? rawName.slice(dot + 1).trim() : rawName;
    if (!normalizedName) {
      return null;
    }
    normalized.push({
      ...toolCall,
      function: {
        ...functionNode,
        name: normalizedName,
        arguments: typeof rawArguments === 'string' ? rawArguments : '{}'
      }
    });
  }
  return normalized;
}

function normalizeToolDefinitionsFast(rawTools: JsonValue[] | undefined): ChatToolDefinition[] | undefined | null {
  if (rawTools === undefined) {
    return undefined;
  }
  if (!Array.isArray(rawTools)) {
    return null;
  }
  if (rawTools.length === 0) {
    return undefined;
  }
  const mapped = mapReqInboundBridgeToolsToChatWithNative(rawTools as unknown[]) as ChatToolDefinition[];
  return mapped.length > 0 ? mapped : null;
}

function tryMapOpenaiChatToChatFast(
  payload: ChatPayload,
  ctx: AdapterContext
): ChatEnvelope | undefined {
  if (!Array.isArray(payload.messages) || payload.tool_outputs !== undefined) {
    return undefined;
  }

  const normalizedMessages: ChatMessage[] = [];
  const toolOutputs: ChatToolOutput[] = [];
  const seenToolOutputIds = new Set<string>();
  const systemSegments: string[] = [];

  for (const entry of payload.messages) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return undefined;
    }
    const message = entry as Record<string, unknown>;
    const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
      return undefined;
    }

    const nextMessage: ChatMessage = {
      ...(jsonClone(message as JsonObject) as ChatMessage),
      role: role as ChatMessage['role']
    };

    if (role === 'assistant') {
      const normalizedToolCalls = normalizeAssistantToolCallsFast(message);
      if (normalizedToolCalls === null) {
        return undefined;
      }
      if (normalizedToolCalls !== undefined) {
        nextMessage.tool_calls = normalizedToolCalls as any;
      }
      const content = nextMessage.content;
      if (
        content !== undefined &&
        content !== null &&
        typeof content !== 'string' &&
        !Array.isArray(content) &&
        typeof content !== 'object'
      ) {
        nextMessage.content = String(content);
      }
      if ((nextMessage.tool_calls?.length ?? 0) === 0 && isEmptyAssistantContent(nextMessage.content)) {
        continue;
      }
      normalizedMessages.push(nextMessage);
      continue;
    }

    if (role === 'tool') {
      const rawToolCallId = message.tool_call_id ?? message.call_id ?? message.id;
      const toolCallId = typeof rawToolCallId === 'string' ? rawToolCallId.trim() : '';
      if (!toolCallId) {
        return undefined;
      }
      nextMessage.tool_call_id = toolCallId;
      nextMessage.content = normalizeToolContent(message.content ?? message.output);
      const name = typeof message.name === 'string' && message.name.trim().length ? message.name.trim() : undefined;
      if (!seenToolOutputIds.has(toolCallId)) {
        seenToolOutputIds.add(toolCallId);
        toolOutputs.push({
          tool_call_id: toolCallId,
          content: maybeAugmentApplyPatchErrorContent(nextMessage.content, name),
          ...(name ? { name } : {})
        });
      }
      normalizedMessages.push(nextMessage);
      continue;
    }

    if (role === 'system') {
      const segment = flattenSystemContent(message.content);
      if (segment.trim().length > 0) {
        systemSegments.push(segment);
      }
    } else {
      const content = nextMessage.content;
      if (
        content !== undefined &&
        content !== null &&
        typeof content !== 'string' &&
        !Array.isArray(content) &&
        typeof content !== 'object'
      ) {
        nextMessage.content = String(content);
      }
    }

    normalizedMessages.push(nextMessage);
  }

  const tools = normalizeToolDefinitionsFast(payload.tools);
  if (tools === null) {
    return undefined;
  }

  const metadata: ChatEnvelope['metadata'] = { context: ctx };
  const rawSystemBlocks = collectSystemRawBlocks(payload.messages);
  if (rawSystemBlocks) {
    const protocolState = ensureProtocolState(metadata, 'openai');
    protocolState.systemMessages = jsonClone(rawSystemBlocks as unknown as JsonValue) as JsonObject;
  }
  const parameters = extractParameters(payload);
  const extraFields = collectExtraFields(payload);
  const semantics = buildOpenaiSemantics(
    systemSegments,
    extraFields,
    Array.isArray(payload.tools) && payload.tools.length === 0
  );

  return {
    messages: normalizedMessages,
    ...(tools ? { tools } : {}),
    ...(toolOutputs.length > 0 ? { toolOutputs } : {}),
    ...(parameters ? { parameters } : {}),
    ...(semantics ? { semantics } : {}),
    metadata
  };
}

export function maybeAugmentApplyPatchErrorContent(content: string, toolName?: string): string {
  if (!content) return content;
  const lower = content.toLowerCase();
  const isApplyPatch =
    (typeof toolName === 'string' && toolName.trim() === 'apply_patch') ||
    lower.includes('apply_patch verification failed') ||
    lower.includes('failed to apply patch');
  if (!isApplyPatch) {
    return content;
  }
  if (content.includes('[apply_patch hint]') || content.includes('[RouteCodex hint] apply_patch')) {
    return content;
  }
  const sandboxSignal = lower.includes('sandbox(signal(9))') || (lower.includes('sandbox') && lower.includes('signal(9)'));
  if (sandboxSignal) {
    return content +
      '\n\n[RouteCodex hint] apply_patch \u88ab sandbox \u7ec8\u6b62 (Signal 9)\u3002\u5e38\u89c1\u539f\u56e0\u662f\u8865\u4e01\u6d89\u53ca workspace \u4e4b\u5916\u7684\u8def\u5f84\u3002\u8bf7\u6539\u7528\u5f53\u524d workspace \u5185\u8def\u5f84\uff0c\u6216\u5c06\u76ee\u6807\u4ed3\u52a0\u5165 workspaces/workdir \u540e\u518d\u8c03\u7528 apply_patch\u3002';
  }
  const missingPath =
    lower.includes('failed to read file to update') ||
    lower.includes('no such file or directory');
  if (missingPath) {
    return content +
      '\n\n[RouteCodex hint] apply_patch \u8bfb\u53d6\u76ee\u6807\u6587\u4ef6\u5931\u8d25\uff1a\u8def\u5f84\u4e0d\u5b58\u5728\u6216\u4e0d\u5728\u5f53\u524d workspace\u3002\u8bf7\u786e\u8ba4\u8def\u5f84\u5728\u5f53\u524d workspace \u5185\u4e14\u6587\u4ef6\u771f\u5b9e\u5b58\u5728\uff1b\u8def\u5f84\u5fc5\u987b\u4e3a workspace \u76f8\u5bf9\u8def\u5f84\uff08\u5982 src/...\uff09\uff0c\u4e0d\u8981\u4ee5 / \u6216\u76d8\u7b26\u5f00\u5934\u3002\u5fc5\u8981\u65f6\u5207\u6362 workspace/workdir\u3002';
  }
  return content +
    '\n\n[apply_patch hint] \u5728\u4f7f\u7528 apply_patch \u4e4b\u524d\uff0c\u8bf7\u5148\u8bfb\u53d6\u76ee\u6807\u6587\u4ef6\u7684\u6700\u65b0\u5185\u5bb9\uff0c\u5e76\u57fa\u4e8e\u8be5\u5185\u5bb9\u751f\u6210\u8865\u4e01\uff1b\u540c\u65f6\u786e\u4fdd\u8865\u4e01\u683c\u5f0f\u7b26\u5408\u5de5\u5177\u89c4\u8303\uff08\u7edf\u4e00\u8865\u4e01\u683c\u5f0f\u6216\u7ed3\u6784\u5316\u53c2\u6570\uff09\uff0c\u907f\u514d\u4e0a\u4e0b\u6587\u4e0d\u5339\u914d\u6216\u8bed\u6cd5\u9519\u8bef\u3002';
}

export class ChatSemanticMapper implements SemanticMapper {
  async toChat(format: FormatEnvelope, ctx: AdapterContext): Promise<ChatEnvelope> {
    const payload = (format.payload ?? {}) as ChatPayload;
    const fastMapped = tryMapOpenaiChatToChatFast(payload, ctx);
    if (fastMapped) {
      return fastMapped;
    }
    return mapOpenaiChatToChatWithNative(
      payload as Record<string, unknown>,
      ctx as unknown as Record<string, unknown>
    ) as unknown as ChatEnvelope;
  }

  async fromChat(chat: ChatEnvelope, ctx: AdapterContext): Promise<FormatEnvelope> {
    return mapOpenaiChatFromChatWithNative(
      chat as unknown as Record<string, unknown>,
      ctx as unknown as Record<string, unknown>
    ) as unknown as FormatEnvelope;
  }
}
