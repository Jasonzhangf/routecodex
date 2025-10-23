// Core Responses↔OpenAI Chat bridge (strict, no fallback guessing)
// This file is self-contained to avoid cross-package imports.

export type Unknown = Record<string, unknown>;

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
  function?: { name?: string; arguments?: unknown };
  message?: { role?: string; content?: Array<ResponsesContentPart> };
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

// --- Utilities (ported strictly) ---

function isObject(v: unknown): v is Unknown {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function tryParseJson(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return s; }
}

function defaultObjectSchema() { return { type: 'object', properties: {}, additionalProperties: true }; }

export function normalizeTools(tools: any[]): Unknown[] {
  if (!Array.isArray(tools)) return [];
  const out: Unknown[] = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const fn = (t as any).function || {};
    const topName = typeof (t as any).name === 'string' ? (t as any).name : undefined;
    const topDesc = typeof (t as any).description === 'string' ? (t as any).description : undefined;
    const topParams = (t as any).parameters;
    const name = typeof fn?.name === 'string' ? fn.name : topName;
    const desc = typeof fn?.description === 'string' ? fn.description : topDesc;
    let params = (fn?.parameters !== undefined ? fn.parameters : topParams);
    params = tryParseJson(params);
    if (!isObject(params)) params = defaultObjectSchema();
    const norm: Unknown = { type: 'function', function: { name, ...(desc ? { description: desc } : {}), parameters: params as Unknown } };
    if ((norm as any).function?.name) out.push(norm);
  }
  return out;
}

function getExpectedType(schema: Unknown | undefined, key: string): { kind: 'string'|'arrayString'|'object'|'any' } {
  if (!schema || !isObject(schema)) return { kind: 'any' };
  const props = isObject(schema.properties) ? (schema.properties as Unknown) : undefined;
  const s = props && isObject((props as any)[key]) ? ((props as any)[key] as Unknown) : undefined;
  if (!s) return { kind: 'any' };
  const t = (s as any).type;
  if (t === 'string') return { kind: 'string' };
  if (t === 'object') return { kind: 'object' };
  if (t === 'array') {
    const items = (s as any).items as Unknown | undefined;
    const it = items && isObject(items) ? (items as any).type : undefined;
    if (it === 'string') return { kind: 'arrayString' };
    return { kind: 'any' };
  }
  return { kind: 'any' };
}

function normalizeArgumentsBySchema(argsStringOrObj: unknown, functionName: string | undefined, tools: unknown): string {
  const toJsonString = (v: unknown): string => {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v ?? {}); } catch { return String(v); }
  };
  const tryParseJsonString = (s: unknown): unknown => {
    if (typeof s !== 'string') return s;
    try { return JSON.parse(s); } catch { return s; }
  };

  const raw = tryParseJsonString(argsStringOrObj);
  const argsObj: Unknown = isObject(raw) ? (raw as Unknown) : {};

  // Find function schema in provided tools (OpenAI Chat normalized shape)
  let fnSchema: Unknown | undefined;
  if (Array.isArray(tools)) {
    for (const t of tools as any[]) {
      if (!t || typeof t !== 'object') continue;
      const fn = (t as any).function || {};
      const nm = typeof fn?.name === 'string' ? fn.name : undefined;
      if (nm && functionName && nm === functionName) {
        const params = fn?.parameters;
        if (isObject(params)) fnSchema = params as Unknown;
        break;
      }
    }
  }

  if (!fnSchema) {
    // No schema available — return original stringified
    return toJsonString(argsStringOrObj);
  }

  const props = (fnSchema as any).properties;
  if (isObject(props)) {
    for (const key of Object.keys(props)) {
      const exp = getExpectedType(fnSchema as Unknown, key);
      if (key in argsObj) {
        if (exp.kind === 'string') {
          const v = (argsObj as any)[key];
          (argsObj as any)[key] = typeof v === 'string' ? v : toJsonString(v);
        } else if (exp.kind === 'arrayString') {
          const v = (argsObj as any)[key];
          if (Array.isArray(v)) {
            // keep
          } else if (typeof v === 'string') {
            // do not split heuristically — keep as single token if schema demands array
            (argsObj as any)[key] = v.length ? [v] : [];
          } else {
            (argsObj as any)[key] = [toJsonString(v)];
          }
        } else if (exp.kind === 'object') {
          const v = (argsObj as any)[key];
          const parsed = tryParseJsonString(v);
          (argsObj as any)[key] = isObject(parsed) ? parsed : {};
        }
      }
    }
  }

  return toJsonString(argsObj);
}

