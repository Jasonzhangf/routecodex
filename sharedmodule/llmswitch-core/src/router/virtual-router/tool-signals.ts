import type {
  StandardizedMessage,
  StandardizedRequest
} from '../../conversion/hub/types/standardized.js';

const WEB_TOOL_KEYWORDS = ['websearch', 'web_search', 'web-search', 'webfetch', 'web_fetch', 'web_request', 'search_web', 'internet_search'];
const READ_TOOL_EXACT = new Set([
  'read',
  'read_file',
  'read_text',
  'view_file',
  'view_code',
  'view_document',
  'open_file',
  'get_file',
  'download_file',
  'describe_current_request'
]);
const WRITE_TOOL_EXACT = new Set([
  'edit',
  'write',
  'multiedit',
  'apply_patch',
  'write_file',
  'create_file',
  'modify_file',
  'edit_file',
  'update_file',
  'save_file',
  'append_file',
  'replace_file'
]);
const SEARCH_TOOL_EXACT = new Set([
  'search_files',
  'find_files',
  'search_documents',
  'search_repo',
  'glob_search',
  'grep_files',
  'code_search',
  'lookup_symbol',
  'list_files',
  'list_directory',
  'list_dir'
]);
const READ_TOOL_KEYWORDS = ['read', 'view', 'download', 'open', 'show', 'fetch', 'inspect'];
const WRITE_TOOL_KEYWORDS = ['write', 'patch', 'modify', 'edit', 'create', 'update', 'append', 'replace', 'save'];
const SEARCH_TOOL_KEYWORDS = ['find', 'grep', 'glob', 'lookup', 'locate'];
const SHELL_TOOL_NAMES = new Set(['shell_command', 'shell', 'bash']);
const DECLARED_TOOL_IGNORE = new Set(['exec_command']);
const SHELL_HEREDOC_PATTERN = /<<\s*['"]?[a-z0-9_-]+/i;
const SHELL_WRITE_COMMANDS = new Set(['apply_patch', 'tee', 'touch', 'truncate', 'patch']);
const SHELL_READ_COMMANDS = new Set(['cat', 'head', 'tail', 'awk', 'strings', 'less', 'more', 'nl']);
const SHELL_SEARCH_COMMANDS = new Set([
  'rg',
  'ripgrep',
  'grep',
  'egrep',
  'fgrep',
  'ag',
  'ack',
  'find',
  'fd',
  'locate',
  'codesearch',
  'ls',
  'dir',
  'tree',
  'eza',
  'exa'
]);
const SHELL_REDIRECT_WRITE_BINARIES = new Set(['cat', 'printf', 'python', 'node', 'perl', 'ruby', 'php', 'bash', 'sh', 'zsh', 'echo']);
const SHELL_WRAPPER_COMMANDS = new Set(['sudo', 'env', 'time', 'nice', 'nohup', 'command', 'stdbuf']);
const COMMAND_ALIASES = new Map<string, string>([
  ['python3', 'python'],
  ['pip3', 'pip'],
  ['ripgrep', 'rg'],
  ['perl5', 'perl']
]);
const GIT_WRITE_SUBCOMMANDS = new Set(['add', 'commit', 'apply', 'am', 'rebase', 'checkout', 'merge']);
const GIT_SEARCH_SUBCOMMANDS = new Set(['grep', 'log', 'shortlog', 'reflog', 'blame']);
const BD_SEARCH_SUBCOMMANDS = new Set(['search']);
const PACKAGE_MANAGER_COMMANDS = new Map<string, Set<string>>([
  ['npm', new Set(['install'])],
  ['pnpm', new Set(['install'])],
  ['yarn', new Set(['add', 'install'])],
  ['pip', new Set(['install'])],
  ['pip3', new Set(['install'])],
  ['brew', new Set(['install'])],
  ['cargo', new Set(['add', 'install'])],
  ['go', new Set(['install'])],
  ['make', new Set(['install'])]
]);
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*/;
const OUTPUT_REDIRECT_PATTERN = /(?:^|[\s;|&])>>?\s*(?!&)[^\s]+/;

type ToolCandidate = {
  function?: {
    name?: string;
    description?: string;
  };
  name?: string;
  description?: string;
  [key: string]: unknown;
};

export type ToolCategory = 'read' | 'write' | 'search' | 'websearch' | 'other';
export type ToolClassification = { category: ToolCategory; name: string; commandSnippet?: string };

export function detectVisionTool(request: StandardizedRequest): boolean {
  if (!Array.isArray(request.tools)) {
    return false;
  }
  return request.tools.some((tool) => {
    const functionName = extractToolName(tool);
    const description = extractToolDescription(tool);
    return /vision|image|picture|photo/i.test(functionName) || /vision|image|picture|photo/i.test(description || '');
  });
}

export function detectCodingTool(request: StandardizedRequest): boolean {
  if (!Array.isArray(request.tools)) {
    return false;
  }
  return request.tools.some((tool) => {
    const functionName = extractToolName(tool).toLowerCase();
    const description = (extractToolDescription(tool) || '').toLowerCase();
    if (!functionName && !description) {
      return false;
    }
    if (WRITE_TOOL_EXACT.has(functionName)) {
      return true;
    }
    return WRITE_TOOL_KEYWORDS.some(
      (keyword) => functionName.includes(keyword.toLowerCase()) || description.includes(keyword.toLowerCase())
    );
  });
}

export function detectWebTool(request: StandardizedRequest): boolean {
  if (!Array.isArray(request.tools)) {
    return false;
  }
  return request.tools.some((tool) => {
    const functionName = extractToolName(tool);
    const description = extractToolDescription(tool);
    const normalizedName = functionName.toLowerCase();
    const normalizedDesc = (description || '').toLowerCase();
    return (
      WEB_TOOL_KEYWORDS.some((keyword) => normalizedName.includes(keyword)) ||
      WEB_TOOL_KEYWORDS.some((keyword) => normalizedDesc.includes(keyword))
    );
  });
}


/**
 * Detect if a web_search tool is explicitly declared in the request tools list.
 * This is used for routing decisions in the classifier.
 */
export function detectWebSearchToolDeclared(request: StandardizedRequest): boolean {
  if (!Array.isArray(request.tools)) {
    return false;
  }
  return request.tools.some((tool) => {
    const functionName = extractToolName(tool);
    const normalizedName = functionName.toLowerCase().replace(/[-_]/g, '');
    // Match exact web_search tool name (with or without underscore/dash)
    return normalizedName === 'websearch';
  });
}

export function extractMeaningfulDeclaredToolNames(tools: StandardizedRequest['tools'] | undefined): string[] {
  if (!Array.isArray(tools) || tools.length === 0) {
    return [];
  }
  const names: string[] = [];
  for (const tool of tools) {
    const rawName = extractToolName(tool);
    if (!rawName) {
      continue;
    }
    const canonical = canonicalizeToolName(rawName).toLowerCase();
    if (!canonical || DECLARED_TOOL_IGNORE.has(canonical)) {
      continue;
    }
    names.push(rawName);
  }
  return names;
}

const TOOL_CATEGORY_PRIORITY: Record<ToolCategory, number> = {
  websearch: 4,
  read: 3,
  write: 2,
  search: 1,
  other: 0
};

export function detectLastAssistantToolCategory(messages: StandardizedMessage[]): ToolClassification | undefined {
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const msg = messages[idx];
    if (!msg || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
      continue;
    }

    const candidates: ToolClassification[] = [];
    for (const call of msg.tool_calls) {
      const classification = classifyToolCall(call);
      if (classification) {
        candidates.push(classification);
      }
    }

    if (!candidates.length) {
      continue;
    }

    let best = candidates[0];
    let bestScore = TOOL_CATEGORY_PRIORITY[best.category] ?? 0;
    for (let i = 1; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const score = TOOL_CATEGORY_PRIORITY[candidate.category] ?? 0;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }
  return undefined;
}

export function classifyToolCallForReport(
  call: StandardizedMessage['tool_calls'][number]
): ToolClassification | undefined {
  return classifyToolCall(call);
}

function classifyToolCall(call: StandardizedMessage['tool_calls'][number]): ToolClassification | undefined {
  if (!call || typeof call !== 'object') {
    return undefined;
  }
  const functionName =
    typeof call?.function?.name === 'string' && call.function.name.trim()
      ? canonicalizeToolName(call.function.name)
      : '';
  if (!functionName) {
    return undefined;
  }

  const argsObject = parseToolArguments(call?.function?.arguments);
  const commandText = extractCommandText(argsObject);
  const snippet = buildCommandSnippet(commandText);
  const normalizedName = functionName.toLowerCase();
  const normalizedCmd = commandText.toLowerCase();

  // 1) Web search 优先：函数名命中 web 搜索关键字时，一律归类为 websearch，优先级最高。
  const isWebSearch = WEB_TOOL_KEYWORDS.some((keyword) => normalizedName.includes(keyword));

  // 2) 基于工具名的初步分类（read / write / search / other）
  const nameCategory = categorizeToolName(functionName);

  // 3) shell_command / exec_command 根据内部命令判断读写性质
  let shellCategory: ToolCategory = 'other';
  if (SHELL_TOOL_NAMES.has(functionName) || functionName === 'exec_command') {
    shellCategory = classifyShellCommand(commandText);
  }

  // 按优先级合并分类结果：
  //   1. web search
  //   2. 写文件（任一维度命中写）
  //   3. 读文件（任一维度命中读）
  //   4. 其他搜索（非 web search）
  //   5. 其它工具

  // Priority 1: Web search
  if (isWebSearch) {
    return { category: 'websearch', name: functionName, commandSnippet: snippet };
  }

  // Priority 2: Write (写文件) — 名称或内部命令任一判断为写，都按写处理
  if (nameCategory === 'write' || shellCategory === 'write') {
    return { category: 'write', name: functionName, commandSnippet: snippet };
  }

  // Priority 3: Read (读文件) — 仅在没有写的情况下，再看读
  if (nameCategory === 'read' || shellCategory === 'read') {
    return { category: 'read', name: functionName, commandSnippet: snippet };
  }

  // Priority 4: 其他 search 类工具（非 web search）
  if (nameCategory === 'search' || shellCategory === 'search') {
    return { category: 'search', name: functionName, commandSnippet: snippet };
  }

  // Priority 5: 兜底用命令文本再判断一次 shell 风格读写/搜索（非 shell/exec_command 的工具）
  if (!SHELL_TOOL_NAMES.has(functionName) && functionName !== 'exec_command' && commandText) {
    const derivedCategory = classifyShellCommand(commandText);
    if (derivedCategory === 'write' || derivedCategory === 'read' || derivedCategory === 'search') {
      return { category: derivedCategory, name: functionName, commandSnippet: snippet };
    }
  }

  // 最终兜底：other
  return { category: 'other', name: functionName, commandSnippet: snippet };
}

function extractToolName(tool: StandardizedRequest['tools'] extends Array<infer T> ? T : never): string {
  if (!tool || typeof tool !== 'object') {
    return '';
  }
  const candidate = tool as unknown as ToolCandidate;
  const fromFunction = candidate.function;
  if (fromFunction && typeof fromFunction.name === 'string' && fromFunction.name.trim()) {
    return fromFunction.name;
  }
  if (typeof candidate.name === 'string' && candidate.name.trim()) {
    return candidate.name;
  }
  return '';
}

function extractToolDescription(tool: StandardizedRequest['tools'] extends Array<infer T> ? T : never): string {
  if (!tool || typeof tool !== 'object') {
    return '';
  }
  const candidate = tool as unknown as ToolCandidate;
  const fromFunction = candidate.function;
  if (fromFunction && typeof fromFunction.description === 'string' && fromFunction.description.trim()) {
    return fromFunction.description;
  }
  if (typeof candidate.description === 'string' && candidate.description.trim()) {
    return candidate.description;
  }
  return '';
}

export function canonicalizeToolName(rawName: string): string {
  const trimmed = rawName.trim();
  const markerIndex = trimmed.indexOf('arg_');
  if (markerIndex > 0) {
    return trimmed.slice(0, markerIndex);
  }
  return trimmed;
}

function parseToolArguments(rawArguments: unknown): unknown {
  if (!rawArguments) {
    return undefined;
  }
  if (typeof rawArguments === 'string') {
    try {
      return JSON.parse(rawArguments);
    } catch {
      return rawArguments;
    }
  }
  if (typeof rawArguments === 'object') {
    return rawArguments;
  }
  return undefined;
}

function extractCommandText(args: unknown): string {
  if (!args) {
    return '';
  }
  if (typeof args === 'string') {
    return args;
  }
  if (Array.isArray(args)) {
    return args.map((item) => (typeof item === 'string' ? item : '')).filter(Boolean).join(' ');
  }
  if (typeof args === 'object') {
    const record = args as Record<string, unknown>;
    const stringKeys = ['command', 'cmd', 'input', 'code', 'script', 'text', 'prompt'];
    for (const key of stringKeys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
      if (Array.isArray(value)) {
        const joined = value.map((item) => (typeof item === 'string' ? item : '')).filter(Boolean).join(' ');
        if (joined.trim()) {
          return joined;
        }
      }
    }
    const nestedArgs = record.args;
    if (typeof nestedArgs === 'string' && nestedArgs.trim()) {
      return nestedArgs;
    }
    if (Array.isArray(nestedArgs)) {
      const joined = nestedArgs.map((item) => (typeof item === 'string' ? item : '')).filter(Boolean).join(' ');
      if (joined.trim()) {
        return joined;
      }
    }
  }
  return '';
}

function buildCommandSnippet(commandText: string): string | undefined {
  if (!commandText) {
    return undefined;
  }
  const collapsed = commandText.replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    return undefined;
  }
  const limit = 80;
  if (collapsed.length <= limit) {
    return collapsed;
  }
  return `${collapsed.slice(0, limit)}…`;
}

