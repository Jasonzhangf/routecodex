import type { SharedPipelineRequest, SharedPipelineResponse } from '../../../../../../types/shared-dtos.js';
import { normalizeArgumentsBySchema } from '../../utils/arguments-normalizer.js';
import { normalizeTools } from '../../utils/tool-schema-normalizer.js';

export type ResponsesContentPart = {
  type: string;
  text?: string;
  content?: unknown;
};

export type ResponsesInputItem = {
  type: string;
  role?: string;
  content?: Array<ResponsesContentPart> | null;
  name?: string;
  arguments?: unknown;
  call_id?: string;
  output?: unknown;
  function?: {
    name?: string;
    arguments?: unknown;
  };
  message?: {
    role?: string;
    content?: Array<ResponsesContentPart>;
  };
  id?: string;
  tool_call_id?: string;
  tool_use_id?: string;
  text?: string;
};

export type ResponsesToolDefinition = {
  type: string;
  name?: string;
  description?: string;
  strict?: boolean;
  parameters?: unknown;
};

export interface ResponsesRequestContext {
  requestId?: string;
  instructions?: string;
  input?: ResponsesInputItem[];
  include?: unknown;
  store?: unknown;
  toolChoice?: unknown;
  parallelToolCalls?: boolean;
  metadata?: Record<string, unknown> | undefined;
  responseFormat?: unknown;
  stream?: boolean;
  isChatPayload?: boolean;
  isResponsesPayload?: boolean;
  historyMessages?: Array<{ role: string; content: string }>;
  currentMessage?: { role: string; content: string } | null;
  toolsRaw?: ResponsesToolDefinition[];
  toolsNormalized?: Array<Record<string, unknown>>;
}

export interface BuildChatRequestResult {
  request: Record<string, unknown>;
  toolsNormalized?: Array<Record<string, unknown>>;
}

export function captureResponsesContext(payload: Record<string, unknown>, dto?: SharedPipelineRequest | undefined): ResponsesRequestContext {
  const context: ResponsesRequestContext = {
    requestId: dto?.route?.requestId,
    instructions: typeof payload.instructions === 'string' ? payload.instructions : undefined,
    input: Array.isArray(payload.input) ? (payload.input as ResponsesInputItem[]) : undefined,
    include: payload.include,
    store: payload.store,
    toolChoice: payload.tool_choice,
    parallelToolCalls: typeof payload.parallel_tool_calls === 'boolean' ? payload.parallel_tool_calls : undefined,
    metadata: (payload.metadata && typeof payload.metadata === 'object') ? (payload.metadata as Record<string, unknown>) : undefined,
    responseFormat: payload.response_format,
    stream: payload.stream === true,
    isChatPayload: Array.isArray(payload.messages)
  };
  if (Array.isArray((payload as any).tools)) {
    context.toolsRaw = (payload as any).tools as ResponsesToolDefinition[];
  }
  context.isResponsesPayload = !context.isChatPayload && Array.isArray(context.input);
  return context;
}

