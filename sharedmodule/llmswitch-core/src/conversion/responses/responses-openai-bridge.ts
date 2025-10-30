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
import { applyOpenAIToolingStage } from '../shared/openai-tooling-stage.js';
import { normalizeAssistantTextToToolCalls } from '../shared/text-markup-normalizer.js';
import { buildSystemToolGuidance } from '../../guidance/index.js';
import { splitCommandString } from '../shared/tooling.js';
import { tryParseJson, parseLenient } from '../shared/jsonish.js';
import { isImagePath } from '../shared/media.js';
import { normalizeTools } from '../shared/args-mapping.js';

function isObject(v: unknown): v is Unknown {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// tryParseJson now shared in ../shared/jsonish.ts

// splitCommandString now unified in ../shared/tooling.ts

// parseLenient now shared in ../shared/jsonish.ts

function defaultObjectSchema() { return { type: 'object', properties: {}, additionalProperties: true }; }

// normalizeTools unified in ../shared/args-mapping.ts

// --- Structured self-repair helpers for tool failures (Responses path) ---
// use shared isImagePath

function buildRepairMessageCompat(name: string | undefined, args: any, body: any): string {
  const allowed = ['shell','update_plan','view_image','list_mcp_resources'];
  const argStr = (() => { try { return JSON.stringify(args); } catch { return String(args); } })();
  const bodyText = typeof body === 'string' ? body : (() => { try { return JSON.stringify(body); } catch { return String(body); } })();
  const suggestions: string[] = [];
  if (!name || name === 'tool' || String(name).trim() === '') {
    suggestions.push('function.name 为空或未知。请选择以下之一: shell, update_plan, view_image, list_mcp_resources。');
    if (args && typeof args === 'object' && ('command' in args)) suggestions.push('检测到 arguments.command：你可能想调用 shell。');
    if (args && typeof args === 'object' && ('plan' in args)) suggestions.push('检测到 arguments.plan：你可能想调用 update_plan。');
    if (args && typeof args === 'object' && isImagePath((args as any).path)) suggestions.push('检测到图片路径：你可能想调用 view_image。');
  }
  if (name === 'view_image' && args && typeof args === 'object' && !isImagePath((args as any).path)) {
    suggestions.push('view_image 仅用于图片文件（png/jpg/gif/webp/svg/...）。当前路径看起来不是图片，请改用 shell: {"command":["cat","<path>"]} 来读取文本/markdown。');
  }
  if (typeof bodyText === 'string' && /failed to parse function arguments|invalid type: string|expected a sequence/i.test(bodyText)) {
    suggestions.push('arguments 需要是单个 JSON 字符串。');
    suggestions.push('shell 推荐：数组 argv 或 bash -lc 字符串二选一。例如：');
    suggestions.push('  {"command":["find",".","-type","f","-name","*.md"]}');
    suggestions.push('  或 {"command":"bash -lc \"find . -type f -name \\\"*.md\\\" | head -20\""}');
  }
  suggestions.push('示例：shell 读取文件 → {"command":["cat","codex-local/docs/design.md"]}');
  suggestions.push('示例：update_plan → {"explanation":"...","plan":[{"step":"...","status":"in_progress"}]}');
  suggestions.push('示例：view_image → {"path":"/path/to/image.png"}');
  const header = '工具调用不可用（可自修复提示）';
  const why = `问题: ${bodyText}`;
  const given = `arguments: ${argStr}`;
  const allow = `允许工具: ${allowed.join(', ')}`;
  return [header, allow, given, ...suggestions, why].join('\n');
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
            // For shell.command allow argv tokenization; otherwise wrap
            if (String(functionName || '').toLowerCase() === 'shell' && key === 'command') {
              // Robust tokenization for comma/bracket lists from models
              const rawTokens = splitCommandString(v);
              const flattenByComma = (arr: string[]): string[] => arr.flatMap((t) => String(t).split(',').map(s => s.trim()).filter(Boolean));
              const stripBracketsAndCommas = (arr: string[]): string[] => arr
                .map((t) => t.replace(/^\[+/, '').replace(/\]+$/, ''))
                .map((t) => t.endsWith(',') ? t.slice(0, -1) : t)
                .filter((t) => t !== ',' && t.length > 0);
              const cleaned = stripBracketsAndCommas(flattenByComma(rawTokens));
              (argsObj as any)[key] = cleaned.length ? cleaned : [];
            } else {
              (argsObj as any)[key] = v.length ? [v] : [];
            }
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

  // Post-fixups for shell: do NOT append extra unknown keys into argv.
  // 保留除保留字段以外的扩展键，但不拼接到 command，避免把大段文本/代码污染命令行。
  try {
    if (String(functionName || '').toLowerCase() === 'shell') {
      // 仅做元字符检测：当 command 是 argv 且包含管道/重定向/heredoc/与或时，折叠为 ['bash','-lc','<script>']。
      const metas = new Set(['|','>','>>','<','<<',';','&&','||']);
      const hasMetaToken = (arr: string[]) => arr.some(t => metas.has(t) || /[|<>;&]/.test(String(t)) || String(t).includes('&&') || String(t).includes('||') || String(t).includes('<<'));
      const isBashLc = (arr: string[]) => arr.length >= 2 && arr[0] === 'bash' && arr[1] === '-lc';
      const cmdVal: any = (argsObj as any).command;
      if (Array.isArray(cmdVal)) {
        const tokens = cmdVal.map((x: any) => String(x));
        if (!isBashLc(tokens) && hasMetaToken(tokens)) {
          (argsObj as any).command = ['bash','-lc', tokens.join(' ')];
        }
      } else if (typeof cmdVal === 'string') {
        const s = cmdVal.trim();
        const hasMeta = /[|<>;&]/.test(s) || s.includes('&&') || s.includes('||') || s.includes('<<');
        if (hasMeta && !/^\s*bash\s+-lc\s+/.test(s)) {
          (argsObj as any).command = ['bash','-lc', s];
        }
      }
    }
  } catch { /* ignore meta wrapping errors */ }

  // No command-level post-fixups here; preserve arguments as provided by model

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
      // 与 Chat 路径保持一致：server 可选（不强制要求）
      addTool({ type: 'function', function: { name: 'list_mcp_resources', strict: true, description: 'List resources from a given MCP server (arguments.server = server label).', parameters: obj({ server: serverProp, filter: { type: 'string' }, root: { type: 'string' } }, [] /* server optional */) } });
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
  // Apply unified OpenAI tooling stage on the built Chat request
  {
    const chat = applyOpenAIToolingStage({ model: (payload as any).model, messages, tools: toolsNormalized } as any) as any;
    const msgNew = Array.isArray(chat?.messages) ? chat.messages as Array<Record<string, unknown>> : messages;
    messages.length = 0; for (const m of msgNew) messages.push(m);
    toolsNormalized = Array.isArray(chat?.tools) ? chat.tools as Array<Record<string, unknown>> : toolsNormalized;
  }
  // Inject comprehensive tool usage guidance (non-MCP + phased MCP) into system, once, when tools present (if enabled)
  try {
    const sysGuideEnabled = String(process.env.RCC_SYSTEM_TOOL_GUIDANCE ?? '1').trim() !== '0';
    const toolsList = Array.isArray(toolsNormalized) ? (toolsNormalized as any[]) : (Array.isArray((payload as any).tools) ? ((payload as any).tools as any[]) : []);
    const hasGuidance = messages.some((m: any) => m && m.role === 'system' && typeof m.content === 'string' && /Use OpenAI tool_calls|Tool usage guidance/i.test(m.content));
    if (sysGuideEnabled && !hasGuidance && toolsList.length > 0) {
      const guidance = buildSystemToolGuidance();
      messages.unshift({ role: 'system', content: guidance });
    }
  } catch { /* ignore guidance injection */ }
  // No system tips for MCP on OpenAI Responses path (avoid leaking tool names)
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
  let message = primaryChoice && typeof primaryChoice.message === 'object' ? primaryChoice.message as Record<string, unknown> : undefined;
  // Normalize textual tool markup into tool_calls (gated)
  if (message && typeof message === 'object') {
    try { message = normalizeAssistantTextToToolCalls(message as any) as any; } catch { /* ignore */ }
    if (primaryChoice && typeof primaryChoice === 'object') {
      (primaryChoice as any).message = message;
    }
  }
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
      const rawName = typeof entry.name === 'string' ? entry.name : (typeof entry?.function?.name === 'string' ? (entry.function as any).name : undefined);
      const name = (typeof rawName === 'string' && rawName.includes('.')) ? rawName.slice(rawName.indexOf('.') + 1).trim() : rawName;
      const args = (entry as any).arguments ?? (entry as any)?.function?.arguments ?? {};
      const parsedArgs = parseFunctionArguments(args);
      const callId = typeof entry.id === 'string' ? entry.id : (typeof entry.call_id === 'string' ? entry.call_id : `call_${Math.random().toString(36).slice(2, 8)}`);
      const fnName = (name && name.length ? name : 'tool');
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
          let raw: any = output !== null ? tryParseJson(output) : null;
          const cmd = (argsObj && typeof argsObj === 'object') ? (argsObj as any).command : undefined;
          const workdir = (argsObj && typeof argsObj === 'object') ? (argsObj as any).workdir : undefined;
          const meta: any = (raw && typeof raw === 'object') ? ((raw as any).metadata || (raw as any).meta || {}) : {};
          const exitCode = (raw && typeof (raw as any).exit_code === 'number') ? (raw as any).exit_code
            : (typeof meta.exit_code === 'number' ? meta.exit_code : undefined);
          const duration = (raw && typeof (raw as any).duration_seconds === 'number') ? (raw as any).duration_seconds
            : (typeof meta.duration_seconds === 'number' ? meta.duration_seconds : undefined);
          const stdout = (raw && typeof (raw as any).stdout === 'string') ? (raw as any).stdout : undefined;
          let stderr = (raw && typeof (raw as any).stderr === 'string') ? (raw as any).stderr
            : ((raw && typeof (raw as any).error === 'string') ? (raw as any).error : undefined);
          let success = (raw && typeof (raw as any).success === 'boolean') ? (raw as any).success
            : (typeof exitCode === 'number' ? exitCode === 0 : undefined);
          // Inject structured self-repair hints on common failures
          const bodyText = typeof output === 'string' ? output : ((): string => { try { return JSON.stringify(output); } catch { return String(output); } })();
          const unsupported = typeof bodyText === 'string' && /^unsupported call/i.test(bodyText.trim());
          const missingName = !name || name === 'tool' || String(name).trim() === '';
          const parseFail = /failed to parse function arguments|invalid type: string|expected a sequence/i.test(bodyText);
          const misuseViewImage = name === 'view_image' && argsObj && typeof argsObj === 'object' && !isImagePath((argsObj as any).path);
          if (unsupported || missingName || parseFail || misuseViewImage) {
            success = false;
            const hint = buildRepairMessageCompat(name, argsObj, bodyText);
            stderr = hint;
            try { raw = { error: 'tool_call_invalid', hint }; } catch { /* keep raw as-is */ }
          }
          const successBool = (typeof success === 'boolean') ? success : (typeof exitCode === 'number' ? exitCode === 0 : false);
          let envelope: any = {
            version: 'rcc.tool.v1',
            tool: { name, call_id: toolCallId },
            arguments: argsObj,
            executed: { command: Array.isArray(cmd) ? cmd : (typeof cmd === 'string' && cmd.length ? [cmd] : []), ...(typeof workdir === 'string' && workdir ? { workdir } : {}) },
            result: {
              success: successBool,
              ...(typeof exitCode === 'number' ? { exit_code: exitCode } : {}),
              ...(typeof duration === 'number' ? { duration_seconds: duration } : {}),
              ...(typeof stdout === 'string' ? { stdout } : {}),
              ...(typeof stderr === 'string' ? { stderr } : {}),
              output: raw
            },
            meta: { call_id: String(toolCallId), ts: Date.now() }
          };
          // Sanitize oversized outputs and remove write echoes entirely
          try {
            const LIM = Math.max(1, Number((process as any)?.env?.ROUTECODEX_TOOL_OUTPUT_LIMIT || (process as any)?.env?.RCC_TOOL_OUTPUT_LIMIT || 1000));
            const trunc = (s: string): string => (typeof s === 'string' && s.length > LIM) ? (s.slice(0, LIM) + '...(truncated)') : s;
            const isWrite = (() => {
              try {
                const ec = (envelope as any)?.executed?.command as any;
                if (Array.isArray(ec) && ec.length >= 1) {
                  const t0 = String(ec[0] || '').toLowerCase();
                  if (t0 === 'bash' && String(ec[1] || '').toLowerCase() === '-lc') {
                    const sc = String(ec[2] || '').toLowerCase();
                    return (sc.includes('cat >') && sc.includes('<<')) || sc.includes('*** begin patch');
                  }
                  const tokens = ec.map((x: any) => String(x).toLowerCase());
                  return (tokens.includes('cat') && (tokens.includes('>') || tokens.includes('>>'))) || tokens.includes('ed');
                }
                return false;
              } catch { return false; }
            })();
            if (isWrite) {
              // Do not echo write scripts: drop executed/arguments command payload
              try { if ((envelope as any)?.executed) (envelope as any).executed.command = []; } catch {}
              try { if ((envelope as any)?.arguments && typeof (envelope as any).arguments === 'object') delete (envelope as any).arguments.command; } catch {}
              const r = (envelope as any).result as any;
              r.output = '';
              if (typeof r.stdout === 'string') r.stdout = trunc(r.stdout);
              if (typeof r.stderr === 'string') r.stderr = trunc(r.stderr);
              if ('truncated' in r) delete r.truncated;
            } else {
              const r = (envelope as any).result as any;
              if (typeof r.stdout === 'string') r.stdout = trunc(r.stdout);
              if (typeof r.stderr === 'string') r.stderr = trunc(r.stderr);
              if (typeof r.output === 'string') r.output = trunc(r.output);
              else if (r.output && typeof r.output === 'object' && typeof r.output.output === 'string') r.output.output = trunc(r.output.output);
            }
          } catch { /* ignore */ }
          try {
            const trunc = (val: any, n = 800) => { try { const s = typeof val==='string'?val: JSON.stringify(val); return s.length>n? s.slice(0,n)+'...(truncated)': s; } catch { return String(val);} };
            console.log('[LLMSWITCH][responses][tool-output][before]', { callId: String(toolCallId), name, content: trunc(output) });
            console.log('[LLMSWITCH][responses][tool-output][after]', {
              callId: String(toolCallId),
              name,
              result: { success: !!envelope.result?.success, exit_code: envelope.result?.exit_code, duration_seconds: envelope.result?.duration_seconds, stdout: trunc(envelope.result?.stdout), stderr: trunc(envelope.result?.stderr) }
            });
          } catch {}
          messages.push({ role: 'tool', tool_call_id: String(toolCallId), content: JSON.stringify(envelope) });
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
      const rawName = typeof (block as any).name === 'string' ? (block as any).name : (typeof (block as any)?.function?.name === 'string' ? (block as any).function.name : 'tool');
      const name = (typeof rawName === 'string' && rawName.includes('.')) ? rawName.slice(rawName.indexOf('.') + 1).trim() : rawName;
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
          let raw: any = output !== null ? tryParseJson(output) : null;
          const cmd = (argsObj && typeof argsObj === 'object') ? (argsObj as any).command : undefined;
          const workdir = (argsObj && typeof argsObj === 'object') ? (argsObj as any).workdir : undefined;
          const meta: any = (raw && typeof raw === 'object') ? ((raw as any).metadata || (raw as any).meta || {}) : {};
          const exitCode = (raw && typeof (raw as any).exit_code === 'number') ? (raw as any).exit_code
            : (typeof meta.exit_code === 'number' ? meta.exit_code : undefined);
          const duration = (raw && typeof (raw as any).duration_seconds === 'number') ? (raw as any).duration_seconds
            : (typeof meta.duration_seconds === 'number' ? meta.duration_seconds : undefined);
          const stdout = (raw && typeof (raw as any).stdout === 'string') ? (raw as any).stdout : undefined;
          let stderr = (raw && typeof (raw as any).stderr === 'string') ? (raw as any).stderr
            : ((raw && typeof (raw as any).error === 'string') ? (raw as any).error : undefined);
          let success = (raw && typeof (raw as any).success === 'boolean') ? (raw as any).success
            : (typeof exitCode === 'number' ? exitCode === 0 : undefined);
          // Structured self-repair on common failures
          const bodyText = typeof output === 'string' ? output : ((): string => { try { return JSON.stringify(output); } catch { return String(output); } })();
          const unsupported = typeof bodyText === 'string' && /^unsupported call/i.test(bodyText.trim());
          const missingName = !name || name === 'tool' || String(name).trim() === '';
          const parseFail = /failed to parse function arguments|invalid type: string|expected a sequence/i.test(bodyText);
          const misuseViewImage = name === 'view_image' && argsObj && typeof argsObj === 'object' && !isImagePath((argsObj as any).path);
          if (unsupported || missingName || parseFail || misuseViewImage) {
            success = false;
            const hint = buildRepairMessageCompat(name, argsObj, bodyText);
            stderr = hint;
            try { raw = { error: 'tool_call_invalid', hint }; } catch { /* keep raw as-is */ }
          }
          const successBool2 = (typeof success === 'boolean') ? success : (typeof exitCode === 'number' ? exitCode === 0 : false);
          let envelope: any = {
            version: 'rcc.tool.v1',
            tool: { name, call_id: toolCallId },
            arguments: argsObj,
            executed: { command: Array.isArray(cmd) ? cmd : (typeof cmd === 'string' && cmd.length ? [cmd] : []), ...(typeof workdir === 'string' && workdir ? { workdir } : {}) },
            result: {
              success: successBool2,
              ...(typeof exitCode === 'number' ? { exit_code: exitCode } : {}),
              ...(typeof duration === 'number' ? { duration_seconds: duration } : {}),
              ...(typeof stdout === 'string' ? { stdout } : {}),
              ...(typeof stderr === 'string' ? { stderr } : {}),
              output: raw
            },
            meta: { call_id: String(toolCallId), ts: Date.now() }
          };
          // Sanitize again for nested tool_message path
          try {
            const LIM = Math.max(1, Number((process as any)?.env?.ROUTECODEX_TOOL_OUTPUT_LIMIT || (process as any)?.env?.RCC_TOOL_OUTPUT_LIMIT || 1000));
            const trunc = (s: string): string => (typeof s === 'string' && s.length > LIM) ? (s.slice(0, LIM) + '...(truncated)') : s;
            const isWrite = (() => {
              try {
                const ec = (envelope as any)?.executed?.command as any;
                if (Array.isArray(ec) && ec.length >= 1) {
                  const t0 = String(ec[0] || '').toLowerCase();
                  if (t0 === 'bash' && String(ec[1] || '').toLowerCase() === '-lc') {
                    const sc = String(ec[2] || '').toLowerCase();
                    return (sc.includes('cat >') && sc.includes('<<')) || sc.includes('*** begin patch');
                  }
                  const tokens = ec.map((x: any) => String(x).toLowerCase());
                  return (tokens.includes('cat') && (tokens.includes('>') || tokens.includes('>>'))) || tokens.includes('ed');
                }
                return false;
              } catch { return false; }
            })();
            if (isWrite) {
              try {
                const ec = (envelope as any)?.executed?.command as any;
                if (Array.isArray(ec) && ec.length >= 3 && String(ec[0]).toLowerCase() === 'bash' && String(ec[1]).toLowerCase() === '-lc') {
                  const script = String(ec[2] || '');
                  if (script.length > LIM || /<<|\*\*\* Begin Patch/i.test(script)) (envelope as any).executed.command[2] = `[heredoc/patch script suppressed: ~${script.length} chars]`;
                }
              } catch { /* ignore */ }
              try {
                const a = (envelope as any)?.arguments as any;
                const cv = a && typeof a === 'object' ? a.command : undefined;
                if (typeof cv === 'string') {
                  if (cv.length > LIM || /<<|\*\*\* Begin Patch/i.test(cv)) (a as any).command = `[heredoc/patch script suppressed: ~${cv.length} chars]`;
                } else if (Array.isArray(cv) && cv.length >= 3 && String(cv[0]).toLowerCase() === 'bash' && String(cv[1]).toLowerCase() === '-lc') {
                  const sc2 = String(cv[2] || '');
                  if (sc2.length > LIM || /<<|\*\*\* Begin Patch/i.test(sc2)) (a as any).command[2] = `[heredoc/patch script suppressed: ~${sc2.length} chars]`;
                }
              } catch { /* ignore */ }
              const r = (envelope as any).result as any;
              let size = 0; if (typeof r.output === 'string') size = r.output.length; else if (r.output && typeof r.output === 'object' && typeof r.output.output === 'string') size = r.output.output.length;
              r.output = `write operation output suppressed${size ? ` (~${size} chars)` : ''}`;
              r.truncated = true;
              if (typeof r.stdout === 'string') r.stdout = trunc(r.stdout);
              if (typeof r.stderr === 'string') r.stderr = trunc(r.stderr);
            } else {
              const r = (envelope as any).result as any;
              if (typeof r.stdout === 'string') r.stdout = trunc(r.stdout);
              if (typeof r.stderr === 'string') r.stderr = trunc(r.stderr);
              if (typeof r.output === 'string') r.output = trunc(r.output);
              else if (r.output && typeof r.output === 'object' && typeof r.output.output === 'string') r.output.output = trunc(r.output.output);
            }
          } catch { /* ignore */ }
          try {
            const trunc = (val: any, n = 800) => { try { const s = typeof val==='string'?val: JSON.stringify(val); return s.length>n? s.slice(0,n)+'...(truncated)': s; } catch { return String(val);} };
            console.log('[LLMSWITCH][responses][tool-output][before]', { callId: String(toolCallId), name, content: trunc(output) });
            console.log('[LLMSWITCH][responses][tool-output][after]', {
              callId: String(toolCallId),
              name,
              result: { success: !!envelope.result?.success, exit_code: envelope.result?.exit_code, duration_seconds: envelope.result?.duration_seconds, stdout: trunc(envelope.result?.stdout), stderr: trunc(envelope.result?.stderr) }
            });
          } catch {}
          toolMessages.push({ role: 'tool', tool_call_id: String(toolCallId), content: JSON.stringify(envelope) });
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
// (imports moved to top)