function categorizeToolName(name: string): ToolCategory {
  const normalized = name.toLowerCase();
  if (
    SEARCH_TOOL_EXACT.has(normalized) ||
    SEARCH_TOOL_KEYWORDS.some((keyword) => normalized.includes(keyword.toLowerCase())) ||
    isListToolName(normalized)
  ) {
    return 'search';
  }
  if (READ_TOOL_EXACT.has(normalized)) {
    return 'read';
  }
  if (WRITE_TOOL_EXACT.has(normalized)) {
    return 'write';
  }
  return 'other';
}

function isListToolName(normalized: string): boolean {
  if (!normalized) {
    return false;
  }
  if (normalized === 'list') {
    return true;
  }
  return normalized.startsWith('list_') || normalized.startsWith('list-');
}

function classifyShellCommand(command: string): ToolCategory {
  if (!command) {
    return 'other';
  }
  if (SHELL_HEREDOC_PATTERN.test(command)) {
    return 'write';
  }
  const segments = splitCommandSegments(command);
  let sawRead = false;
  let sawSearch = false;
  for (const segment of segments) {
    const normalized = normalizeShellSegment(segment);
    if (!normalized) {
      continue;
    }
    for (const args of normalized.commands) {
      if (!args.length) {
        continue;
      }
      const [binary, ...rest] = args;
      const normalizedBinary = normalizeBinaryName(binary);
      const alias = COMMAND_ALIASES.get(normalizedBinary) || normalizedBinary;
      if (isWriteBinary(alias, rest, normalized.raw)) {
        return 'write';
      }
      if (isReadBinary(alias, rest)) {
        sawRead = true;
        continue;
      }
      if (isSearchBinary(alias, rest)) {
        sawSearch = true;
      }
    }
  }
  if (sawRead) {
    return 'read';
  }
  if (sawSearch) {
    return 'search';
  }
  return 'other';
}