function parseFunctionArguments(args: unknown): Unknown {
  if (typeof args === 'string') {
    try { const obj = JSON.parse(args); return isObject(obj) ? obj : {}; } catch { return {}; }
  }
  if (isObject(args)) return args as Unknown;
  return {};
}

function normalizeToolOutput(entry: ResponsesInputItem): string | null {
  const out = entry?.output;
  if (typeof out === 'string') return out;
  if (out && typeof out === 'object') {
    try { return JSON.stringify(out); } catch { return String(out); }
  }
  return null;
}

// --- Public bridge functions ---

export function captureResponsesContext(payload: Record<string, unknown>, dto?: { route?: { requestId?: string } }): ResponsesRequestContext {
  const context: ResponsesRequestContext = {
    requestId: dto?.route?.requestId,
    instructions: typeof payload.instructions === 'string' ? payload.instructions : undefined,
    input: Array.isArray(payload.input) ? (payload.input as ResponsesInputItem[]) : undefined,
    include: payload.include,
    store: payload.store,
    toolChoice: (payload as any).tool_choice,
    parallelToolCalls: typeof (payload as any).parallel_tool_calls === 'boolean' ? (payload as any).parallel_tool_calls : undefined,
    metadata: (payload.metadata && typeof payload.metadata === 'object') ? (payload.metadata as Record<string, unknown>) : undefined,
    responseFormat: (payload as any).response_format,
    stream: (payload as any).stream === true,
    isChatPayload: Array.isArray((payload as any).messages)
  };
  if (Array.isArray((payload as any).tools)) {
    context.toolsRaw = (payload as any).tools as ResponsesToolDefinition[];
  }
  context.isResponsesPayload = !context.isChatPayload && Array.isArray(context.input);
  return context;
}

export function buildChatRequestFromResponses(payload: Record<string, unknown>, context: ResponsesRequestContext): BuildChatRequestResult {
  const toolsNormalized = Array.isArray((payload as any).tools)
    ? normalizeTools((payload as any).tools as ResponsesToolDefinition[])
    : undefined;

  const messages = mapResponsesInputToChat({
    instructions: context.instructions,
    input: context.input,
    toolsNormalized
  });
  if (!messages.length) {
    throw new Error('Responses payload produced no chat messages');
  }

  const result: Record<string, unknown> = { model: (payload as any).model, messages };
  for (const key of ['temperature','top_p','max_tokens','tool_choice','parallel_tool_calls','user','logit_bias','seed','stream','response_format'] as const) {
    if ((payload as any)[key] !== undefined) (result as any)[key] = (payload as any)[key];
  }
  // map max_output_tokens / max_tokens for GLM is handled upstream; keep as-is here
  if (Array.isArray((payload as any).tools)) (result as any).tools = toolsNormalized;
  return { request: result, toolsNormalized };
}

