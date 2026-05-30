/**
 * Pure function library for Windsurf cascade prompt building and tool mapping.
 * No class state, no side effects — all functions are stateless.
 */
export type WindsurfFailureClass = {
  code: string;
  retryable: boolean;
  status: number;
  upstreamCode?: string;
  upstreamStatus?: number;
  rateLimitKind?: 'daily_limit' | 'short_lived' | 'synthetic_cooldown';
  cooldownOverrideMs?: number;
  quotaScope?: 'weekly' | 'model';
  quotaReason?: string;
};

export type WindsurfSemanticTurn =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string; tool_calls?: Array<{ call_id: string; name: string; arguments: Record<string, unknown> }> }
  | { type: 'function_call_output'; call_id: string; name?: string; output: string; source?: 'bridge_tool_history' };

export type WindsurfBridgeToolHistoryPair = {
  callId: string;
  name: string;
  arguments?: unknown;
  output: string;
  status?: string;
};

export type WindsurfCascadeAdditionalStepsOptions = {
  currentOnly?: boolean;
  mcpMode?: boolean;
};

export function attachWindsurfErrorFields(target: Error & Record<string, unknown>, c: WindsurfFailureClass): void {
  target.code = c.code;
  target.status = c.status;
  target.retryable = c.retryable;
  target.upstreamCode = c.upstreamCode || c.code;
  if (typeof c.upstreamStatus === 'number' && Number.isFinite(c.upstreamStatus)) {
    target.upstreamStatus = c.upstreamStatus;
  }
  target.providerFamily = 'windsurf';
  target.type = 'windsurf_upstream_error';
  target.providerAccountOwnership = 'internal';
  if (c.code === 'WINDSURF_UPSTREAM_TRANSIENT') {
    target.retryScope = 'provider-internal-only';
  }
  if (c.rateLimitKind) {
    target.rateLimitKind = c.rateLimitKind;
  }
  if (typeof c.cooldownOverrideMs === 'number' && Number.isFinite(c.cooldownOverrideMs) && c.cooldownOverrideMs > 0) {
    target.cooldownOverrideMs = c.cooldownOverrideMs;
  }
  if (c.quotaScope) {
    target.quotaScope = c.quotaScope;
  }
  if (c.quotaReason) {
    target.quotaReason = c.quotaReason;
  }
}

export function createWindsurfProviderError(message: string, fields: Partial<WindsurfFailureClass> = {}): Error {
  const error = new Error(message) as Error & Record<string, unknown>;
  attachWindsurfErrorFields(error, {
    code: fields.code || 'WINDSURF_SERVICE_UNREACHABLE',
    retryable: fields.retryable ?? false,
    status: fields.status ?? 502,
    upstreamCode: fields.upstreamCode,
    upstreamStatus: fields.upstreamStatus,
    rateLimitKind: fields.rateLimitKind,
    cooldownOverrideMs: fields.cooldownOverrideMs,
    quotaScope: fields.quotaScope,
    quotaReason: fields.quotaReason,
  });
  return error;
}

export const WINDSURF_CASCADE_TOOL_CONFIG_FIELDS: Record<string, number> = {
  find: 5,
  run_command: 8,
  view_file: 10,
  list_directory: 19,
  grep_search_v2: 33,
};

export type WindsurfCascadeToolStepKind =
  | 'view_file'
  | 'run_command'
  | 'find'
  | 'grep_search_v2'
  | 'list_directory'
  | 'write_to_file'
  | 'grep_search'
  | 'read_url_content'
  | 'search_web';

export type WindsurfCascadeMappedTool = {
  kind: WindsurfCascadeToolStepKind;
  forward: (args: Record<string, unknown>) => Record<string, unknown>;
  applyObservation?: (payload: Record<string, unknown>, observation: string) => void;
};

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`);
  return `{${entries.join(',')}}`;
}

export function buildFileUri(value: string): string {
  const path = value.trim();
  if (!path) return '';
  if (/^file:\/\//i.test(path)) return path;
  return path.startsWith('/') ? `file://${path}` : path;
}

export function flattenToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const block = item as Record<string, unknown>;
      const type = typeof block.type === 'string' ? block.type.trim().toLowerCase() : '';
      if ((type === 'text' || type === 'output_text') && typeof block.text === 'string') parts.push(block.text);
      else if (typeof block.output === 'string') parts.push(block.output);
      else if (typeof block.content === 'string') parts.push(block.content);
    }
    return parts.join('');
  }
  return JSON.stringify(content);
}

