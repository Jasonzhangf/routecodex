import type { UnknownObject } from '../../../types/common-types.js';

export type DeepSeekCompletionBody = {
  chat_session_id: string;
  parent_message_id: string | null;
  prompt: string;
  ref_file_ids: unknown[];
  thinking_enabled: boolean;
  search_enabled: boolean;
  stream?: boolean;
};

export type DeepSeekProviderError = Error & {
  code?: string;
  statusCode?: number;
  status?: number;
  details?: Record<string, unknown>;
};

export type CamoufoxFingerprintSnapshot = {
  userAgent?: string;
  platform?: string;
  oscpu?: string;
};

export function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeMessageContentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }
  if (content === null || content === undefined) {
    return '';
  }
  if (!Array.isArray(content)) {
    return stringifyUnknown(content).trim();
  }

  const parts: string[] = [];
  for (const item of content) {
    if (!isRecord(item)) {
      continue;
    }
    const type = normalizeString(item.type)?.toLowerCase();
    const text = normalizeString(item.text);
    if (
      text &&
      (type === 'text' || type === 'input_text' || type === 'output_text' || type === 'text_delta')
    ) {
      parts.push(text);
      continue;
    }
    if (text) {
      parts.push(text);
      continue;
    }
    const contentText = normalizeString(item.content);
    if (contentText) {
      parts.push(contentText);
      continue;
    }
    if (type === 'tool_use') {
      const toolName = normalizeString(item.name) || 'tool_call';
      const toolInput = item.input ?? {};
      parts.push(stringifyUnknown({ tool_calls: [{ name: toolName, input: toolInput }] }));
      continue;
    }
    if (type === 'tool_result' && item.content !== undefined) {
      parts.push(stringifyUnknown(item.content));
      continue;
    }
  }
  return parts.join('\n').trim();
}

function normalizeToolCallsAsText(toolCallsRaw: unknown): string {
  if (!Array.isArray(toolCallsRaw) || toolCallsRaw.length === 0) {
    return '';
  }
  const toolCalls = toolCallsRaw
    .filter((item) => isRecord(item))
    .map((item) => {
      const fn = isRecord(item.function) ? item.function : item;
      const name = normalizeString(fn.name);
      if (!name) {
        return null;
      }
      const argsRaw = fn.arguments;
      let input: unknown = {};
      if (typeof argsRaw === 'string') {
        const trimmed = argsRaw.trim();
        if (trimmed) {
          try {
            input = JSON.parse(trimmed);
          } catch {
            input = { _raw: trimmed };
          }
        }
      } else if (argsRaw !== undefined) {
        input = argsRaw;
      }
      return { name, input };
    })
    .filter((item): item is { name: string; input: unknown } => Boolean(item));

  if (!toolCalls.length) {
    return '';
  }
  return stringifyUnknown({ tool_calls: toolCalls });
}

export function buildPromptFromMessages(messagesRaw: unknown): string | undefined {
  if (!Array.isArray(messagesRaw) || messagesRaw.length === 0) {
    return undefined;
  }
  const messages: Array<{ role: string; text: string }> = [];

  for (const item of messagesRaw) {
    if (!isRecord(item)) {
      continue;
    }
    const role = normalizeString(item.role)?.toLowerCase();
    if (!role) {
      continue;
    }
    const contentText = normalizeMessageContentToText(item.content);
    const toolCallsText = normalizeToolCallsAsText(item.tool_calls);
    const reasoning =
      normalizeString(item.reasoning_content) || normalizeString(item.reasoning) || '';
    const text = [contentText, toolCallsText, reasoning].filter(Boolean).join('\n').trim();
    if (!text) {
      continue;
    }
    messages.push({ role, text });
  }

  if (!messages.length) {
    return undefined;
  }

  const merged = [{ ...messages[0] }];
  for (const item of messages.slice(1)) {
    const last = merged[merged.length - 1];
    if (last.role === item.role) {
      last.text = [last.text, item.text].filter(Boolean).join('\n\n');
      continue;
    }
    merged.push({ ...item });
  }

  const parts: string[] = [];
  merged.forEach((block, index) => {
    if (block.role === 'assistant') {
      parts.push(`<｜Assistant｜>${block.text}<｜end▁of▁sentence｜>`);
      return;
    }
    if (block.role === 'user' || block.role === 'system' || block.role === 'tool') {
      if (index > 0) {
        parts.push(`<｜User｜>${block.text}`);
      } else {
        parts.push(block.text);
      }
      return;
    }
    parts.push(block.text);
  });

  const prompt = parts
    .join('')
    .replace(/!\[(.*?)\]\((.*?)\)/g, '[$1]($2)')
    .trim();
  return prompt || undefined;
}

