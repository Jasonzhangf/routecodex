// Tool guidance augmentation utilities (OpenAI + Anthropic shapes)
// Standalone module to keep guidance policy centralized and easy to evolve.
import { isObject } from '../shared/common-utils.js';

type Unknown = Record<string, unknown>;

function logGuidanceNonBlocking(
  stage: string,
  error: unknown,
  details: Record<string, unknown> = {}
): void {
  try {
    const reason = error instanceof Error ? (error.stack || `${error.name}: ${error.message}`) : String(error);
    const detailSuffix = Object.keys(details).length ? ` details=${JSON.stringify(details)}` : '';
    console.warn(`[guidance] ${stage} failed (non-blocking): ${reason}${detailSuffix}`);
  } catch {
    // Never throw from non-blocking logging.
  }
}


function ensureObjectSchema(obj?: unknown): Unknown {
  const o = (obj && typeof obj === 'object') ? (obj as Unknown) : {};
  if (typeof (o as any).type !== 'string') (o as any).type = 'object';
  if (!isObject((o as any).properties)) (o as any).properties = {} as Unknown;
  if (typeof (o as any).additionalProperties !== 'boolean') (o as any).additionalProperties = true;
  return o;
}

function appendOnce(desc: string | undefined, guidance: string, marker: string): string {
  const base = (typeof desc === 'string') ? desc : '';
  if (base.includes(marker)) return base;
  return base ? `${base}\n\n${guidance}` : guidance;
}

function augmentExecCommand(fn: Unknown): void {
  const marker = '[Codex ExecCommand Guidance]';
  const guidance = [
    marker,
    'Use exec_command only for shell execution.',
    'Keep shell intent inside exec_command arguments; do not mix shell planning prose into tool arguments.',
    'When shell features are needed, prefer a single `bash -lc` command string.'
  ].join('\n');
  (fn as any).description = appendOnce(((fn as any).description as string | undefined), guidance, marker);
}

function augmentShell(fn: Unknown): void {
  const marker = '[Codex Shell Guidance]';
  const guidance = [
    marker,
    'Execute shell commands. Two accepted forms:',
    '  1) argv tokens: ["ls","-la"]',
    '  2) bash -lc with a single string: ["bash","-lc","<single command string>"] (required for complex/multi-line/pipe/&&/||/here-doc to interpreter).',
    'The 3rd arg of bash -lc MUST be exactly one string. Do not split meta-operators (|, >, &&, ||) into separate elements.',
    'Do not invent extra keys.',
    'Examples: ["ls","-la","Obsidian"]; ["bash","-lc","cd Obsidian && ls -la"]; ["bash","-lc","python3 - <<\'PY\'\\nprint(\\"ok\\")\\nPY"]',
    'If arguments are invalid (e.g., bash -lc without a single string), return a structured error as the tool result (role=tool, same tool_call_id) and continue the conversation.',
    'Prefer ripgrep (rg) when available. Keep explanations in assistant text; do not mix narration into tool arguments.'
  ].join('\n');

  const params = ensureObjectSchema((fn as any).parameters);
  const props = (params as any).properties as Unknown;
  // 强约束：仅允许数组形态。分支A：严格 bash -lc 3 元组；分支B：纯 argv（无强校验，运行时由 governor 处理元字符）。
  (props as any).command = {
    description: 'Shell command. Use argv tokens OR ["bash","-lc","<single command string>"] for complex commands.',
    oneOf: [
      {
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: [
          { const: 'bash' },
          { const: '-lc' },
          { type: 'string' }
        ]
      },
      {
        type: 'array',
        items: { type: 'string' }
      }
    ]
  } as Unknown;
  (params as any).additionalProperties = false;
  (fn as any).parameters = params;
  (fn as any).description = appendOnce(((fn as any).description as string | undefined), guidance, marker);
}

function augmentUpdatePlan(fn: Unknown): void {
  const marker = '[Codex Plan Guidance]';
  const guidance = [
    marker,
    'Maintain a short stepwise plan. Exactly one step should be in_progress; others pending/completed.'
  ].join('\n');
  (fn as any).description = appendOnce(((fn as any).description as string | undefined), guidance, marker);
}

function augmentViewImage(fn: Unknown): void {
  const marker = '[Codex ViewImage Guidance]';
  const guidance = [
    marker,
    'Attach a local image only. Path must point to an existing image file (.png .jpg .jpeg .gif .webp .bmp .svg .tif .tiff .ico .heic .jxl).',
    'Never use view_image to read text documents (e.g., .md/.ts/.js/.json). For text content, use shell: {"command":["cat","<path>"]}.'
  ].join('\n');
  const params = ensureObjectSchema((fn as any).parameters);
  const props = (params as any).properties as Unknown;
  if (!isObject((props as any).path)) {
    (props as any).path = { type: 'string', description: 'Local filesystem path to an image file' } as Unknown;
  }
  (params as any).additionalProperties = false;
  (fn as any).parameters = params;
  (fn as any).description = appendOnce(((fn as any).description as string | undefined), guidance, marker);
}