export const WINDSURF_TOOL_MAP: Record<string, WindsurfCascadeMappedTool> = {
  read_file: {
    kind: 'view_file',
    forward: (args) => ({
      absolute_path_uri: buildFileUri(String(args.filePath ?? args.file_path ?? args.path ?? '')),
      ...(Number.isFinite(Number(args.offset)) && Number(args.offset) > 0 ? { offset: Number(args.offset) } : {}),
      ...(Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? { limit: Number(args.limit) } : {}),
    }),
    applyObservation: (payload, observation) => { payload.content = observation; },
  },
  read: {
    kind: 'view_file',
    forward: (args) => ({
      absolute_path_uri: buildFileUri(String(args.filePath ?? args.file_path ?? args.path ?? '')),
      ...(Number.isFinite(Number(args.offset)) && Number(args.offset) > 0 ? { offset: Number(args.offset) } : {}),
      ...(Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? { limit: Number(args.limit) } : {}),
    }),
    applyObservation: (payload, observation) => { payload.content = observation; },
  },
  view_file: {
    kind: 'view_file',
    forward: (args) => ({
      absolute_path_uri: buildFileUri(String(args.filePath ?? args.file_path ?? args.path ?? '')),
      ...(Number.isFinite(Number(args.offset)) && Number(args.offset) > 0 ? { offset: Number(args.offset) } : {}),
      ...(Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? { limit: Number(args.limit) } : {}),
    }),
    applyObservation: (payload, observation) => { payload.content = observation; },
  },
  exec_command: {
    kind: 'run_command',
    forward: (args) => ({
      command_line: String(args.cmd ?? args.command ?? args.command_line ?? args.input ?? ''),
      ...(typeof args.workdir === 'string' && args.workdir ? { cwd: args.workdir } : {}),
      ...(typeof args.cwd === 'string' && args.cwd && typeof args.workdir !== 'string' ? { cwd: args.cwd } : {}),
      blocking: true,
    }),
    applyObservation: (payload, observation) => {
      payload.full_output = observation;
      payload.stdout = observation;
      payload.exit_code = 0;
    },
  },
  run_command: {
    kind: 'run_command',
    forward: (args) => ({
      command_line: String(args.cmd ?? args.command ?? args.command_line ?? args.proposed_command_line ?? args.input ?? ''),
      ...(typeof args.workdir === 'string' && args.workdir ? { cwd: args.workdir } : {}),
      ...(typeof args.cwd === 'string' && args.cwd ? { cwd: args.cwd } : {}),
      blocking: true,
    }),
    applyObservation: (payload, observation) => {
      payload.full_output = observation;
      payload.stdout = observation;
      payload.exit_code = 0;
    },
  },
  bash: {
    kind: 'run_command',
    forward: (args) => ({
      command_line: String(args.command ?? args.shell_command ?? args.cmd ?? ''),
      ...(typeof args.cwd === 'string' && args.cwd ? { cwd: args.cwd } : {}),
      blocking: true,
    }),
    applyObservation: (payload, observation) => {
      payload.full_output = observation;
      payload.stdout = observation;
      payload.exit_code = 0;
    },
  },
  shell: {
    kind: 'run_command',
    forward: (args) => ({
      command_line: String(args.command ?? args.shell_command ?? args.cmd ?? ''),
      ...(typeof args.cwd === 'string' && args.cwd ? { cwd: args.cwd } : {}),
      blocking: true,
    }),
    applyObservation: (payload, observation) => {
      payload.full_output = observation;
      payload.stdout = observation;
      payload.exit_code = 0;
    },
  },
  shell_command: {
    kind: 'run_command',
    forward: (args) => ({
      command_line: String(args.command ?? args.shell_command ?? args.cmd ?? ''),
      ...(typeof args.workdir === 'string' && args.workdir ? { cwd: args.workdir } : {}),
      ...(typeof args.cwd === 'string' && args.cwd && typeof args.workdir !== 'string' ? { cwd: args.cwd } : {}),
      blocking: true,
    }),
    applyObservation: (payload, observation) => {
      payload.full_output = observation;
      payload.stdout = observation;
      payload.exit_code = 0;
    },
  },
  list_dir: {
    kind: 'list_directory',
    forward: (args) => ({
      directory_path_uri: buildFileUri(String(args.path ?? args.directory_path ?? args.cwd ?? '')),
      ...(typeof args.recursive === 'boolean' ? { recursive: args.recursive } : {}),
    }),
    applyObservation: (payload, observation) => {
      payload.children = observation.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
    },
  },
  list_directory: {
    kind: 'list_directory',
    forward: (args) => ({
      directory_path_uri: buildFileUri(String(args.path ?? args.directory_path ?? args.filePath ?? '')),
      ...(typeof args.recursive === 'boolean' ? { recursive: args.recursive } : {}),
    }),
    applyObservation: (payload, observation) => {
      payload.children = observation.split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
    },
  },
  find: {
    kind: 'find',
    forward: (args) => ({
      pattern: String(args.pattern ?? ''),
      ...(typeof args.path === 'string' && args.path ? { search_directory: args.path } : {}),
    }),
    applyObservation: (payload, observation) => { payload.raw_output = observation; },
  },
  glob: {
    kind: 'find',
    forward: (args) => ({
      pattern: String(args.pattern ?? ''),
      ...(typeof args.path === 'string' && args.path ? { search_directory: args.path } : {}),
    }),
    applyObservation: (payload, observation) => { payload.raw_output = observation; },
  },
  grep: {
    kind: 'grep_search_v2',
    forward: (args) => ({
      pattern: String(args.pattern ?? ''),
      ...(typeof args.path === 'string' && args.path ? { path: args.path } : {}),
      ...(typeof args.glob === 'string' && args.glob ? { glob: args.glob } : {}),
      ...(typeof args['-i'] === 'boolean' ? { case_insensitive: args['-i'] } : {}),
    }),
    applyObservation: (payload, observation) => { payload.raw_output = observation; },
  },
  grep_search: {
    kind: 'grep_search_v2',
    forward: (args) => ({
      pattern: String(args.pattern ?? ''),
      ...(typeof args.path === 'string' && args.path ? { path: args.path } : {}),
      ...(typeof args.glob === 'string' && args.glob ? { glob: args.glob } : {}),
      ...(typeof args['-i'] === 'boolean' ? { case_insensitive: args['-i'] } : {}),
    }),
    applyObservation: (payload, observation) => { payload.raw_output = observation; },
  },
  grep_search_v2: {
    kind: 'grep_search_v2',
    forward: (args) => ({
      pattern: String(args.pattern ?? ''),
      ...(typeof args.path === 'string' && args.path ? { path: args.path } : {}),
      ...(typeof args.glob === 'string' && args.glob ? { glob: args.glob } : {}),
      ...(typeof args['-i'] === 'boolean' ? { case_insensitive: args['-i'] } : {}),
    }),
    applyObservation: (payload, observation) => { payload.raw_output = observation; },
  },
  write: {
    kind: 'write_to_file',
    forward: (args) => ({
      target_file_uri: buildFileUri(String(args.file_path ?? args.filePath ?? args.path ?? '')),
      code_content: typeof args.content === 'string'
        ? [args.content]
        : Array.isArray(args.content)
          ? args.content.map((entry) => String(entry))
          : [String(args.content ?? '')],
    }),
  },
  write_to_file: {
    kind: 'write_to_file',
    forward: (args) => ({
      target_file_uri: buildFileUri(String(args.target_file_uri ?? args.file_path ?? args.filePath ?? args.path ?? '')),
      code_content: Array.isArray(args.code_content)
        ? args.code_content.map((entry) => String(entry))
        : typeof args.content === 'string'
          ? [args.content]
          : [String(args.content ?? '')],
    }),
  },
  websearch: {
    kind: 'search_web',
    forward: (args) => ({
      query: String(args.query ?? args.q ?? ''),
      ...(Array.isArray(args.domains) && args.domains.length > 0
        ? { domain: String(args.domains[0]) }
        : typeof args.domain === 'string' && args.domain
          ? { domain: args.domain }
          : {}),
    }),
    applyObservation: (payload, observation) => { payload.summary = observation; },
  },
  toolsearch: {
    kind: 'search_web',
    forward: (args) => ({
      query: String(args.query ?? args.q ?? ''),
      ...(Array.isArray(args.domains) && args.domains.length > 0
        ? { domain: String(args.domains[0]) }
        : typeof args.domain === 'string' && args.domain
          ? { domain: args.domain }
          : {}),
    }),
    applyObservation: (payload, observation) => { payload.summary = observation; },
  },
  web_search: {
    kind: 'search_web',
    forward: (args) => ({
      query: String(args.query ?? args.q ?? ''),
      ...(Array.isArray(args.domains) && args.domains.length > 0
        ? { domain: String(args.domains[0]) }
        : typeof args.domain === 'string' && args.domain
          ? { domain: args.domain }
          : {}),
    }),
    applyObservation: (payload, observation) => { payload.summary = observation; },
  },
  webfetch: {
    kind: 'read_url_content',
    forward: (args) => ({
      url: String(args.url ?? args.uri ?? args.link ?? ''),
    }),
    applyObservation: (payload, observation) => { payload.summary = observation; },
  },
  read_url_content: {
    kind: 'read_url_content',
    forward: (args) => ({
      url: String(args.url ?? args.uri ?? args.link ?? ''),
    }),
    applyObservation: (payload, observation) => { payload.summary = observation; },
  },
};