export function buildResponsesPayloadFromChat(payload: unknown, context?: ResponsesRequestContext): Record<string, unknown> | unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const response = unwrapData(payload as Record<string, unknown>);
  if (!response || typeof response !== 'object') return payload;
  if ((response as any).object === 'response' && Array.isArray((response as any).output)) return response;

  const choices = Array.isArray((response as any).choices) ? (response as any).choices : [];
  const primaryChoice = choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : undefined;
  const message = primaryChoice && typeof primaryChoice.message === 'object' ? primaryChoice.message as Record<string, unknown> : undefined;
  const role = (message as any)?.role || 'assistant';
  const content = (message as any)?.content;
  const reasoningText = typeof (message as any)?.reasoning_content === 'string' && ((message as any).reasoning_content as string).trim().length
    ? String((message as any).reasoning_content).trim() : undefined;

  const outputItems: Array<Record<string, unknown>> = [];
  if (reasoningText) {
    outputItems.push({ type: 'reasoning', summary: [], content: [{ type: 'output_text', text: reasoningText }] });
  }
  const convertedContent = convertChatContentToResponses(content);
  if (convertedContent.length > 0) {
    outputItems.push({ type: 'message', message: { role, content: convertedContent } });
  }

  const toolCalls = Array.isArray((message as any)?.tool_calls) ? ((message as any).tool_calls as Array<Record<string, unknown>>) : [];
  if (toolCalls.length > 0) {
    const toolsNorm = Array.isArray(context?.toolsNormalized)
      ? context?.toolsNormalized
      : normalizeTools(((context as any)?.toolsRaw || (context as any)?.metadata?.tools || []));
    for (const call of toolCalls) {
      const toolId = typeof (call as any).id === 'string' ? (call as any).id : (typeof (call as any).call_id === 'string' ? (call as any).call_id : `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
      const fn = (call && typeof (call as any).function === 'object') ? ((call as any).function as Record<string, unknown>) : undefined;
      const fnName = typeof (fn as any)?.name === 'string' ? ((fn as any).name as string) : undefined;
      const rawArgs = (fn as any)?.arguments;
      const serializedArgsRaw = typeof rawArgs === 'string' ? rawArgs : (rawArgs && typeof rawArgs === 'object' ? JSON.stringify(rawArgs) : '{}');
      const serializedArgs = normalizeArgumentsBySchema(serializedArgsRaw, fnName, toolsNorm);
      outputItems.push({ type: 'function_call', id: toolId, call_id: toolId, name: fnName, arguments: serializedArgs, status: 'in_progress' });
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
    output_text: outputText || ''
  };
  if (usage) out.usage = usage;
  if (context) {
    for (const k of ['metadata','instructions','parallel_tool_calls','tool_choice','include','store'] as const) {
      if ((context as any)[k] !== undefined) (out as any)[k] = (context as any)[k];
    }
  }
  return out;
}

function mapResponsesInputToChat(options: { instructions?: string; input?: ResponsesInputItem[]; toolsNormalized?: Array<Record<string, unknown>>; }): Array<Record<string, unknown>> {
  const { instructions, input, toolsNormalized } = options;
  const messages: Array<Record<string, unknown>> = [];
  // Aggregate consecutive function calls into a single assistant message
  let pendingToolCalls: Array<Record<string, unknown>> = [];
  const flushToolCalls = () => {
    if (pendingToolCalls.length) {
      messages.push({ role: 'assistant', tool_calls: pendingToolCalls });
      pendingToolCalls = [];
    }
  };
  if (typeof instructions === 'string') {
    const trimmed = instructions.trim();
    if (trimmed.length) messages.push({ role: 'system', content: trimmed });
  }
  if (!Array.isArray(input)) return messages;
  const toolNameById = new Map<string, string>();
  let lastToolCallId: string | null = null;
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const entryType = typeof entry.type === 'string' ? entry.type.toLowerCase() : 'message';
    if (entryType === 'function_call' || entryType === 'tool_call') {
      const name = typeof entry.name === 'string' ? entry.name : (typeof entry?.function?.name === 'string' ? (entry.function as any).name : undefined);
      const args = (entry as any).arguments ?? (entry as any)?.function?.arguments ?? {};
      const parsedArgs = parseFunctionArguments(args);
      const callId = typeof entry.id === 'string' ? entry.id : (typeof entry.call_id === 'string' ? entry.call_id : `call_${Math.random().toString(36).slice(2, 8)}`);
      const fnName = name ?? 'tool';
      const serialized = normalizeArgumentsBySchema(parsedArgs, fnName, toolsNormalized).trim();
      toolNameById.set(callId, fnName);
      pendingToolCalls.push({ id: callId, type: 'function', function: { name: fnName, arguments: serialized } });
      lastToolCallId = callId;
      continue;
    }

    if (entryType === 'function_call_output' || entryType === 'tool_result' || entryType === 'tool_message') {
      // Before emitting tool result, flush accumulated assistant tool calls
      flushToolCalls();
      const toolCallId = (entry as any).tool_call_id || (entry as any).call_id || (entry as any).tool_use_id || (entry as any).id || lastToolCallId;
      const output = normalizeToolOutput(entry);
      if (toolCallId && output) {
        messages.push({ role: 'tool', tool_call_id: String(toolCallId), content: output });
        lastToolCallId = null;
      }
      continue;
    }

    const { text, toolCalls, toolMessages, lastCallId } = processMessageBlocks(Array.isArray((entry as any).content) ? (entry as any).content : [], toolsNormalized, toolNameById, lastToolCallId);
    if (toolCalls.length) {
      pendingToolCalls.push(...toolCalls);
    }
    for (const msg of toolMessages) messages.push(msg);
    const normalizedRole = normalizeResponseRole((entry as any).role);
    if (text) {
      // Boundary before a text message
      flushToolCalls();
      messages.push({ role: normalizedRole, content: text });
    }
    lastToolCallId = lastCallId;
  }
  // Flush any trailing tool calls
  flushToolCalls();
  return messages;
}

function normalizeResponseRole(role: unknown): string {
  if (typeof role === 'string') {
    const normalized = role.toLowerCase();
    if (normalized === 'system' || normalized === 'assistant' || normalized === 'user' || normalized === 'tool') return normalized;
  }
  return 'user';
}

function processMessageBlocks(blocks: any[], toolsNormalized: Array<Record<string, unknown>> | undefined, toolNameById: Map<string, string>, lastToolCallId: string | null): { text: string | null; toolCalls: Array<Record<string, unknown>>; toolMessages: Array<Record<string, unknown>>; lastCallId: string | null; } {
  const textParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  const toolMessages: Array<Record<string, unknown>> = [];
  let currentLastCall = lastToolCallId;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const type = typeof (block as any).type === 'string' ? (block as any).type.toLowerCase() : '';
    if (type === 'input_text' || type === 'output_text' || type === 'text' || type === 'commentary') {
      if (typeof (block as any).text === 'string') textParts.push((block as any).text);
      else if (typeof (block as any).content === 'string') textParts.push((block as any).content);
      continue;
    }
    if (type === 'message' && Array.isArray((block as any).content)) {
      const nested = processMessageBlocks((block as any).content, toolsNormalized, toolNameById, currentLastCall);
      if (nested.text) textParts.push(nested.text);
      for (const tc of nested.toolCalls) toolCalls.push(tc);
      for (const tm of nested.toolMessages) toolMessages.push(tm);
      currentLastCall = nested.lastCallId;
      continue;
    }
    if (type === 'function_call') {
      const name = typeof (block as any).name === 'string' ? (block as any).name : (typeof (block as any)?.function?.name === 'string' ? (block as any).function.name : 'tool');
      const args = (block as any).arguments ?? (block as any)?.function?.arguments ?? {};
      const parsedArgs = parseFunctionArguments(args);
      const callId = typeof (block as any).id === 'string' ? (block as any).id : (typeof (block as any).call_id === 'string' ? (block as any).call_id : `call_${Math.random().toString(36).slice(2, 8)}`);
      const serialized = normalizeArgumentsBySchema(parsedArgs, name, toolsNormalized).trim();
      toolNameById.set(callId, name);
      toolCalls.push({ id: callId, type: 'function', function: { name, arguments: serialized } });
      currentLastCall = callId;
      continue;
    }
    if (type === 'function_call_output' || type === 'tool_result' || type === 'tool_message') {
      const toolCallId = (block as any).tool_call_id || (block as any).call_id || (block as any).tool_use_id || (block as any).id || currentLastCall;
      const output = normalizeToolOutput(block as any);
      if (toolCallId && output) {
        toolMessages.push({ role: 'tool', tool_call_id: String(toolCallId), content: output });
        currentLastCall = null;
      }
      continue;
    }
  }
  const text = textParts.length ? textParts.join('\n').trim() : null;
  return { text, toolCalls, toolMessages, lastCallId: currentLastCall };
}

function convertChatContentToResponses(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') return [{ type: 'output_text', text: content }];
  if (Array.isArray(content)) {
    return (content as Array<any>).map((part) => {
      if (typeof part === 'string') return { type: 'output_text', text: part };
      if (part && typeof part === 'object') {
        if (typeof (part as any).text === 'string') return { type: 'output_text', text: (part as any).text };
        return { type: (part as any).type || 'output_text', text: (part as any).text ?? '' };
      }
      return { type: 'output_text', text: String(part) };
    });
  }
  if (typeof content === 'object') {
    try { return [{ type: 'output_text', text: JSON.stringify(content) }]; } catch { return [{ type: 'output_text', text: String(content) }]; }
  }
  return [{ type: 'output_text', text: String(content) }];
}

function extractOutputText(parts: Array<Record<string, unknown>>, _toolCalls: Array<Record<string, unknown>>): string {
  if (parts.length > 0) {
    const text = parts.filter(p => typeof (p as any).text === 'string').map(p => (p as any).text as string).join('\n').trim();
    if (text.length) return text;
  }
  return '';
}

function unwrapData(value: Record<string, unknown>): Record<string, unknown> {
  let current: any = value;
  const seen = new Set<any>();
  while (current && typeof current === 'object' && !Array.isArray(current) && !seen.has(current)) {
    seen.add(current);
    if ('choices' in current || 'message' in current) break;
    if ('data' in current && typeof (current as any).data === 'object') { current = (current as any).data; continue; }
    break;
  }
  return current as Record<string, unknown>;
}

export function extractRequestIdFromResponse(response: any): string | undefined {
  if (response && typeof response === 'object' && 'metadata' in response && (response as any).metadata && typeof (response as any).metadata === 'object') {
    const meta = (response as any).metadata as Record<string, unknown>;
    if (typeof meta.requestId === 'string') return meta.requestId;
  }
  return undefined;
}