export function createProviderError(
  code: string,
  message: string,
  statusCode: number,
  details?: Record<string, unknown>
): DeepSeekProviderError {
  const error = new Error(message) as DeepSeekProviderError;
  error.code = code;
  error.statusCode = statusCode;
  error.status = statusCode;
  if (details) {
    error.details = details;
  }
  return error;
}

function readBooleanLike(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return fallback;
    }
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
      return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
      return false;
    }
  }
  return fallback;
}

export function readEnvBoolean(keys: string[], fallback: boolean): boolean {
  for (const key of keys) {
    const raw = process.env[key];
    if (typeof raw === 'string' && raw.trim()) {
      return readBooleanLike(raw, fallback);
    }
  }
  return fallback;
}

export function parseCamoufoxConfig(payload: unknown): CamoufoxFingerprintSnapshot | null {
  if (!isRecord(payload)) {
    return null;
  }
  const envNode = payload.env;
  if (!isRecord(envNode)) {
    return null;
  }
  const rawConfig = normalizeString(envNode.CAMOU_CONFIG_1);
  if (!rawConfig) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  return {
    userAgent: normalizeString(parsed['navigator.userAgent']),
    platform: normalizeString(parsed['navigator.platform']),
    oscpu: normalizeString(parsed['navigator.oscpu'])
  };
}

export function mapPlatformToClientPlatform(platform?: string): string | undefined {
  const normalized = normalizeString(platform)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes('win')) {
    return 'windows';
  }
  if (normalized.includes('mac')) {
    return 'macos';
  }
  if (normalized.includes('linux') || normalized.includes('x11')) {
    return 'linux';
  }
  return undefined;
}

export function readStreamIntent(request: UnknownObject): boolean {
  const direct = isRecord(request) ? request : {};
  const dataNode = isRecord(direct.data) ? direct.data : undefined;
  const metadataNode = isRecord(direct.metadata)
    ? direct.metadata
    : dataNode && isRecord(dataNode.metadata)
      ? dataNode.metadata
      : undefined;

  if (direct.stream === true || dataNode?.stream === true) {
    return true;
  }
  if (metadataNode?.stream === true) {
    return true;
  }
  return false;
}

export function shouldForceUpstreamSseForSearch(request: UnknownObject): boolean {
  const direct = isRecord(request) ? request : {};
  const dataNode = isRecord(direct.data) ? direct.data : undefined;

  if (direct.search_enabled === true || dataNode?.search_enabled === true) {
    return true;
  }

  const modelRaw =
    normalizeString(direct.model) ||
    normalizeString(dataNode?.model) ||
    normalizeString((isRecord(direct.metadata) ? direct.metadata.model : undefined));
  if (!modelRaw) {
    return false;
  }

  const model = modelRaw.toLowerCase();
  return (
    model.includes('deepseek-chat-search') ||
    model.includes('deepseek-v3-search') ||
    model.includes('deepseek-reasoner-search') ||
    model.includes('deepseek-r1-search')
  );
}

export function extractPromptFromPayload(body: Record<string, unknown>, request: UnknownObject): string | undefined {
  const direct = normalizeString(body.prompt);
  if (direct) {
    return direct;
  }
  const messagePrompt = buildPromptFromMessages(body.messages);
  if (messagePrompt) {
    return messagePrompt;
  }
  const dataNode = isRecord(request) && isRecord(request.data) ? request.data : undefined;
  const nestedPrompt = normalizeString(dataNode?.prompt);
  if (nestedPrompt) {
    return nestedPrompt;
  }
  return buildPromptFromMessages(dataNode?.messages);
}

export function extractSessionIdFromMetadata(request: UnknownObject): string | undefined {
  const metadata = isRecord(request) && isRecord(request.metadata)
    ? request.metadata
    : isRecord(request) && isRecord(request.data) && isRecord(request.data.metadata)
      ? request.data.metadata
      : undefined;
  return normalizeString(metadata?.sessionId) || normalizeString(metadata?.conversationId);
}