export function windsurfToolLookupName(name: unknown): string {
  return String(name || '').trim().toLowerCase();
}

export function normalizeWindsurfToolDefinition(tool: Record<string, unknown>): Record<string, unknown> | null {
  const fn = tool && typeof tool.function === 'object' && !Array.isArray(tool.function)
    ? tool.function as Record<string, unknown>
    : null;
  if (fn && typeof fn.name === 'string' && fn.name.trim()) {
    return tool;
  }
  if (typeof tool.name !== 'string' || !tool.name.trim()) {
    return null;
  }
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      ...(tool.parameters && typeof tool.parameters === 'object' && !Array.isArray(tool.parameters) ? { parameters: tool.parameters } : {}),
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    },
  };
}

export function collectWindsurfMappedTools(tools: Array<Record<string, unknown>>): Array<{ name: string; kind: WindsurfCascadeToolStepKind }> {
  const out: Array<{ name: string; kind: WindsurfCascadeToolStepKind }> = [];
  for (const tool of tools) {
    const normalized = normalizeWindsurfToolDefinition(tool);
    const fn = normalized?.function as Record<string, unknown> | undefined;
    const name = typeof fn?.name === 'string' ? fn.name : '';
    const mapped = WINDSURF_TOOL_MAP[windsurfToolLookupName(name)];
    if (mapped) out.push({ name, kind: mapped.kind });
  }
  return out;
}

