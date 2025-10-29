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

function splitCommandString(input: string): string[] {
  const s = input.trim();
  if (!s) return [];
  const out: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inSingle) { if (ch === "'") { inSingle = false; } else { cur += ch; } continue; }
    if (inDouble) {
      if (ch === '"') { inDouble = false; continue; }
      if (ch === '\\' && i + 1 < s.length) { i++; cur += s[i]; continue; }
      cur += ch; continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
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

// --- Structured self-repair helpers for tool failures (Responses path) ---
function isImagePathCompat(p: any): boolean {
  try { const s = String(p || '').toLowerCase(); return /\.(png|jpg|jpeg|gif|webp|bmp|svg|tiff?|ico|heic|jxl)$/.test(s); } catch { return false; }
}

function buildRepairMessageCompat(name: string | undefined, args: any, body: any): string {
  const allowed = ['shell','update_plan','view_image','list_mcp_resources'];
  const argStr = (() => { try { return JSON.stringify(args); } catch { return String(args); } })();
  const bodyText = typeof body === 'string' ? body : (() => { try { return JSON.stringify(body); } catch { return String(body); } })();
  const suggestions: string[] = [];
  if (!name || name === 'tool' || String(name).trim() === '') {
    suggestions.push('function.name 为空或未知。请选择以下之一: shell, update_plan, view_image, list_mcp_resources。');
    if (args && typeof args === 'object' && ('command' in args)) suggestions.push('检测到 arguments.command：你可能想调用 shell。');
    if (args && typeof args === 'object' && ('plan' in args)) suggestions.push('检测到 arguments.plan：你可能想调用 update_plan。');
    if (args && typeof args === 'object' && isImagePathCompat((args as any).path)) suggestions.push('检测到图片路径：你可能想调用 view_image。');
  }
  if (name === 'view_image' && args && typeof args === 'object' && !isImagePathCompat((args as any).path)) {
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

  // Post-fixups for shell: append extra keys as argv tokens if present
  try {
    if (String(functionName || '').toLowerCase() === 'shell') {
      const reserved = new Set(['command','workdir','timeout_ms','with_escalated_permissions','justification']);
      const extrasTokens: string[] = [];
      for (const k of Object.keys(argsObj)) {
        if (!reserved.has(k)) {
          extrasTokens.push(String(k));
          const v: any = (argsObj as any)[k];
          if (v !== undefined && v !== null) {
            if (typeof v === 'string') extrasTokens.push(v);
            else if (typeof v === 'number' || typeof v === 'boolean') extrasTokens.push(String(v));
            else { try { extrasTokens.push(JSON.stringify(v)); } catch { /* ignore */ } }
          }
          delete (argsObj as any)[k];
        }
      }
      if (extrasTokens.length > 0) {
        const cmdVal: any = (argsObj as any).command;
        if (Array.isArray(cmdVal)) (argsObj as any).command = [...cmdVal, ...extrasTokens];
        else if (typeof cmdVal === 'string') (argsObj as any).command = [cmdVal, ...extrasTokens];
        else (argsObj as any).command = [...extrasTokens];
      }

      // Meta-operators handling: if command is argv and contains pipes/redirection/heredoc/and/or,
      // collapse into ['bash','-lc','<script>'] so downstream executors (that do not spawn a shell)
      // can still interpret the meta within bash. This mirrors Chat path behavior.
      try {
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
      } catch { /* ignore meta wrapping errors */ }
    }
  } catch { /* ignore */ }

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
  // Inject comprehensive tool usage guidance (non-MCP + phased MCP) into system, once, when tools present
  try {
    const tools = Array.isArray((payload as any).tools) ? ((payload as any).tools as any[]) : [];
    const hasGuidance = messages.some((m: any) => m && m.role === 'system' && typeof m.content === 'string' && /Use OpenAI tool_calls|Tool usage guidance/i.test(m.content));
    if (!hasGuidance && tools.length > 0) {
      const names = tools
        .map((t: any) => (t && t.function && typeof t.function.name === 'string') ? String(t.function.name) : '')
        .filter((n: string) => !!n && !/^list_mcp_resources$|^read_mcp_resource$|^list_mcp_resource_templates$/i.test(n));
      const uniq = Array.from(new Set(names));

      const bullet = (s: string) => `- ${s}`;
      const general: string[] = [];
      general.push('Tool usage guidance (OpenAI tool_calls) / 工具使用指引（OpenAI 标准）');
      general.push(bullet('Always use assistant.tool_calls[].function.{name,arguments}; never embed tool calls in plain text. / 一律通过 tool_calls 调用工具，不要把工具调用写进普通文本。'));
      general.push(bullet('function.arguments must be a single JSON string. / arguments 必须是单个 JSON 字符串。'));
      general.push(bullet('function.name is required and must be non-empty (e.g., shell/update_plan/view_image). Empty names are invalid. / 函数名必须非空（如 shell/update_plan/view_image），禁止留空。'));
      general.push(bullet('For shell, put ALL intent into the command argv array only; do not invent extra keys. / shell 所有意图写入 command 数组，不要添加额外键名。'));
      if (uniq.length) general.push(bullet(`Available tools（非 MCP）: ${uniq.slice(0, 8).join(', ')}`));
      general.push('Examples / 示例:');
      general.push('shell: {"command":["find",".","-type","f","-name","*.ts"]}');
      general.push('  - Good / 正例: {"command":["head","-50","codex-local/src/index.ts"]}');
      general.push('  - Bad / 反例: {"js":"head -20"}, {"command":"find . -name *.ts"}, pseudo-XML (<arg_key>/<arg_value>)');
      general.push(bullet('If you need redirection/pipes/heredoc, wrap in bash -lc. / 需要重定向/管道/heredoc 时，必须包在 bash -lc 中。'));
      general.push('  e.g. {"command":["bash","-lc","cat > codex-local/docs/WRITING_GUIDE.md <<\'EOF\'\\n内容…\\nEOF"]}');
      general.push('update_plan: {"explanation":"...","plan":[{"step":"...","status":"in_progress"},{"step":"...","status":"pending"}]}');
      general.push('view_image: {"path":"/absolute/or/relative/path/to/image.png"} (only images: .png .jpg .jpeg .gif .webp .bmp .svg)');
      general.push(bullet('Do not call view_image for text files (e.g., .md/.txt). Use shell to read text. / 文本文件不要用 view_image，使用 shell 查看文本。'));

      // File editing efficiency / 文件编辑效率
      general.push('File editing efficiency / 文件编辑效率');
      general.push(bullet('Avoid line-by-line echo; use single-shot writes. / 避免逐行 echo，使用一次性写入。'));
      general.push(bullet('Do NOT use bare "cat > <path>" without stdin; use heredoc to provide content. / 禁止裸用 "cat > <path>" 且无输入，使用 heredoc 提供内容。'));
      general.push(bullet('Overwrite: cat > <path> <<\'EOF\' ... EOF / 覆盖写入。'));
      general.push(bullet('Append: cat >> <path> <<\'EOF\' ... EOF / 追加写入。'));
      general.push(bullet('Atomic write: mkdir -p "$(dirname <path>)"; tmp="$(mktemp)"; cat > "$tmp" <<\'EOF\' ... EOF; mv "$tmp" <path> / 原子写入。'));
      general.push(bullet('macOS sed in-place: sed -i "" "s|<OLD>|<NEW>|g" <path> / macOS 用 -i ""，Linux 用 -i。'));
      general.push(bullet('Use ed -s for multi-line insert/replace. / 多行替换用 ed -s。'));
      general.push(bullet('Prefer unified diff patches for batch edits; apply once. / 批量修改优先统一 diff 一次性应用。'));
      general.push(bullet('If a tool completes with no text output, explicitly say "no output" in your next assistant message and continue. / 工具执行无文本输出时，请在后续助手回复明确说明“无输出”，继续下一步。'));
      general.push('Examples:');
      general.push('  cat > codex-local/docs/design.md <<\'EOF\'\n  ...内容...\n  EOF');
      general.push('  ed -s codex-local/src/index.ts <<\'ED\'\n  ,$g/^BEGIN:SECTION$/,/^END:SECTION$/s//BEGIN:SECTION\\\n新内容…\\\nEND:SECTION/\n  w\n  q\n  ED');
      general.push('  cat > /tmp/patch.diff <<\'PATCH\'\n  *** Begin Patch\n  *** Update File: codex-local/src/index.ts\n  @@\n  -old line\n  +new line\n  *** End Patch\n  PATCH\n  git apply /tmp/patch.diff');

      // MCP phased guidance
      const enableMcp = String((process as any)?.env?.ROUTECODEX_MCP_ENABLE ?? '1') !== '0';
      const mcp: string[] = [];
      if (enableMcp) {
        // Heuristic: if toolsNormalized contains read_mcp_resource with parameters.server.enum, treat as known servers
        const toolsNorm = Array.isArray(context?.toolsNormalized) ? (context!.toolsNormalized as any[]) : [];
        const serverEnum: string[] = (() => {
          try {
            const read = toolsNorm.find((t: any) => t?.function?.name === 'read_mcp_resource');
            const prop = read?.function?.parameters?.properties?.server;
            const en = Array.isArray(prop?.enum) ? prop.enum as string[] : [];
            return en.filter((s: string) => typeof s === 'string' && s.trim());
          } catch { return []; }
        })();
        const mcpHeader = 'MCP tool usage (phased) / MCP 工具使用（分阶段）';
        mcp.push(mcpHeader);
        if (!serverEnum.length) {
          mcp.push(bullet('Start with list_mcp_resources; arguments.server is optional. / 首先调用 list_mcp_resources，server 可选。'));
          mcp.push(bullet('Do NOT use dotted tool names (e.g., filesystem.read_mcp_resource). / 禁止使用带点的工具名。'));
          mcp.push(bullet('Example / 示例: list_mcp_resources {"filter":"*.md","root":"./codex-local"}'));
          mcp.push(bullet('Discover server labels from results; use them in subsequent calls. / 先从结果里发现 server_label，再在后续调用中使用。'));
        } else {
          mcp.push(bullet('You may call read_mcp_resource and list_mcp_resource_templates now. / 现在可以调用 read_mcp_resource 和 list_mcp_resource_templates。'));
          mcp.push(bullet(`server must be one of: ${serverEnum.join(', ')} / server 必须从该列表中选择`));
          mcp.push(bullet('Examples / 示例:'));
          mcp.push('  read_mcp_resource {"server":"<one_of_known>","uri":"./codex-local/README.md"}');
          mcp.push('  list_mcp_resource_templates {"server":"<one_of_known>"}');
          mcp.push(bullet('Do NOT infer server from dotted prefixes. / 不要从带点前缀推断 server。'));
        }
      }

      const guidance = [...general, ...(mcp.length ? ['','',...mcp] : [])].join('\n');
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
          const misuseViewImage = name === 'view_image' && argsObj && typeof argsObj === 'object' && !isImagePathCompat((argsObj as any).path);
          if (unsupported || missingName || parseFail || misuseViewImage) {
            success = false;
            const hint = buildRepairMessageCompat(name, argsObj, bodyText);
            stderr = hint;
            try { raw = { error: 'tool_call_invalid', hint }; } catch { /* keep raw as-is */ }
          }
          const successBool = (typeof success === 'boolean') ? success : (typeof exitCode === 'number' ? exitCode === 0 : false);
          const envelope: any = {
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
          const misuseViewImage = name === 'view_image' && argsObj && typeof argsObj === 'object' && !isImagePathCompat((argsObj as any).path);
          if (unsupported || missingName || parseFail || misuseViewImage) {
            success = false;
            const hint = buildRepairMessageCompat(name, argsObj, bodyText);
            stderr = hint;
            try { raw = { error: 'tool_call_invalid', hint }; } catch { /* keep raw as-is */ }
          }
          const successBool2 = (typeof success === 'boolean') ? success : (typeof exitCode === 'number' ? exitCode === 0 : false);
          const envelope: any = {
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
