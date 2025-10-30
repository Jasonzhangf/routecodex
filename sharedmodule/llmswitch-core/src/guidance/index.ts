// Tool guidance augmentation utilities (OpenAI + Anthropic shapes)
// Standalone module to keep guidance policy centralized and easy to evolve.

type Unknown = Record<string, unknown>;

function isObject(v: unknown): v is Unknown {
  return !!v && typeof v === 'object' && !Array.isArray(v);
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

function augmentShell(fn: Unknown): void {
  const marker = '[Codex Shell Guidance]';
  const guidance = [
    marker,
    'Execute shell commands. Place ALL flags, paths and patterns into the `command` array as argv tokens.',
    'Do not invent extra keys. Do not use shell redirection or here-doc for file writes; use apply_patch for editing files.'
  ].join('\n');

  const params = ensureObjectSchema((fn as any).parameters);
  const props = (params as any).properties as Unknown;
  if (!isObject((props as any).command)) {
    (props as any).command = { type: 'array', items: { type: 'string' }, description: 'argv tokens' } as Unknown;
  }
  (params as any).additionalProperties = false;
  (fn as any).parameters = params;
  (fn as any).description = appendOnce(((fn as any).description as string | undefined), guidance, marker);
  (fn as any).strict = true;
}

function augmentApplyPatch(fn: Unknown): void {
  const marker = '[Codex ApplyPatch Guidance]';
  const guidance = [
    marker,
    'Edit files by applying a unified diff patch. Return ONLY the patch text with *** Begin Patch/*** End Patch blocks.',
    'Example:',
    '*** Begin Patch',
    '*** Update File: path/to/file.ts',
    '@@',
    '- old line',
    '+ new line',
    '*** End Patch'
  ].join('\n');

  const params = ensureObjectSchema((fn as any).parameters);
  const props = (params as any).properties as Unknown;
  if (!isObject((props as any).patch)) {
    (props as any).patch = { type: 'string', description: 'Unified diff patch text' } as Unknown;
  }
  if (!Array.isArray((params as any).required)) { (params as any).required = []; }
  if (!(params as any).required.includes('patch')) { (params as any).required.push('patch'); }
  (params as any).additionalProperties = false;
  (fn as any).parameters = params;
  (fn as any).description = appendOnce(((fn as any).description as string | undefined), guidance, marker);
  (fn as any).strict = true;
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
    'Attach a local image. Path must point to an existing image file (.png .jpg .jpeg .gif .webp .bmp .svg).'
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
    'Use MCP resources sparingly. Provide only required fields; avoid unnecessary large reads.'
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
        else if (n === 'apply_patch') augmentApplyPatch(fn);
        else if (n === 'update_plan') augmentUpdatePlan(fn);
        else if (n === 'view_image') augmentViewImage(fn);
        else if (n === 'list_mcp_resources' || n === 'read_mcp_resource' || n === 'list_mcp_resource_templates') augmentMCP(fn, n);
      } catch { /* ignore */ }
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
        if (n === 'apply_patch') {
          if (!isObject(((schema as any).properties as any)?.patch)) {
            ((schema as any).properties as any).patch = { type: 'string', description: 'Unified diff patch text' } as Unknown;
          }
          if (!Array.isArray((schema as any).required)) (schema as any).required = [];
          if (!((schema as any).required as string[]).includes('patch')) ((schema as any).required as string[]).push('patch');
          (schema as any).additionalProperties = false;
          (copy as any).input_schema = schema;
          const marker = '[Codex ApplyPatch Guidance]';
          const guidance = [
            marker,
            'Use unified diff patch with *** Begin Patch/End Patch. Return only the patch text.'
          ].join('\n');
          (copy as any).description = appendOnce(desc, guidance, marker);
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
      } catch { /* ignore */ }
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
  lines.push(bullet('shell: Place ALL intent into the command argv array only; do not invent extra keys. / shell 所有意图写入 command 数组，不要添加额外键名。'));
  lines.push(bullet('File writes are FORBIDDEN via shell (no redirection, no here-doc, no sed -i, no ed -s, no tee). Use apply_patch ONLY. / 通过 shell 写文件一律禁止（不得使用重定向、heredoc、sed -i、ed -s、tee）；必须使用 apply_patch。'));
  lines.push(bullet('apply_patch: Provide a unified diff patch with *** Begin Patch/*** End Patch only. / 仅输出统一 diff 补丁。'));
  lines.push(bullet('apply_patch example / 示例：\n*** Begin Patch\n*** Update File: path/to/file.ts\n@@\n- old line\n+ new line\n*** End Patch'));
  lines.push(bullet('update_plan: Keep exactly one step in_progress; others pending/completed. / 仅一个 in_progress 步骤。'));
  lines.push(bullet('view_image: Path must be an image file (.png .jpg .jpeg .gif .webp .bmp .svg). / 仅图片路径。'));
  lines.push(bullet('Do not narrate tool intent (e.g., “工具调用已生成，请执行工具并继续。”); emit tool_calls directly. / 不要输出“准备调用工具/工具调用已生成”等提示，直接生成 tool_calls。'));
  return lines.join('\n');
}

// Normalize/replace existing system tool guidance with canonical one; drop non-canonical guidance lines.
export function refineSystemToolGuidance(systemText: string): string {
  try {
    if (typeof systemText !== 'string' || !systemText) return systemText;
    const marker = '[Codex Tool Guidance v1]';
    if (systemText.includes(marker)) return systemText;

    const text = String(systemText);
    const lines = text.split(/\r?\n/);
    // Drop platform-specific editing tips and any existing ad-hoc tool guidance lines
    const drop = /heredoc|\bcat\s*>|\bsed\s+-i\b|\bed\s+-s\b|Atomic write|Overwrite:|Append:|git apply|tool_calls|function\.arguments|function\.name|argv tokens|apply_patch|update_plan|view_image|list_mcp_resources|read_mcp_resource|list_mcp_resource_templates|MCP tool usage|工具使用指引/i;
    const kept = lines.filter((ln) => !drop.test(ln));
    const cleaned = kept.join('\n').trimEnd();

    const guidance = buildSystemToolGuidance();
    const block = `${marker}\n${guidance}`;
    // Prepend canonical guidance; keep the remaining non-tool content to avoid losing other behaviors
    return cleaned ? `${block}\n\n${cleaned}` : block;
  } catch { return systemText; }
}