export function partitionWindsurfTools(tools: Array<Record<string, unknown>>): {
  nativeTools: Array<Record<string, unknown>>;
  customTools: Array<Record<string, unknown>>;
  mappedNativeTools: Array<{ name: string; kind: WindsurfCascadeToolStepKind }>;
} {
  const nativeTools: Array<Record<string, unknown>> = [];
  const customTools: Array<Record<string, unknown>> = [];
  const mappedNativeTools: Array<{ name: string; kind: WindsurfCascadeToolStepKind }> = [];
  for (const tool of tools) {
    const normalized = normalizeWindsurfToolDefinition(tool);
    if (!normalized) continue;
    const fn = normalized.function as Record<string, unknown> | undefined;
    const name = typeof fn?.name === 'string' ? fn.name : '';
    const mapped = WINDSURF_TOOL_MAP[windsurfToolLookupName(name)];
    if (mapped) {
      nativeTools.push(normalized);
      mappedNativeTools.push({ name, kind: mapped.kind });
    } else if (name) {
      customTools.push(normalized);
    }
  }
  return { nativeTools, customTools, mappedNativeTools };
}

export function windsurfToolNameSet(tools: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(tools)) return out;
  for (const tool of tools) {
    const row = tool && typeof tool === 'object' && !Array.isArray(tool) ? tool as Record<string, unknown> : null;
    const fn = row?.function && typeof row.function === 'object' && !Array.isArray(row.function) ? row.function as Record<string, unknown> : null;
    const name = typeof fn?.name === 'string' ? fn.name.trim() : typeof row?.name === 'string' ? row.name.trim() : '';
    if (name) {
      out.add(name);
      out.add(windsurfToolLookupName(name));
    }
  }
  return out;
}

export function findWindsurfToolDefinition(tools: unknown, name: string): Record<string, unknown> | undefined {
  const lookup = windsurfToolLookupName(name);
  if (!lookup || !Array.isArray(tools)) return undefined;
  for (const tool of tools) {
    const row = tool && typeof tool === 'object' && !Array.isArray(tool) ? tool as Record<string, unknown> : undefined;
    const fn = row?.function && typeof row.function === 'object' && !Array.isArray(row.function) ? row.function as Record<string, unknown> : undefined;
    const candidate = typeof fn?.name === 'string' ? fn.name : typeof row?.name === 'string' ? row.name : '';
    if (windsurfToolLookupName(candidate) === lookup) return row;
  }
  return undefined;
}

