import { ProviderProtocolError } from '../provider-protocol-error.js';

type Unknown = Record<string, unknown>;

const ANTHROPIC_TOOL_NAME_ALIASES = new Map<string, string>([
  ['bash', 'shell_command'],
  ['shell', 'shell_command'],
  ['terminal', 'shell_command'],
]);
const CANONICAL_TO_ANTHROPIC_TOOL_NAMES = new Map<string, string>([['shell_command', 'Bash']]);

export function isObject(v: unknown): v is Unknown {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return '{}';
  }
}

export function sanitizeToolUseId(raw: string): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    return `call_${Math.random().toString(36).slice(2, 10)}`;
  }
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return trimmed;
  }
  const sanitized = trimmed
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '');
  return sanitized || `call_${Math.random().toString(36).slice(2, 10)}`;
}

export function flattenAnthropicText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(flattenAnthropicText).join('');
  if (typeof content === 'object') {
    const t = String((content as any).type || '').toLowerCase();
    if ((t === 'text' || t === 'thinking' || t === 'reasoning') && typeof (content as any).text === 'string') {
      return String((content as any).text);
    }
    if (Array.isArray((content as any).content)) return (content as any).content.map(flattenAnthropicText).join('');
    if (typeof (content as any).content === 'string') return String((content as any).content);
  }
  return '';
}

function extractToolResultSegment(entry: unknown): string {
  if (entry == null) {
    return '';
  }
  if (typeof entry === 'string') {
    return entry;
  }
  if (Array.isArray(entry)) {
    return entry.map(extractToolResultSegment).filter(Boolean).join('');
  }
  if (typeof entry === 'object') {
    const node = entry as Record<string, unknown>;
    const type = typeof node.type === 'string' ? (node.type as string).toLowerCase() : '';
    if (type === 'input_text' || type === 'input_json' || type === 'tool_result_status' || type === 'status' || type === 'metadata') {
      return '';
    }
    if (type === 'output_text' || type === 'text' || type === 'reasoning' || type === 'log') {
      return flattenAnthropicText(entry);
    }
    if (type === 'output_json' || type === 'json') {
      const payload = node.content ?? node.text ?? node.data ?? node.output;
      if (payload === undefined) {
        return '';
      }
      try {
        return JSON.stringify(payload);
      } catch {
        return String(payload ?? '');
      }
    }
    if (typeof node.text === 'string') {
      return node.text as string;
    }
    if ('content' in node) {
      const nested = extractToolResultSegment(node.content);
      if (nested) {
        return nested;
      }
    }
    try {
      return JSON.stringify(entry);
    } catch {
      return '';
    }
  }
  return String(entry);
}

export function normalizeToolResultContent(block: unknown): string {
  if (!block || typeof block !== 'object') {
    return '';
  }
  const content = (block as Record<string, unknown>).content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const segments: string[] = [];
    for (const entry of content) {
      const segment = extractToolResultSegment(entry);
      if (segment) {
        segments.push(segment);
      }
    }
    if (segments.length) {
      return segments.join('\n');
    }
  } else if (content != null) {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  return '';
}

function resolveProtocolErrorCode(context: string): 'TOOL_PROTOCOL_ERROR' | 'MALFORMED_REQUEST' {
  const ctx = context.toLowerCase();
  return ctx.includes('tool') ? 'TOOL_PROTOCOL_ERROR' : 'MALFORMED_REQUEST';
}

export function requireTrimmedString(value: unknown, context: string): string {
  if (typeof value !== 'string') {
    throw new ProviderProtocolError(
      `Anthropic bridge constraint violated: ${context} must be a string`,
      {
        code: resolveProtocolErrorCode(context),
        protocol: 'anthropic-messages',
        providerType: 'anthropic',
        details: { context, actualType: typeof value }
      }
    );
  }
  const trimmed = value.trim();
  if (!trimmed.length) {
    throw new ProviderProtocolError(
      `Anthropic bridge constraint violated: ${context} must not be empty`,
      {
        code: resolveProtocolErrorCode(context),
        protocol: 'anthropic-messages',
        providerType: 'anthropic',
        details: { context }
      }
    );
  }
  return trimmed;
}

export function requireSystemText(block: unknown, context: string): string {
  const text = flattenAnthropicText(block).trim();
  if (!text) {
    throw new ProviderProtocolError(
      `Anthropic bridge constraint violated: ${context} must contain text`,
      {
        code: resolveProtocolErrorCode(context),
        protocol: 'anthropic-messages',
        providerType: 'anthropic',
        details: { context }
      }
    );
  }
  return text;
}

export function normalizeAnthropicToolName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  const alias = ANTHROPIC_TOOL_NAME_ALIASES.get(lower);
  if (alias) {
    return alias;
  }
  if (lower.startsWith('mcp__')) {
    return lower;
  }
  return lower;
}

export function denormalizeAnthropicToolName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  const mapped = CANONICAL_TO_ANTHROPIC_TOOL_NAMES.get(lower);
  if (mapped) {
    return mapped;
  }
  if (lower.startsWith('mcp__')) {
    return trimmed;
  }
  return trimmed;
}

function coerceShellLikeCommand(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0);
    if (!parts.length) {
      return undefined;
    }
    return parts.join(' ');
  }
  return undefined;
}

export function normalizeShellLikeToolInput(toolName: string, input: unknown): unknown {
  const canonical = normalizeAnthropicToolName(toolName);
  if (canonical !== 'shell_command') {
    return input;
  }
  const rawToolName = typeof toolName === 'string' ? toolName.trim().toLowerCase() : '';
  const isExecCommand = rawToolName === 'exec_command';
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    const cmd = coerceShellLikeCommand(input);
    if (!cmd) {
      return {};
    }
    return isExecCommand ? { cmd } : { command: cmd };
  }
  const next = { ...(input as Record<string, unknown>) };
  const commandValue = coerceShellLikeCommand(next.command);
  const cmdValue = coerceShellLikeCommand(next.cmd);
  const fallbackValue =
    coerceShellLikeCommand(next.script) ??
    coerceShellLikeCommand(next.toon);

  if (commandValue) {
    next.command = commandValue;
  }
  if (cmdValue) {
    next.cmd = cmdValue;
  }

  if (!commandValue && !cmdValue && fallbackValue) {
    if (isExecCommand) {
      next.cmd = fallbackValue;
    } else {
      next.command = fallbackValue;
    }
  } else if (!commandValue && cmdValue && !isExecCommand) {
    next.command = cmdValue;
  } else if (!cmdValue && commandValue && isExecCommand) {
    next.cmd = commandValue;
  }
  if (!isExecCommand && 'cmd' in next) {
    delete next.cmd;
  }
  if (typeof next.workdir !== 'string' && typeof next.cwd === 'string' && next.cwd.trim().length > 0) {
    next.workdir = next.cwd.trim();
  }
  return next;
}
