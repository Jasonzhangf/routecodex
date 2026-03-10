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

function buildApplyPatchGuidanceText(): { marker: string; text: string } {
  const marker = '[Codex ApplyPatch Guidance]';
  const text = [
    marker,
    'Send ONLY patch text (do not describe tools in prose).',
    '',
    '✅ Supported patch text formats:',
    '  A) Internal patch format: "*** Begin Patch" / "*** End Patch" + "*** Update/Add/Delete File"',
    '  B) GNU unified diff: "diff --git", "---/+++", "@@" hunks, /dev/null for new files',
    '',
    '✅ Create vs update:',
    '  - "*** Update File" MUST target an existing file (no implicit create).',
    '  - To create a file, use "*** Add File:" (or GNU diff with --- /dev/null).',
    '',
    '✅ Common pitfalls:',
    '  - In "*** Add File", EVERY content line must start with "+".',
    '  - In "*** Update File" hunks, EVERY line must start with one of: " " (context), "-" (remove), "+" (add), or "@@" (hunk header).',
    '',
    '✅ Minimal examples (patch text):',
    '',
    '1) Create a new file',
    '```patch',
    '*** Begin Patch',
    '*** Add File: path/to/new.txt',
    '+Line 1',
    '+Line 2',
    '*** End Patch',
    '```',
    '',
    '2) Replace one line in an existing file (keep surrounding context)',
    '```patch',
    '*** Begin Patch',
    '*** Update File: path/to/existing.txt',
    '@@',
    ' Line 1',
    '-Line 2',
    '+Modified Line 2',
    ' Line 3',
    '*** End Patch',
    '```',
    '',
    '3) Delete a file',
    '```patch',
    '*** Begin Patch',
    '*** Delete File: path/to/obsolete.txt',
    '*** End Patch',
    '```',
    '',
    'Paths must be workspace-relative ONLY (no leading "/" or drive letters). Absolute paths will be rejected by the sandbox.'
  ].join('\n');
  return { marker, text };
}

function augmentExecCommand(fn: Unknown): void {
  const marker = '[Codex ExecCommand Guidance]';
  const guidance = [
    marker,
    'FORBIDDEN: Do NOT call apply_patch via exec_command/shell. Use apply_patch tool directly.',
    'If you need to edit files, call apply_patch with patch text only.',
    'exec_command is only for shell commands that are NOT apply_patch.',
    '禁止通过 exec_command/shell 嵌套调用 apply_patch；修改文件必须直接调用 apply_patch 工具。'
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
    'Do not invent extra keys. File writes are FORBIDDEN via shell (no redirection, here-doc to files, sed -i, ed -s, tee). Use apply_patch to edit files.',
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

function augmentApplyPatch(fn: Unknown): void {
  const { marker, text: guidance } = buildApplyPatchGuidanceText();

  const params = ensureObjectSchema((fn as any).parameters);
  const props = (params as any).properties as Unknown;
  (props as any).patch = {
    type: 'string',
    description:
      'Patch text. Supports "*** Begin Patch" format or GNU unified diff. Paths must be workspace-relative (absolute paths are rejected).'
  } as Unknown;
  (props as any).input = {
    type: 'string',
    description: 'Alias of patch (patch text). Prefer using patch.'
  } as Unknown;
  (params as any).required = Array.isArray((params as any).required) ? (params as any).required : [];
  if (!(params as any).required.includes('patch')) {
    (params as any).required.push('patch');
  }
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
          const { marker, text } = buildApplyPatchGuidanceText();
          (fn as any).description = appendOnce(((fn as any).description as string | undefined), text, marker);
          augmentApplyPatch(fn);
        }
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
        if (n === 'exec_command') {
          augmentExecCommand(copy as Unknown);
        }
        if (n === 'apply_patch') {
          ((schema as any).properties as any).patch = {
            type: 'string',
            description: 'Patch text (*** Begin Patch / *** End Patch or GNU unified diff).'
          } as Unknown;
          ((schema as any).properties as any).input = {
            type: 'string',
            description: 'Alias of patch (patch text). Prefer patch.'
          } as Unknown;
          if (!Array.isArray((schema as any).required)) (schema as any).required = [];
          if (!((schema as any).required as string[]).includes('patch')) ((schema as any).required as string[]).push('patch');
          (schema as any).additionalProperties = false;
          (copy as any).input_schema = schema;
          const marker = '[Codex ApplyPatch Guidance]';
          const guidance = buildApplyPatchGuidanceText().text;
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
  lines.push(bullet('NEVER wrap apply_patch inside exec_command/shell. Direct apply_patch tool call only. / 严禁在 exec_command/shell 中嵌套 apply_patch，必须直接调用 apply_patch。'));
  lines.push(bullet('apply_patch: Before writing, always read the target file first and compute changes against the latest content using appropriate tools. / apply_patch 在写入前必须先通过合适的工具读取目标文件最新内容，并基于该内容生成变更。'));
  lines.push(bullet('apply_patch: Send patch text only. Supported formats: "*** Begin Patch" OR GNU unified diff. "*** Update File" never implicitly creates files—use "*** Add File:" (or /dev/null diff). / apply_patch：仅发送补丁文本，支持 "*** Begin Patch" 或 GNU diff；"*** Update File" 不会隐式创建文件。'));
  lines.push(bullet('apply_patch: For a given file, prefer one contiguous change block per call; if you need to touch non-adjacent regions, split them into multiple apply_patch calls. / apply_patch 修改同一文件时尽量只提交一段连续补丁，多个不相邻位置请拆成多次调用。'));
  lines.push(bullet('update_plan: Keep exactly one step in_progress; others pending/completed. / 仅一个 in_progress 步骤。'));
  lines.push(bullet('view_image: Path must be an image file (.png .jpg .jpeg .gif .webp .bmp .svg). / 仅图片路径。'));
  lines.push(bullet('Do NOT use view_image for text files (.md/.ts/.js/.json). Use shell: {"command":["cat","<path>"]}. / 文本文件请用 shell: cat。'));
  // Preamble alignment with harness: keep a single concise preamble, but no tool-call meta narration.
  lines.push(bullet('Preamble: Before making tool calls, send ONE brief sentence about immediate next steps (skip for trivial reads); then emit tool_calls. Do not narrate tool-call meta (e.g., “工具调用已生成”). / 预叙：调用工具前可发送一句简短计划（琐碎读取可省略），随后直接生成 tool_calls；不要叙述“已生成工具调用”等元信息。'));
  return lines.join('\n');
}

// 注意：我们不再提供"精炼/替换"已有 system 提示词的能力。