export function setHiddenWindsurfBodyField(body: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(body, key, {
    value,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

export function fileUriToPath(value: unknown): string {
  const text = String(value || '').trim();
  if (!text.startsWith('file://')) return text;
  try {
    return decodeURIComponent(text.replace(/^file:\/\//, ''));
  } catch {
    return text.replace(/^file:\/\//, '');
  }
}

export function reverseWindsurfNativeToolArguments(standardName: string, nativeKind: WindsurfCascadeToolStepKind, args: Record<string, unknown>): Record<string, unknown> {
  const normalized = windsurfToolLookupName(standardName);
  switch (nativeKind) {
    case 'run_command': {
      const command = String(args.command ?? args.cmd ?? args.command_line ?? args.proposed_command_line ?? args.input ?? '');
      return {
        ...(command ? { command } : {}),
        ...(typeof args.cwd === 'string' && args.cwd ? { cwd: args.cwd } : {}),
        ...(typeof args.workdir === 'string' && args.workdir ? { workdir: args.workdir } : {}),
      };
    }
    case 'view_file': {
      const filePath = fileUriToPath(args.filePath ?? args.file_path ?? args.path ?? args.absolute_path_uri ?? '');
      return {
        ...(filePath ? { filePath } : {}),
        ...(Number.isFinite(Number(args.offset)) ? { offset: Number(args.offset) } : {}),
        ...(Number.isFinite(Number(args.limit)) ? { limit: Number(args.limit) } : {}),
      };
    }
    case 'list_directory': {
      const path = fileUriToPath(args.path ?? args.directory_path ?? args.directory_path_uri ?? '');
      return {
        ...(path ? { path } : {}),
        ...(typeof args.recursive === 'boolean' ? { recursive: args.recursive } : {}),
      };
    }
    case 'find':
      return {
        ...(typeof args.pattern === 'string' ? { pattern: args.pattern } : {}),
        ...(typeof args.path === 'string' ? { path: args.path } : typeof args.search_directory === 'string' ? { path: args.search_directory } : {}),
      };
    case 'grep_search_v2':
      return {
        ...(typeof args.pattern === 'string' ? { pattern: args.pattern } : {}),
        ...(typeof args.path === 'string' ? { path: args.path } : {}),
        ...(typeof args.glob === 'string' ? { glob: args.glob } : {}),
      };
    case 'write_to_file': {
      const filePath = fileUriToPath(args.filePath ?? args.file_path ?? args.path ?? args.target_file_uri ?? '');
      return {
        ...(filePath ? { filePath } : {}),
        ...(Array.isArray(args.code_content) ? { content: args.code_content.join('\n') } : typeof args.content === 'string' ? { content: args.content } : {}),
      };
    }
    case 'search_web':
      return typeof args.query === 'string' ? { query: args.query } : args;
    case 'read_url_content':
      return typeof args.url === 'string' ? { url: args.url } : args;
    default:
      return normalized ? { ...args } : args;
  }
}

export function uniqueWindsurfToolKinds(mapped: Array<{ kind: WindsurfCascadeToolStepKind }>): WindsurfCascadeToolStepKind[] {
  return Array.from(new Set(mapped.map((item) => item.kind)));
}

export function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const block = part as Record<string, unknown>;
      const type = typeof block.type === 'string' ? block.type.toLowerCase() : '';
      if (typeof block.text === 'string') return block.text;
      if (type === 'image' || type === 'image_url' || type === 'input_image') return '[Image omitted from text history]';
      return JSON.stringify(block);
    }).join('');
  }
  return content == null ? '' : JSON.stringify(content);
}

export function escapeHistoryTag(text: string, tag: string): string {
  return text.replaceAll(`</${tag}>`, `<\\/${tag}>`);
}

export function compactSystemPromptForCascade(sysText: string): string {
  if (!sysText) return sysText;
  let text = sysText.replace(/(^|[\n.!?]\s*)You are (?:Devin|Codex|OpenClaw|Aider|Cline)(?:[,.]|\s|$)/gi, '$1The assistant is a coding tool');
  text = text.replace(/\b(?:ignore|disregard) (?:all )?(?:previous|prior) (?:instructions|rules)\b/gi, 'follow the current task context');
  text = text.replace(/\b(?:bypass|override) (?:the |your )?(?:safety|content|policy|filter)\b/gi, 'request-parameter');
  return text.replace(/(^|[\n.!?]\s*)You are /g, '$1The assistant is ');
}

export function cascadeHistoryBudget(modelUid: string): number {
  const normalized = String(modelUid || '').toLowerCase();
  if (normalized.includes('gpt-5.5') || normalized.includes('gpt-5.4')) return 96_000;
  if (normalized.includes('gpt-5.3')) return 64_000;
  return 48_000;
}

export function extractLatestCascadeUserText(semanticConversation: WindsurfSemanticTurn[], tailParts: string[] = [], includeToolResults = true): string {
const normalizedTailParts = tailParts
.filter((part) => typeof part === 'string' && part.trim())
.map((part) => part.trim());
let latestUserText = '';
const terminalToolResults: string[] = [];
const bridgeToolResults: string[] = [];
for (let index = semanticConversation.length - 1; index >= 0; index -= 1) {
const turn = semanticConversation[index];
if (turn?.type === 'function_call_output' && typeof turn.output === 'string' && turn.output.trim()) {
const rendered = `Tool result for ${turn.name || turn.call_id}:\n${turn.output}`;
if (turn.source === 'bridge_tool_history') {
bridgeToolResults.unshift(rendered);
} else {
terminalToolResults.unshift(rendered);
}
continue;
}
if (turn?.type === 'assistant' && terminalToolResults.length > 0) {
continue;
}
if (turn?.type === 'user' && typeof turn.text === 'string' && turn.text.trim()) {
latestUserText = turn.text;
break;
}
if (terminalToolResults.length > 0) {
break;
}
}
const effectiveToolResults = includeToolResults ? (terminalToolResults.length > 0 ? terminalToolResults : bridgeToolResults) : [];
const baseParts = [...(latestUserText ? [latestUserText] : []), ...effectiveToolResults];
if (baseParts.length > 0) {
return [...baseParts, ...normalizedTailParts].join('\n\n');
}
if (normalizedTailParts.length > 0) {
return normalizedTailParts.join('\n\n');
}
throw createWindsurfProviderError('[windsurf] cascade semantic conversation missing terminal user text', {
code: 'WINDSURF_REQUEST_BUILD_FAILED',
status: 400,
retryable: false,
});
}

export function buildCascadeHistoryTurnText(turn: WindsurfSemanticTurn): string {
if (turn.type === 'assistant') {
const parts: string[] = [];
if (turn.text) parts.push(turn.text);
return parts.join('\n');
}
if (turn.type === 'function_call_output') {
return '';
}
return turn.text;
}

export function buildCascadePromptText(
messages: unknown,
semanticConversation: WindsurfSemanticTurn[],
modelUid: string,
mcpTools: Array<Record<string, unknown>> = [],
seedTailParts: string[] = [],
nativeTools: Array<Record<string, unknown>> = [],
toolChoice?: unknown,
resumeExistingCascade = false,
): string {
const rawMessages = Array.isArray(messages) ? messages.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : [];
const systemMsgs = rawMessages.filter((msg) => String(msg.role || '').trim().toLowerCase() === 'system');
const convo = semanticConversation.filter((turn) => turn.type === 'user' || turn.type === 'assistant' || turn.type === 'function_call_output');
let sysText = systemMsgs.map((msg) => contentToString(msg.content)).join('\n').trim();
if (sysText) sysText = compactSystemPromptForCascade(sysText);
void mcpTools;
const tailParts: string[] = Array.isArray(seedTailParts)
? seedTailParts.filter((part) => typeof part === 'string' && part.trim()).map((part) => part.trim())
: [];
const nativeToolAliasText = resumeExistingCascade ? '' : buildWindsurfNativeToolAliasText(nativeTools, toolChoice);
const prefixParts = [resumeExistingCascade ? '' : sysText, nativeToolAliasText].filter((part) => typeof part === 'string' && part.trim());

if (resumeExistingCascade || convo.length <= 1) {
const latest = rewriteWindsurfNativeToolAliasesInText(extractLatestCascadeUserText(semanticConversation, resumeExistingCascade ? [] : tailParts, !resumeExistingCascade), nativeTools);
return prefixParts.length > 0 ? `${prefixParts.join('\n\n')}\n\n${latest}` : latest;
}

const maxHistoryBytes = cascadeHistoryBudget(modelUid);
const lines: string[] = [];
let historyBytes = prefixParts.join('\n\n').length;
let firstIncluded = 0;
for (let index = convo.length - 2; index >= 0; index -= 1) {
const turn = convo[index]!;
const turnText = buildCascadeHistoryTurnText(turn);
if (!turnText.trim()) {
continue;
}
const tag = turn.type === 'user' ? 'human' : 'assistant';
const line = `<${tag}>\n${escapeHistoryTag(turnText, tag)}\n</${tag}>`;
if (historyBytes + line.length > maxHistoryBytes && lines.length > 0) {
firstIncluded = index + 1;
break;
}
lines.unshift(line);
historyBytes += line.length;
firstIncluded = index;
}
const latest = rewriteWindsurfNativeToolAliasesInText(extractLatestCascadeUserText(semanticConversation, tailParts), nativeTools);
let text = `The following is a multi-turn conversation. You MUST remember and use all information from prior turns.\n\n${lines.join('\n\n')}\n\n<human>\n${latest}\n</human>`;
if (firstIncluded > 0) {
text = `<truncation_note>The conversation above is truncated — ${firstIncluded} earlier turns were dropped due to length limits. The user's original task and the most recent tool results are preserved. Do NOT ask the user to repeat their task; continue from the latest context.</truncation_note>\n\n${text}`;
}
return prefixParts.length > 0 ? `${prefixParts.join('\n\n')}\n\n${text}` : text;
}

export function buildWindsurfNativeToolAliasText(nativeTools: Array<Record<string, unknown>> = [], toolChoice?: unknown): string {
const mapped = collectWindsurfMappedTools(nativeTools);
if (mapped.length === 0) return '';
const lines: string[] = [];
for (const tool of mapped) {
const standardName = String(tool.name || '').trim();
if (!standardName || standardName === tool.kind) continue;
lines.push(`- Client tool \`${standardName}\` is available in Cascade as native tool \`${tool.kind}\`.`);
}
if (lines.length === 0) return '';
const choiceName = extractWindsurfToolChoiceName(toolChoice);
const choice = choiceName ? mapped.find((tool) => windsurfToolLookupName(tool.name) === windsurfToolLookupName(choiceName)) : null;
return [
'Cascade native tool name mapping for this request:',
...lines,
...(choice ? [`The client explicitly selected \`${choice.name}\`; satisfy that by calling native tool \`${choice.kind}\`. Do not say \`${choice.name}\` is unavailable.`] : []),
].join('\n');
}

export function rewriteWindsurfNativeToolAliasesInText(text: string, nativeTools: Array<Record<string, unknown>> = []): string {
let out = String(text || '');
for (const tool of collectWindsurfMappedTools(nativeTools)) {
const standardName = String(tool.name || '').trim();
if (!standardName || standardName === tool.kind) continue;
const escaped = standardName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'g'), tool.kind);
}
return out;
}