function augmentMCP(fn: Unknown, toolName: string): void {
  const marker = `[Codex MCP Guidance:${toolName}]`;
  const guidance = [
    marker,
    'Use MCP resources sparingly. Provide only required fields; avoid unnecessary large reads.',
    'Do not call MCP resource tools unless you actually need MCP resources (not MCP tools).',
    'If list_mcp_resources returns an empty list or a "Method not found" error (-32601), do not retry; assume no MCP resources are available in this session.',
    'If you need MCP resources but do not know the MCP server label, call list_mcp_resources({}) once and reuse the returned server labels.',
    'Note: arguments.server is an MCP server label (NOT a tool name like shell/exec_command/apply_patch).'
  ].join('\n');
  (fn as any).description = appendOnce(((fn as any).description as string | undefined), guidance, marker);
}

// For OpenAI tool shape: { type:'function', function:{ name, description?, parameters } }
export function augmentOpenAITools(tools: unknown[]): unknown[] {
  if (!Array.isArray(tools)) return tools;
  const out: unknown[] = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') { out.push(t); continue; }
    const copy: Unknown = JSON.parse(JSON.stringify(t));
    const fn = isObject((copy as any).function) ? ((copy as any).function as Unknown) : null;
    const name = fn && typeof (fn as any).name === 'string' ? String((fn as any).name) : undefined;
    if (fn && name) {
      const n = name.trim();
      try {
        if (n === 'shell') augmentShell(fn);
        else if (n === 'exec_command') augmentExecCommand(fn);
        else if (n === 'apply_patch') {
          // apply_patch schema/guidance owner moved to chat process SSOT
        }
        else if (n === 'update_plan') augmentUpdatePlan(fn);
        else if (n === 'view_image') augmentViewImage(fn);
        else if (n === 'list_mcp_resources' || n === 'read_mcp_resource' || n === 'list_mcp_resource_templates') augmentMCP(fn, n);
      } catch (error) {
        logGuidanceNonBlocking('augment_openai_tool', error, { toolName: n });
      }
    }
    out.push(copy);
  }
  return out;
}

// For Anthropic tool shape: { name, description?, input_schema }
export function augmentAnthropicTools(tools: unknown[]): unknown[] {
  if (!Array.isArray(tools)) return tools;
  const out: unknown[] = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') { out.push(t); continue; }
    const copy: Unknown = JSON.parse(JSON.stringify(t));
    const name = typeof (copy as any).name === 'string' ? String((copy as any).name) : undefined;
    const desc = typeof (copy as any).description === 'string' ? String((copy as any).description) : undefined;
    const schema = ensureObjectSchema((copy as any).input_schema);
    if (name) {
      const n = name.trim();
      try {
        if (n === 'exec_command') {
          augmentExecCommand(copy as Unknown);
        }
        if (n === 'shell') {
          const marker = '[Codex Shell Guidance]';
          const guidance = [marker, 'Execute commands via argv tokens only (no redirection).'].join('\n');
          (copy as any).description = appendOnce(desc, guidance, marker);
        }
        if (n === 'update_plan') {
          const marker = '[Codex Plan Guidance]';
          const guidance = [marker, 'Maintain a short plan; one in_progress step only.'].join('\n');
          (copy as any).description = appendOnce(desc, guidance, marker);
        }
        if (n === 'view_image' || n === 'list_mcp_resources' || n === 'read_mcp_resource' || n === 'list_mcp_resource_templates') {
          const marker = `[Codex MCP Guidance:${n}]`;
          const guidance = [marker, 'Use minimally; avoid unnecessary large reads.'].join('\n');
          (copy as any).description = appendOnce(desc, guidance, marker);
        }
      } catch (error) {
        logGuidanceNonBlocking('augment_anthropic_tool', error, { toolName: n });
      }
    }
    out.push(copy);
  }
  return out;
}

// Build a minimal, consistent system tool guidance string (OpenAI tool_calls model)
export function buildSystemToolGuidance(): string {
  const bullet = (s: string) => `- ${s}`;
  const lines: string[] = [];
  lines.push('Tool usage guidance (OpenAI tool_calls) / 工具使用指引（OpenAI 标准）');
  lines.push(bullet('Always use assistant.tool_calls[].function.{name,arguments}; never embed tool calls in plain text. / 一律通过 tool_calls 调用工具，不要把工具调用写进普通文本。'));
  lines.push(bullet('function.arguments must be a single JSON string. / arguments 必须是单个 JSON 字符串。'));
  lines.push(bullet('update_plan: Keep exactly one step in_progress; others pending/completed. / 仅一个 in_progress 步骤。'));
  lines.push(bullet('view_image: Path must be an image file (.png .jpg .jpeg .gif .webp .bmp .svg). / 仅图片路径。'));
  lines.push(bullet('Do NOT use view_image for text files (.md/.ts/.js/.json). Use shell: {"command":["cat","<path>"]}. / 文本文件请用 shell: cat。'));
  return lines.join('\n');
}

// 注意：我们不再提供"精炼/替换"已有 system 提示词的能力。
