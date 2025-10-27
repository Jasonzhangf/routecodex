// Core Responses↔OpenAI Chat bridge (strict, no fallback guessing)
// This file is self-contained to avoid cross-package imports.

type Unknown = Record<string, unknown>;

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

// Lenient JSON-ish parsing for tool arguments (align with OpenAI→Anthropic robustness)
function parseLenient(value: unknown): unknown {
  if (value === undefined || value === null) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return { _raw: String(value) };
  const s0 = value.trim();
  if (!s0) return {};
  // 1) strict JSON
  try { return JSON.parse(s0); } catch { /* continue */ }
  // 2) fenced ```json ... ``` or ``` ... ```
  const fence = s0.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fence ? fence[1] : s0;
  // 3) object substring
  const objMatch = candidate.match(/\{[\s\S]*\}/);
  if (objMatch) { try { return JSON.parse(objMatch[0]); } catch { /* ignore */ } }
  // 4) array substring
  const arrMatch = candidate.match(/\[[\s\S]*\]/);
  if (arrMatch) { try { return JSON.parse(arrMatch[0]); } catch { /* ignore */ } }
  // 5) single quotes → double; unquoted keys → quoted
  let t = candidate.replace(/'([^']*)'/g, '"$1"');
  t = t.replace(/([{,\s])([A-Za-z_][A-Za-z0-9_-]*)\s*:/g, '$1"$2":');
  try { return JSON.parse(t); } catch { /* ignore */ }
  // 6) key=value fallback across lines/commas
  const obj: Record<string, any> = {};
  const parts = candidate.split(/[\n,]+/).map(p => p.trim()).filter(Boolean);
  for (const p of parts) {
    const m = p.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*[:=]\s*(.+)$/);
    if (!m) continue; const k = m[1]; let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    try { const pv = JSON.parse(v); obj[k] = pv; continue; } catch { /* fallthrough */ }
    if (/^(true|false)$/i.test(v)) { obj[k] = /^true$/i.test(v); continue; }
    if (/^-?\d+(?:\.\d+)?$/.test(v)) { obj[k] = Number(v); continue; }
    obj[k] = v;
  }
  return Object.keys(obj).length ? obj : { _raw: s0 };
}

function defaultObjectSchema() { return { type: 'object', properties: {}, additionalProperties: true }; }