export function extractWindsurfToolChoiceName(toolChoice: unknown): string {
if (!toolChoice || typeof toolChoice !== 'object' || Array.isArray(toolChoice)) return '';
const row = toolChoice as Record<string, unknown>;
if (typeof row.name === 'string') return row.name.trim();
const fn = row.function && typeof row.function === 'object' && !Array.isArray(row.function) ? row.function as Record<string, unknown> : null;
return typeof fn?.name === 'string' ? fn.name.trim() : '';
}

export function readDeltaSeedParts(body: Record<string, unknown>): string[] {
const parts: string[] = [];
const pushText = (value: unknown): void => {
if (typeof value === 'string' && value.trim()) parts.push(value.trim());
};
const scanInputItems = (items: unknown): void => {
if (!Array.isArray(items)) return;
for (const item of items) {
if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
const row = item as Record<string, unknown>;
const type = typeof row.type === 'string' ? row.type.trim().toLowerCase() : '';
if (type === 'input_text' || type === 'output_text' || type === 'text') {
pushText(row.text);
continue;
}
if (type === 'function_call_output' || type === 'tool_result' || type === 'custom_tool_call_output' || type === 'tool_message') {
const callId = typeof row.call_id === 'string' && row.call_id.trim()
? row.call_id.trim()
: typeof row.tool_call_id === 'string' && row.tool_call_id.trim()
? row.tool_call_id.trim()
: typeof row.id === 'string' && row.id.trim()
? row.id.trim()
: 'tool';
const output = typeof row.output === 'string'
? row.output
: typeof row.content === 'string'
? row.content
: row.output == null
? ''
: JSON.stringify(row.output);
if (output.trim()) parts.push(`Tool result for ${callId}:\n${output}`);
}
}
};
scanInputItems((body as Record<string, unknown>).input);
const semantics = body.semantics && typeof body.semantics === 'object' && !Array.isArray(body.semantics) ? body.semantics as Record<string, unknown> : {};
const responses = semantics.responses && typeof semantics.responses === 'object' && !Array.isArray(semantics.responses) ? semantics.responses as Record<string, unknown> : {};
const resume = responses.resume && typeof responses.resume === 'object' && !Array.isArray(responses.resume) ? responses.resume as Record<string, unknown> : {};
const context = responses.context && typeof responses.context === 'object' && !Array.isArray(responses.context) ? responses.context as Record<string, unknown> : {};
scanInputItems(resume.deltaInput);
scanInputItems(context.__captured_tool_results);
const toolHistory = context.toolHistory && typeof context.toolHistory === 'object' && !Array.isArray(context.toolHistory) ? context.toolHistory as Record<string, unknown> : {};
const pairs = Array.isArray(toolHistory.pairs) ? toolHistory.pairs : [];
for (const pair of pairs) {
if (!pair || typeof pair !== 'object' || Array.isArray(pair)) continue;
const row = pair as Record<string, unknown>;
const callId = typeof row.callId === 'string' && row.callId.trim() ? row.callId.trim() : 'tool';
const output = typeof row.output === 'string' ? row.output : row.output == null ? '' : JSON.stringify(row.output);
if (output.trim()) parts.push(`Tool result for ${callId}:\n${output}`);
}
return parts;
}