function normalizeShellSegment(segment: string): { raw: string; commands: string[][] } | undefined {
  const trimmed = stripShellWrapper(segment);
  if (!trimmed) {
    return undefined;
  }
  const tokens = splitShellTokens(trimmed);
  if (!tokens.length) {
    return undefined;
  }
  const commands: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (token === '|') {
      const cleaned = cleanCommandTokens(current);
      if (cleaned.length) {
        commands.push(cleaned);
      }
      current = [];
      continue;
    }
    current.push(token);
  }
  const cleaned = cleanCommandTokens(current);
  if (cleaned.length) {
    commands.push(cleaned);
  }
  if (!commands.length) {
    return undefined;
  }
  return { raw: trimmed, commands };
}

function splitShellTokens(cmd: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && i + 1 < cmd.length) {
        current += cmd[i + 1];
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch as '"' | "'";
      continue;
    }
    if (/[\s\t]/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    if (ch === '|') {
      if (current) {
        tokens.push(current);
        current = '';
      }
      tokens.push('|');
      continue;
    }
    if ((ch === '|' || ch === '&') && i + 1 < cmd.length && cmd[i + 1] === ch) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      tokens.push(cmd.slice(i, i + 2));
      i += 1;
      continue;
    }
    current += ch;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function cleanCommandTokens(tokens: string[]): string[] {
  if (!tokens.length) {
    return [];
  }
  const cleaned: string[] = [];
  for (const token of tokens) {
    if (!cleaned.length) {
      if (ENV_ASSIGNMENT_PATTERN.test(token)) {
        continue;
      }
      if (SHELL_WRAPPER_COMMANDS.has(token)) {
        continue;
      }
    }
    cleaned.push(token);
  }
  return cleaned;
}