export function buildChatRequestFromResponses(payload: Record<string, unknown>, context: ResponsesRequestContext): BuildChatRequestResult {
  const toolsNormalized = Array.isArray(payload.tools)
    ? normalizeTools(payload.tools as ResponsesToolDefinition[]) as Array<Record<string, unknown>>
    : undefined;

  const messages = mapResponsesInputToChat({
    instructions: context.instructions,
    input: context.input,
    toolsNormalized
  });
  if (!messages.length) {
    throw new Error('Responses payload produced no chat messages');
  }

  const result: Record<string, unknown> = {
    model: payload.model,
    messages
  };

  if (payload.temperature !== undefined) {
    result.temperature = payload.temperature;
  }
  if (payload.top_p !== undefined) {
    result.top_p = payload.top_p;
  }

  const modelStr = typeof payload.model === 'string' ? payload.model : '';
  const isGLM = /\bglm\b|zhipu|bigmodel/i.test(modelStr);
  const pickMax = (val: unknown): number | undefined => {
    if (typeof val === 'number' && isFinite(val)) {
      const n = Math.max(1, Math.floor(val));
      return isGLM ? Math.min(n, 8192) : n;
    }
    return undefined;
  };
  const mo = pickMax((payload as any).max_output_tokens);
  const mt = pickMax((payload as any).max_tokens);
  if (typeof mo === 'number') {
    result.max_tokens = mo;
  }
  if (typeof mt === 'number') {
    result.max_tokens = mt;
  }
  if (payload.frequency_penalty !== undefined) {
    result.frequency_penalty = payload.frequency_penalty;
  }
  if (payload.presence_penalty !== undefined) {
    result.presence_penalty = payload.presence_penalty;
  }
  if (payload.response_format !== undefined) {
    result.response_format = payload.response_format;
  }
  if (Array.isArray(payload.tools)) {
    result.tools = toolsNormalized;
  }
  const hasToolResult = Array.isArray(context.input)
    && context.input.some((it: ResponsesInputItem) => it && typeof it === 'object'
      && ['function_call_output', 'tool_result', 'tool_message'].includes(String(it.type || '').toLowerCase()));
  if (!hasToolResult && payload.tool_choice !== undefined) {
    result.tool_choice = payload.tool_choice;
  }
  if (payload.parallel_tool_calls !== undefined) {
    result.parallel_tool_calls = payload.parallel_tool_calls;
  }
  if (payload.user !== undefined) {
    result.user = payload.user;
  }
  if (payload.logit_bias !== undefined) {
    result.logit_bias = payload.logit_bias;
  }
  if (payload.seed !== undefined) {
    result.seed = payload.seed;
  }
  if (payload.stream !== undefined) {
    result.stream = payload.stream;
  }

  return { request: result, toolsNormalized };
}