export function isWindsurfNativeToolName(name: string, nativeTools?: unknown): boolean {
const normalized = windsurfToolLookupName(name);
const mapped = WINDSURF_TOOL_MAP[normalized];
if (!normalized || !mapped) return false;
const declared = collectWindsurfMappedTools(Array.isArray(nativeTools) ? nativeTools as Array<Record<string, unknown>> : []);
if (declared.length === 0) return true;
return declared.some((tool) => tool.kind === mapped.kind);
}

export function readBridgeToolHistoryPairs(body: Record<string, unknown>): WindsurfBridgeToolHistoryPair[] {
const semantics = body.semantics && typeof body.semantics === 'object' && !Array.isArray(body.semantics) ? body.semantics as Record<string, unknown> : {};
const responses = semantics.responses && typeof semantics.responses === 'object' && !Array.isArray(semantics.responses) ? semantics.responses as Record<string, unknown> : {};
const context = responses.context && typeof responses.context === 'object' && !Array.isArray(responses.context) ? responses.context as Record<string, unknown> : {};
const toolHistory = context.toolHistory && typeof context.toolHistory === 'object' && !Array.isArray(context.toolHistory) ? context.toolHistory as Record<string, unknown> : {};
if (toolHistory.version !== 1 || !Array.isArray(toolHistory.pairs)) return [];
return toolHistory.pairs.map((entry) => {
const row = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
return {
callId: typeof row.callId === 'string' ? row.callId.trim() : '',
name: typeof row.name === 'string' ? row.name.trim() : '',
arguments: row.arguments,
output: typeof row.output === 'string' ? row.output : row.output == null ? '' : JSON.stringify(row.output),
status: typeof row.status === 'string' ? row.status.trim() : undefined,
};
}).filter((pair) => pair.callId && pair.name);
}

export function buildCompletedNativeToolCallIds(semanticConversation: WindsurfSemanticTurn[]): string[] {
const out = new Set<string>();
for (const turn of semanticConversation) {
if (turn.type !== 'function_call_output') continue;
const id = typeof turn.call_id === 'string' ? turn.call_id.trim() : '';
if (!id) continue;
out.add(id);
out.add(`fc_${id}`);
if (id.startsWith('fc_')) {
const stripped = id.slice(3);
if (stripped) out.add(stripped);
}
}
return Array.from(out);
}