function isWriteBinary(binary: string, args: string[], rawSegment: string): boolean {
  const normalized = binary.toLowerCase();
  if (SHELL_WRITE_COMMANDS.has(normalized)) {
    return true;
  }
  if (normalized === 'git' && args.length > 0) {
    const sub = args[0].toLowerCase();
    if (GIT_WRITE_SUBCOMMANDS.has(sub)) {
      return true;
    }
  }
  if (PACKAGE_MANAGER_COMMANDS.has(normalized)) {
    const allowed = PACKAGE_MANAGER_COMMANDS.get(normalized)!;
    if (args.length > 0 && allowed.has(args[0].toLowerCase())) {
      return true;
    }
  }
  if (normalized === 'sed') {
    const joined = args.join(' ').toLowerCase();
    if (joined.includes('-i')) {
      return true;
    }
  }
  if (normalized === 'perl') {
    const joined = args.join(' ').toLowerCase();
    if (joined.includes('-pi')) {
      return true;
    }
  }
  if (normalized === 'printf' && OUTPUT_REDIRECT_PATTERN.test(rawSegment)) {
    return true;
  }
  if (SHELL_REDIRECT_WRITE_BINARIES.has(normalized) && OUTPUT_REDIRECT_PATTERN.test(rawSegment)) {
    return true;
  }
  return false;
}

