import type {
  AdapterContext,
  ChatEnvelope,
  ChatMessage,
  ChatSemantics,
  ChatToolDefinition,
  ChatToolOutput
} from '../../types/chat-envelope.js';
import { ensureProtocolState } from '../../../protocol-state.js';
import { isJsonObject, jsonClone, type JsonObject, type JsonValue } from '../../types/json.js';
import { mapReqInboundBridgeToolsToChatWithNative } from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';
import { augmentApplyPatchErrorContentWithNative } from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-semantic-mappers.js';

export interface ChatPayload extends JsonObject {
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

export function tryMapOpenaiChatToChatFast(
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
  return augmentApplyPatchErrorContentWithNative(content, toolName);
}