export function appendBridgeToolHistoryToSemanticConversation(semanticConversation: WindsurfSemanticTurn[], pairs: WindsurfBridgeToolHistoryPair[]): void {
if (pairs.length === 0) return;
const existingToolCallIds = new Set<string>();
const existingToolResultIds = new Set<string>();
for (const turn of semanticConversation) {
if (turn.type === 'assistant' && Array.isArray(turn.tool_calls)) {
for (const call of turn.tool_calls) existingToolCallIds.add(call.call_id);
}
if (turn.type === 'function_call_output') existingToolResultIds.add(turn.call_id);
}
for (const pair of pairs) {
if (!existingToolCallIds.has(pair.callId)) {
semanticConversation.push({
type: 'assistant',
text: '',
tool_calls: [{
call_id: pair.callId,
name: pair.name,
arguments: pair.arguments && typeof pair.arguments === 'object' && !Array.isArray(pair.arguments) ? pair.arguments as Record<string, unknown> : {},
}],
});
existingToolCallIds.add(pair.callId);
}
if (!existingToolResultIds.has(pair.callId)) {
semanticConversation.push({ type: 'function_call_output', call_id: pair.callId, name: pair.name, output: pair.output, source: 'bridge_tool_history' });
existingToolResultIds.add(pair.callId);
}
}
}



export function buildCompletedNativeToolSignatures(semanticConversation: WindsurfSemanticTurn[], nativeTools?: Array<Record<string, unknown>>): string[] {
const out = new Set<string>();
const toolResultById = new Map<string, string>();
for (const turn of semanticConversation) {
if (turn.type === 'function_call_output') {
toolResultById.set(turn.call_id, turn.output);
}
}
for (const turn of semanticConversation) {
if (turn.type !== 'assistant' || !Array.isArray(turn.tool_calls)) continue;
for (const toolCall of turn.tool_calls) {
if (!toolResultById.has(toolCall.call_id)) continue;
if (!isWindsurfNativeToolName(toolCall.name, nativeTools)) continue;
const mapped = WINDSURF_TOOL_MAP[String(toolCall.name || '').toLowerCase()];
if (!mapped) continue;
const payload = mapped.forward(toolCall.arguments || {});
out.add(buildWindsurfNativeToolSignature(mapped.kind, payload));
}
}
return Array.from(out);
}



export function buildWindsurfNativeToolSignature(name: string, payload: Record<string, unknown>): string {
const stableStringify = (value: unknown): string => {
if (value === null || typeof value !== 'object') {
return JSON.stringify(value);
}
if (Array.isArray(value)) {
return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
}
const record = value as Record<string, unknown>;
const keys = Object.keys(record).sort();
return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
};
return `${String(name || '').trim().toLowerCase()}::${stableStringify(payload)}`;
}



export function selectCurrentCascadeToolResultWindow(semanticConversation: WindsurfSemanticTurn[]): WindsurfSemanticTurn[] {
const turns = Array.isArray(semanticConversation) ? semanticConversation : [];
if (turns.length === 0) return [];
const lastUserIndex = (() => {
for (let index = turns.length - 1; index >= 0; index -= 1) {
if (turns[index]?.type === 'user') return index;
}
return -1;
})();
if (lastUserIndex >= 0) {
let firstToolResultAfterLastUser = -1;
for (let index = lastUserIndex + 1; index < turns.length; index += 1) {
if (turns[index]?.type === 'function_call_output') {
firstToolResultAfterLastUser = index;
break;
}
}
if (firstToolResultAfterLastUser >= 0) {
for (let index = firstToolResultAfterLastUser - 1; index > lastUserIndex; index -= 1) {
if (turns[index]?.type === 'assistant') return turns.slice(index);
}
return turns.slice(firstToolResultAfterLastUser);
}
let index = lastUserIndex - 1;
if (turns[index]?.type !== 'function_call_output') return [];
const trailingResultIds = new Set<string>();
while (index >= 0 && turns[index]?.type === 'function_call_output') {
const result = turns[index] as Extract<WindsurfSemanticTurn, { type: 'function_call_output' }>;
if (result.call_id) trailingResultIds.add(result.call_id);
index -= 1;
}
if (trailingResultIds.size === 0) return [];
if (turns[index]?.type !== 'assistant') return turns.slice(index + 1, lastUserIndex);
const assistant = turns[index] as Extract<WindsurfSemanticTurn, { type: 'assistant' }>;
const assistantToolCalls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
const hasMatchingAssistantToolCall = assistantToolCalls.some((toolCall) => trailingResultIds.has(toolCall.call_id));
return hasMatchingAssistantToolCall ? turns.slice(index, lastUserIndex) : turns.slice(index + 1, lastUserIndex);
}
let firstTrailingToolResult = turns.length;
for (let index = turns.length - 1; index >= 0; index -= 1) {
if (turns[index]?.type !== 'function_call_output') break;
firstTrailingToolResult = index;
}
if (firstTrailingToolResult >= turns.length) return [];
for (let index = firstTrailingToolResult - 1; index >= 0; index -= 1) {
if (turns[index]?.type === 'assistant') return turns.slice(index);
if (turns[index]?.type === 'user') break;
}
return turns.slice(firstTrailingToolResult);
}