function normalizeTools(tools: any[]): Unknown[] {
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
    // Augment shell tool description to nudge the model to put all intent into argv tokens only (CCR-style)
    try {
      if (String(name || '').trim() === 'shell') {
        if (!isObject((params as any).properties)) (params as any).properties = {} as Unknown;
        const props = (params as any).properties as Unknown;
        if (!isObject((props as any).command)) {
          (props as any).command = { type: 'array', items: { type: 'string' }, description: 'The command to execute as argv tokens' } as Unknown;
        }
        (params as any).additionalProperties = false;
        const guidance = [
          'Execute shell commands. Place ALL flags, paths and patterns into the `command` array as argv tokens.',
          'Do NOT add extra keys beyond the schema. Examples:',
          '- ["find",".","-type","f","-name","*.ts"]',
          '- ["find",".","-type","f","-not","-path","*/node_modules/*","-name","*.ts"]',
          '- ["find",".","-type","f","-name","*.ts","-exec","head","-20","{}","+"]',
          '中文：所有参数写入 command 数组，不要使用额外键名（如 md 或 node_modules/*）。'
        ].join('\n');
        const d0 = typeof desc === 'string' ? desc : '';
        const descOut = d0 && !/Place ALL flags/i.test(d0) ? `${d0}\n\n${guidance}` : (d0 || guidance);
        const norm: Unknown = { type: 'function', function: { name, description: descOut, parameters: params as Unknown, strict: true } };
        if ((norm as any).function?.name) out.push(norm);
        continue;
      }
    } catch { /* ignore augmentation errors */ }
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

  const raw = parseLenient(argsStringOrObj);
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
  let toolsNormalized = Array.isArray((payload as any).tools)
    ? normalizeTools((payload as any).tools as ResponsesToolDefinition[])
    : undefined;
  // Inject MCP tools (CCR style) if enabled
  try {
    const enableMcp = String((process as any).env?.ROUTECODEX_MCP_ENABLE ?? '1') !== '0';
    if (enableMcp) {
      // Discover servers from prior inputs if present (best-effort; depends on client payload)
      const discovered = new Set<string>();
      try {
        const input = Array.isArray((payload as any).input) ? ((payload as any).input as any[]) : [];
        for (const it of input) {
          const t = (it && typeof it === 'object') ? (it as any) : {};
          const isToolCall = (t.type === 'function_call' || t.type === 'tool_call');
          const isToolMsg = (t.type === 'tool_message' || t.type === 'tool_result');
          if (isToolCall) {
            const args = typeof t.arguments === 'string' ? (() => { try { return JSON.parse(t.arguments); } catch { return {}; } })() : (t.arguments || {});
            const sv = (args && typeof args === 'object') ? (args as any).server : undefined;
            if (typeof sv === 'string' && sv.trim()) discovered.add(sv.trim());
          } else if (isToolMsg) {
            const output = t?.output;
            const val = (typeof output === 'string') ? (() => { try { return JSON.parse(output); } catch { return null; } })() : (output || null);
            const args = (val && typeof val === 'object') ? (val as any).arguments : undefined;
            const sv = (args && typeof args === 'object') ? (args as any).server : undefined;
            if (typeof sv === 'string' && sv.trim()) discovered.add(sv.trim());
          }
        }
      } catch { /* ignore */ }
      const list = toolsNormalized && Array.isArray(toolsNormalized) ? toolsNormalized as Array<Record<string, unknown>> : [];
      const have = new Set(list.map((t: any) => (t?.function?.name || '').toString())) as Set<string>;
      const addTool = (def: any) => { if (!have.has(def.function.name)) { list.push(def); have.add(def.function.name); } };
      const obj = (props: any, req: string[]) => ({ type: 'object', properties: props, required: req, additionalProperties: false });
      const serversRaw = String((process as any).env?.ROUTECODEX_MCP_SERVERS || '').trim();
      const envServers = serversRaw ? serversRaw.split(',').map((s: string) => s.trim()).filter(Boolean) : [];
      const merged = Array.from(new Set([ ...envServers, ...Array.from(discovered) ]));
      const serverProp = merged.length ? { type: 'string', enum: merged } : { type: 'string' };
      // 初始仅注入 list_mcp_resources；有已知 server 后再注入其余 MCP 工具
      addTool({ type: 'function', function: { name: 'list_mcp_resources', strict: true, description: 'List resources from a given MCP server (arguments.server = server label).', parameters: obj({ server: serverProp, filter: { type: 'string' }, root: { type: 'string' } }, ['server']) } });
      if (merged.length > 0) {
        addTool({ type: 'function', function: { name: 'read_mcp_resource', strict: true, description: 'Read a resource via MCP server.', parameters: obj({ server: serverProp, uri: { type: 'string' } }, ['server','uri']) } });
        addTool({ type: 'function', function: { name: 'list_mcp_resource_templates', strict: true, description: 'List resource templates via MCP server.', parameters: obj({ server: serverProp }, ['server']) } });
      }
      toolsNormalized = list;
    }
  } catch { /* ignore MCP injection */ }

  const messages = mapResponsesInputToChat({
    instructions: context.instructions,
    input: context.input,
    toolsNormalized
  });
  try {
    const enableMcp = String((process as any).env?.ROUTECODEX_MCP_ENABLE ?? '1') !== '0';
    if (enableMcp) {
      // recompute merged server list for prompt hint (env + discovered)
      const serversRaw = String((process as any).env?.ROUTECODEX_MCP_SERVERS || '').trim();
      const envServers = serversRaw ? serversRaw.split(',').map((s: string) => s.trim()).filter(Boolean) : [];
      const discovered = new Set<string>();
      for (const m of messages as any[]) {
        if (m && m.role === 'tool' && typeof m.content === 'string') {
          try { const o = JSON.parse(m.content); const sv = o?.arguments?.server; if (typeof sv === 'string' && sv.trim()) discovered.add(sv.trim()); } catch { /* ignore */ }
        }
      }
      const merged = Array.from(new Set([ ...envServers, ...Array.from(discovered) ]));
      if (merged.length > 0) {
        const tip = `MCP usage: allowed functions: list_mcp_resources, read_mcp_resource, list_mcp_resource_templates. arguments.server must be one of ${JSON.stringify(merged)}. Avoid dotted tool names (server.fn).`;
        messages.push({ role: 'system', content: tip } as any);
      } else {
        const tip = 'MCP usage: no known MCP servers yet. Only use list_mcp_resources to discover available servers. Do not call other MCP functions or use dotted tool names (server.fn) until a server_label is discovered.';
        messages.push({ role: 'system', content: tip } as any);
      }
    }
  } catch { /* ignore */ }
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
  if (typeof instructions === 'string') {
    const trimmed = instructions.trim();
    if (trimmed.length) messages.push({ role: 'system', content: trimmed });
  }
  if (!Array.isArray(input)) return messages;
  const toolNameById = new Map<string, string>();
  const toolArgsById = new Map<string, string>();
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
      toolArgsById.set(callId, serialized);
      messages.push({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: fnName, arguments: serialized } }] });
      lastToolCallId = callId;
      continue;
    }

    if (entryType === 'function_call_output' || entryType === 'tool_result' || entryType === 'tool_message') {
      const toolCallId = (entry as any).tool_call_id || (entry as any).call_id || (entry as any).tool_use_id || (entry as any).id || lastToolCallId;
      const output = normalizeToolOutput(entry);
      if (toolCallId) {
        try {
          const name = toolNameById.get(String(toolCallId)) || 'tool';
          const argStr = toolArgsById.get(String(toolCallId));
          let argsObj: any = {};
          if (argStr) { try { argsObj = JSON.parse(argStr); } catch { argsObj = { _raw: argStr }; } }
          const raw = output !== null ? tryParseJson(output) : null;
          const cmd = (argsObj && typeof argsObj === 'object') ? (argsObj as any).command : undefined;
          const workdir = (argsObj && typeof argsObj === 'object') ? (argsObj as any).workdir : undefined;
          const flattened = (() => {
            const out: any = {
              tool_call_id: String(toolCallId),
              tool_name: name,
              arguments: argsObj,
              command: Array.isArray(cmd) ? cmd : (typeof cmd === 'string' && cmd.length ? [cmd] : [])
            };
            if (typeof workdir === 'string' && workdir) out.workdir = workdir;
            if (raw && typeof raw === 'object') {
              const meta: any = (raw as any).metadata || (raw as any).meta || {};
              const exitCode = (typeof (raw as any).exit_code === 'number') ? (raw as any).exit_code
                : (typeof meta.exit_code === 'number' ? meta.exit_code : undefined);
              const duration = (typeof (raw as any).duration_seconds === 'number') ? (raw as any).duration_seconds
                : (typeof meta.duration_seconds === 'number' ? meta.duration_seconds : undefined);
              if (typeof exitCode === 'number') out.exit_code = exitCode;
              if (typeof duration === 'number') out.duration_seconds = duration;
              if (typeof (raw as any).stdout === 'string') out.stdout = (raw as any).stdout;
              if (typeof (raw as any).stderr === 'string') out.stderr = (raw as any).stderr;
              if (typeof (raw as any).error === 'string' && out.stderr === undefined) out.stderr = (raw as any).error;
              if (typeof (raw as any).success === 'boolean') out.success = (raw as any).success;
              if ((raw as any).output !== undefined) out.output = (raw as any).output;
              else if ((raw as any).result !== undefined) out.output = (raw as any).result;
              else out.output = raw;
            } else {
              out.output = raw; // string or null
            }
            return out;
          })();
          messages.push({ role: 'tool', tool_call_id: String(toolCallId), content: JSON.stringify(flattened) });
        } catch {
          const fallback = (output ?? '');
          messages.push({ role: 'tool', tool_call_id: String(toolCallId), content: String(fallback) });
        }
        lastToolCallId = null;
      }
      continue;
    }

    const { text, toolCalls, toolMessages, lastCallId } = processMessageBlocks(
      Array.isArray((entry as any).content) ? (entry as any).content : [],
      toolsNormalized,
      toolNameById,
      lastToolCallId
    );
    if (toolCalls.length) messages.push({ role: 'assistant', tool_calls: toolCalls });
    for (const msg of toolMessages) messages.push(msg);
    const normalizedRole = normalizeResponseRole((entry as any).role);
    if (text) messages.push({ role: normalizedRole, content: text });
    lastToolCallId = lastCallId;
  }
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
  const toolArgsByIdLocal = new Map<string, string>();
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
      toolArgsByIdLocal.set(callId, serialized);
      toolCalls.push({ id: callId, type: 'function', function: { name, arguments: serialized } });
      currentLastCall = callId;
      continue;
    }
    if (type === 'function_call_output' || type === 'tool_result' || type === 'tool_message') {
      const toolCallId = (block as any).tool_call_id || (block as any).call_id || (block as any).tool_use_id || (block as any).id || currentLastCall;
      const output = normalizeToolOutput(block as any);
      if (toolCallId) {
        try {
          const name = toolNameById.get(String(toolCallId)) || 'tool';
          const argStr = toolArgsByIdLocal.get(String(toolCallId));
          let argsObj: any = {};
          if (argStr) { try { argsObj = JSON.parse(argStr); } catch { argsObj = { _raw: argStr }; } }
          const raw = output !== null ? tryParseJson(output) : null;
          const cmd = (argsObj && typeof argsObj === 'object') ? (argsObj as any).command : undefined;
          const workdir = (argsObj && typeof argsObj === 'object') ? (argsObj as any).workdir : undefined;
          const flattened = (() => {
            const out: any = {
              tool_call_id: String(toolCallId),
              tool_name: name,
              arguments: argsObj,
              command: Array.isArray(cmd) ? cmd : (typeof cmd === 'string' && cmd.length ? [cmd] : [])
            };
            if (typeof workdir === 'string' && workdir) out.workdir = workdir;
            if (raw && typeof raw === 'object') {
              const meta: any = (raw as any).metadata || (raw as any).meta || {};
              const exitCode = (typeof (raw as any).exit_code === 'number') ? (raw as any).exit_code
                : (typeof meta.exit_code === 'number' ? meta.exit_code : undefined);
              const duration = (typeof (raw as any).duration_seconds === 'number') ? (raw as any).duration_seconds
                : (typeof meta.duration_seconds === 'number' ? meta.duration_seconds : undefined);
              if (typeof exitCode === 'number') out.exit_code = exitCode;
              if (typeof duration === 'number') out.duration_seconds = duration;
              if (typeof (raw as any).stdout === 'string') out.stdout = (raw as any).stdout;
              if (typeof (raw as any).stderr === 'string') out.stderr = (raw as any).stderr;
              if (typeof (raw as any).error === 'string' && out.stderr === undefined) out.stderr = (raw as any).error;
              if (typeof (raw as any).success === 'boolean') out.success = (raw as any).success;
              if ((raw as any).output !== undefined) out.output = (raw as any).output;
              else if ((raw as any).result !== undefined) out.output = (raw as any).result;
              else out.output = raw;
            } else {
              out.output = raw; // string or null
            }
            return out;
          })();
          toolMessages.push({ role: 'tool', tool_call_id: String(toolCallId), content: JSON.stringify(flattened) });
        } catch {
          const fallback = (output ?? '');
          toolMessages.push({ role: 'tool', tool_call_id: String(toolCallId), content: String(fallback) });
        }
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