function isReadBinary(binary: string, args: string[]): boolean {
  const normalized = binary.toLowerCase();
  if (SHELL_READ_COMMANDS.has(normalized)) {
    return true;
  }
  if (normalized === 'sed') {
    const joined = args.join(' ').toLowerCase();
    if (joined.includes('-i')) {
      return false;
    }
    return true;
  }
  return false;
}

function isSearchBinary(binary: string, args: string[]): boolean {
  const normalized = binary.toLowerCase();
  if (SHELL_SEARCH_COMMANDS.has(normalized)) {
    return true;
  }
  if (normalized === 'git') {
    if (containsSubcommand(args, GIT_SEARCH_SUBCOMMANDS)) {
      return true;
    }
  }
  if (normalized === 'bd') {
    if (containsSubcommand(args, BD_SEARCH_SUBCOMMANDS)) {
      return true;
    }
  }
  return false;
}

function containsSubcommand(args: string[], candidates: Set<string>): boolean {
  if (!Array.isArray(args) || args.length === 0 || !candidates.size) {
    return false;
  }
  for (const raw of args) {
    if (typeof raw !== 'string') {
      continue;
    }
    const token = raw.trim().toLowerCase();
    if (!token || token.startsWith('-')) {
      continue;
    }
    if (candidates.has(token)) {
      return true;
    }
  }
  return false;
}

function splitCommandSegments(command: string): string[] {
  return command
    .split(/(?:\r?\n|&&|\|\||;)/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function normalizeBinaryName(binary: string): string {
  if (!binary) {
    return '';
  }
  const lowered = binary.toLowerCase();
  const slashIndex = lowered.lastIndexOf('/');
  if (slashIndex >= 0) {
    return lowered.slice(slashIndex + 1);
  }
  return lowered;
}

function stripShellWrapper(command: string): string {
  if (!command) {
    return '';
  }
  const wrappers = ['bash -lc', 'sh -c', 'zsh -c'];
  for (const wrapper of wrappers) {
    if (command.startsWith(wrapper)) {
      return command.slice(wrapper.length).trim();
    }
  }
  return command.trim();
}