export function buildResponsesPayloadFromChat(
  payload: unknown,
  context?: ResponsesRequestContext
): Record<string, unknown> | unknown {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const response = unwrapData(payload as Record<string, unknown>);
  if (!response || typeof response !== 'object') {
    return payload;
  }

  const respObjectType = (response as any).object;
  if (respObjectType === 'response' && Array.isArray((response as any).output)) {
    return response;
  }

  const choices = Array.isArray((response as any).choices) ? (response as any).choices : [];
  const primaryChoice = choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : undefined;
  const message = primaryChoice && typeof primaryChoice.message === 'object' ? primaryChoice.message as Record<string, unknown> : undefined;
  const role = message?.role || 'assistant';
  const content = message?.content;
  const reasoningText = typeof (message as any)?.reasoning_content === 'string'
    && ((message as any).reasoning_content as string).trim().length
      ? String((message as any).reasoning_content).trim()
      : undefined;

  const outputItems: Array<Record<string, unknown>> = [];
  if (reasoningText) {
    outputItems.push({
      type: 'reasoning',
      summary: [],
      content: [{ type: 'output_text', text: reasoningText }]
    });
  }
  const convertedContent = convertChatContentToResponses(content);
  if (convertedContent.length > 0) {
    outputItems.push({
      type: 'message',
      message: {
        role,
        content: convertedContent
      }
    });
  }

  const toolCalls = Array.isArray(message?.tool_calls) ? (message!.tool_calls as Array<Record<string, unknown>>) : [];
  if (toolCalls.length > 0) {
    const toolsNorm = Array.isArray(context?.toolsNormalized)
      ? context?.toolsNormalized
      : normalizeTools(((context as any)?.toolsRaw || (context as any)?.metadata?.tools || []));
    for (const call of toolCalls) {
      const toolId = typeof call.id === 'string'
        ? call.id
        : `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const fn = (call && typeof call.function === 'object') ? (call.function as Record<string, unknown>) : undefined;
      const fnName = typeof fn?.name === 'string' ? (fn.name as string) : undefined;
      const rawArgs = fn?.arguments;
      const serializedArgsRaw = typeof rawArgs === 'string'
        ? rawArgs
        : (rawArgs && typeof rawArgs === 'object' ? JSON.stringify(rawArgs) : '');
      const serializedArgs = normalizeArgumentsBySchema(serializedArgsRaw, fnName, toolsNorm);

      outputItems.push({
        type: 'function_call',
        id: toolId,
        call_id: toolId,
        name: fnName,
        arguments: serializedArgs,
        status: 'in_progress'
      });
    }
  }

  const usage = (response as any).usage;
  const outputText = extractOutputText(convertedContent, toolCalls);
  const hasToolCalls = toolCalls.length > 0;
  const status = hasToolCalls && !outputText ? 'in_progress' : 'completed';

  const out: any = {
    id: (response as any).id || `resp-${Date.now()}`,
    object: 'response',
    created_at: (response as any).created_at || (response as any).created || Math.floor(Date.now() / 1000),
    model: (response as any).model,
    status,
    output: outputItems,
    output_text: outputText || '',
    ...(usage ? { usage } : {}),
    metadata: context?.metadata,
    instructions: context?.instructions,
    parallel_tool_calls: context?.parallelToolCalls,
    tool_choice: context?.toolChoice,
    include: context?.include,
    store: context?.store
  };

  return out;
}

function mapResponsesInputToChat(options: {
  instructions?: string;
  input?: ResponsesInputItem[];
  toolsNormalized?: Array<Record<string, unknown>>;
}): Array<Record<string, unknown>> {
  const { instructions, input, toolsNormalized } = options;
  const messages: Array<Record<string, unknown>> = [];

  if (typeof instructions === 'string') {
    const trimmed = instructions.trim();
    if (trimmed.length) {
      messages.push({ role: 'system', content: trimmed });
    }
  }

  if (!Array.isArray(input)) {
    return messages;
  }

  const toolNameById = new Map<string, string>();
  let lastToolCallId: string | null = null;

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const entryType = typeof entry.type === 'string' ? entry.type.toLowerCase() : 'message';

    if (entryType === 'function_call' || entryType === 'tool_call') {
      const name = typeof entry.name === 'string'
        ? entry.name
        : (typeof entry?.function?.name === 'string' ? entry.function.name : undefined);
      const args = entry.arguments ?? entry?.function?.arguments ?? {};
      const parsedArgs = parseFunctionArguments(args);
      const callId = typeof entry.id === 'string'
        ? entry.id
        : (typeof entry.call_id === 'string' ? entry.call_id : `call_${Math.random().toString(36).slice(2, 8)}`);
      const fnName = name ?? 'tool';
      const serialized = serializeArgsStrict(parsedArgs, fnName, toolsNormalized).trim();
      toolNameById.set(callId, fnName);
      messages.push({
        role: 'assistant',
        tool_calls: [{ id: callId, type: 'function', function: { name: fnName, arguments: serialized } }]
      });
      lastToolCallId = callId;
      continue;
    }

    if (entryType === 'function_call_output' || entryType === 'tool_result' || entryType === 'tool_message') {
      const toolCallId = entry.tool_call_id || entry.call_id || entry.tool_use_id || entry.id || lastToolCallId;
      const output = normalizeToolOutput(entry);
      if (toolCallId && output) {
        messages.push({ role: 'tool', tool_call_id: String(toolCallId), content: output });
        lastToolCallId = null;
      }
      continue;
    }

    const { text, toolCalls, toolMessages, lastCallId } = processMessageBlocks(
      Array.isArray(entry.content) ? entry.content : [],
      toolsNormalized,
      toolNameById,
      lastToolCallId
    );
    if (toolCalls.length) {
      messages.push({ role: 'assistant', tool_calls: toolCalls });
    }
    for (const msg of toolMessages) {
      messages.push(msg);
    }
    const normalizedRole = normalizeResponseRole(entry.role);
    if (text) {
      messages.push({ role: normalizedRole, content: text });
    }
    lastToolCallId = lastCallId;
  }

  return messages;
}

function normalizeResponseRole(role: unknown): string {
  if (typeof role === 'string') {
    const normalized = role.toLowerCase();
    if (normalized === 'system' || normalized === 'assistant' || normalized === 'user' || normalized === 'tool') {
      return normalized;
    }
  }
  return 'user';
}

function processMessageBlocks(
  blocks: any[],
  toolsNormalized: Array<Record<string, unknown>> | undefined,
  toolNameById: Map<string, string>,
  lastToolCallId: string | null
): {
  text: string | null;
  toolCalls: Array<Record<string, unknown>>;
  toolMessages: Array<Record<string, unknown>>;
  lastCallId: string | null;
} {
  const textParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  const toolMessages: Array<Record<string, unknown>> = [];
  let currentLastCall = lastToolCallId;

  for (const block of blocks) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const type = typeof block.type === 'string' ? block.type.toLowerCase() : '';

    if (type === 'input_text' || type === 'output_text' || type === 'text' || type === 'commentary') {
      if (typeof block.text === 'string') {
        textParts.push(block.text);
      } else if (typeof block.content === 'string') {
        textParts.push(block.content);
      }
      continue;
    }

    if (type === 'message' && Array.isArray(block.content)) {
      const nested = processMessageBlocks(block.content, toolsNormalized, toolNameById, currentLastCall);
      if (nested.text) {
        textParts.push(nested.text);
      }
      toolCalls.push(...nested.toolCalls);
      toolMessages.push(...nested.toolMessages);
      currentLastCall = nested.lastCallId;
      continue;
    }

    if (type === 'function_call' || type === 'tool_call') {
      const name = typeof block.name === 'string'
        ? block.name
        : (typeof block?.function?.name === 'string' ? block.function.name : undefined);
      const args = block.arguments ?? block?.function?.arguments ?? {};
      const parsedArgs = parseFunctionArguments(args);
      const callId = typeof block.id === 'string'
        ? block.id
        : (typeof block.call_id === 'string' ? block.call_id : `call_${Math.random().toString(36).slice(2, 8)}`);
      const fnName = name ?? 'tool';
      const serialized = serializeArgsStrict(parsedArgs, fnName, toolsNormalized).trim();
      toolCalls.push({ id: callId, type: 'function', function: { name: fnName, arguments: serialized } });
      toolNameById.set(callId, fnName);
      currentLastCall = callId;
      continue;
    }

    if (type === 'function_call_output' || type === 'tool_result' || type === 'tool_message') {
      const resolvedId = (typeof block.tool_call_id === 'string' && block.tool_call_id.trim())
        ? block.tool_call_id.trim()
        : (typeof block.call_id === 'string' && block.call_id.trim())
          ? block.call_id.trim()
          : (typeof block.tool_use_id === 'string' && block.tool_use_id.trim())
            ? block.tool_use_id.trim()
            : currentLastCall;
      const output = normalizeToolOutput(block);
      if (resolvedId && output) {
        toolMessages.push({ role: 'tool', tool_call_id: resolvedId, content: output });
        currentLastCall = null;
      }
      continue;
    }

    if (typeof block.text === 'string') {
      textParts.push(block.text);
      continue;
    }
    if (typeof block.content === 'string') {
      textParts.push(block.content);
    }
  }

  const text = mergeTextParts(textParts);
  return { text, toolCalls, toolMessages, lastCallId: currentLastCall };
}

function mergeTextParts(parts: string[]): string | null {
  if (!parts.length) {
    return null;
  }
  const combined = parts
    .map(part => (typeof part === 'string' ? part : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
  return combined.length ? combined : null;
}

function parseFunctionArguments(raw: unknown): unknown {
  if (raw === null || raw === undefined) {
    return {};
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed.length) {
      return {};
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return raw;
}

function normalizeToolOutput(source: any): string | null {
  if (source === null || source === undefined) {
    return null;
  }
  if (typeof source === 'string') {
    const trimmed = source.trim();
    return trimmed.length ? trimmed : null;
  }
  if (Array.isArray(source)) {
    const parts = source
      .map(item => normalizeToolOutput(item))
      .filter((part): part is string => typeof part === 'string' && part.length > 0);
    return parts.length ? parts.join('\n') : null;
  }
  if (typeof source !== 'object') {
    const text = String(source).trim();
    return text.length ? text : null;
  }
  if (typeof source.output !== 'undefined') {
    const normalized = normalizeToolOutput(source.output);
    if (normalized) {
      return normalized;
    }
  }
  if (typeof source.text === 'string') {
    const normalized = source.text.trim();
    if (normalized.length) {
      return normalized;
    }
  }
  if (typeof source.content !== 'undefined') {
    return normalizeToolOutput(source.content);
  }
  try {
    return JSON.stringify(source);
  } catch {
    return null;
  }
}

function convertChatContentToResponses(content: unknown): Array<Record<string, unknown>> {
  if (!content) {
    return [];
  }
  if (typeof content === 'string') {
    return [{ type: 'output_text', text: content }];
  }
  if (Array.isArray(content)) {
    return (content as Array<any>).map((part) => {
      if (typeof part === 'string') {
        return { type: 'output_text', text: part };
      }
      if (part && typeof part === 'object') {
        if (typeof part.text === 'string') {
          return { type: 'output_text', text: part.text };
        }
        return { type: (part as any).type || 'output_text', text: (part as any).text ?? '' };
      }
      return { type: 'output_text', text: String(part) };
    });
  }
  if (typeof content === 'object') {
    try {
      return [{ type: 'output_text', text: JSON.stringify(content) }];
    } catch {
      return [{ type: 'output_text', text: String(content) }];
    }
  }
  return [{ type: 'output_text', text: String(content) }];
}

function extractOutputText(parts: Array<Record<string, unknown>>, toolCalls: Array<Record<string, unknown>>): string {
  if (parts.length > 0) {
    const text = parts
      .filter(part => typeof part.text === 'string')
      .map(part => part.text as string)
      .join('\n')
      .trim();
    if (text.length) {
      return text;
    }
  }
  return '';
}

function unwrapData(value: Record<string, unknown>): Record<string, unknown> {
  let current: any = value;
  const seen = new Set<any>();
  while (current && typeof current === 'object' && !Array.isArray(current) && !seen.has(current)) {
    seen.add(current);
    if ('choices' in current || 'message' in current) {
      break;
    }
    if ('data' in current && typeof current.data === 'object') {
      current = current.data;
      continue;
    }
    break;
  }
  return current as Record<string, unknown>;
}

function serializeArgsStrict(
  raw: unknown,
  fnName?: string,
  toolsNormalized?: Array<Record<string, unknown>>
): string {
  if (raw === null || raw === undefined) {
    throw new Error('tool_call.arguments missing');
  }

  const normalizeBySchema = (obj: any): any => {
    try {
      if (!fnName || !Array.isArray(toolsNormalized)) {
        return obj;
      }
      const entry = (toolsNormalized as any[]).find(t => t && typeof t === 'object'
        && t.function && t.function.name === fnName);
      const params = entry?.function?.parameters;
      const cmdDef = params?.properties?.command;
      if (!cmdDef) {
        return obj;
      }
      if (cmdDef.type === 'array' && cmdDef.items && cmdDef.items.type === 'string') {
        if (Array.isArray(obj.command)) {
          return obj;
        }
        if (typeof obj.command === 'string') {
          throw new Error('command must be array<string> per schema');
        }
        return obj;
      }
      if (cmdDef.type === 'string') {
        if (Array.isArray(obj.command)) {
          obj.command = obj.command.join(' ');
        } else if (typeof obj.command !== 'string') {
          obj.command = String(obj.command ?? '');
        }
        return obj;
      }
      return obj;
    } catch {
      return obj;
    }
  };

  if (typeof raw === 'string') {
    const s = raw.trim();
    const obj = JSON.parse(s);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error('tool_call.arguments must be JSON object');
    }
    const shaped = normalizeBySchema(obj);
    return JSON.stringify(shaped);
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const shaped = normalizeBySchema(raw as any);
    return JSON.stringify(shaped);
  }
  throw new Error('tool_call.arguments must be object or JSON string');
}

export function extractRequestIdFromResponse(response: SharedPipelineResponse | any): string | undefined {
  if (response && typeof response === 'object') {
    if ('metadata' in response && response.metadata && typeof response.metadata === 'object') {
      const meta = response.metadata as Record<string, unknown>;
      if (typeof meta.requestId === 'string') {
        return meta.requestId;
      }
    }
  }
  return undefined;
}

