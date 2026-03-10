import { createBridgeActionState, runBridgeActionPipeline } from '../bridge-actions.js';
import { resolveBridgePolicy, resolvePolicyActions } from '../bridge-policies.js';
import { normalizeChatMessageContent } from './chat-output-normalizer.js';
import { mapBridgeToolsToChat, mapChatToolsToBridge } from './tool-mapping.js';
import type { BridgeToolDefinition } from '../types/bridge-message-types.js';
import type { ChatToolDefinition, MissingField } from '../hub/types/chat-envelope.js';
import { jsonClone, type JsonValue, type JsonObject } from '../hub/types/json.js';
import { ProviderProtocolError } from '../provider-protocol-error.js';
import { parseLenientJsonishWithNative } from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

type Unknown = Record<string, unknown>;
type UnknownArray = Unknown[];

interface OpenAIChatPayload extends Unknown {
  messages: UnknownArray;
}

function isObject(v: unknown): v is Unknown {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return '{}';
  }
}

function stripOpenAIChatToolAliasFields(messages: UnknownArray): void {
  // No-op: preserve tool_call_id/call_id for downstream consumers and regression parity.
  void messages;
}

function stripToolCallIdFieldsFromAssistant(messages: UnknownArray): void {
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = String((message as any).role || '').toLowerCase();
    if (role !== 'assistant') continue;
    const calls = (message as any).tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (!call || typeof call !== 'object') continue;
      delete (call as any).call_id;
      delete (call as any).tool_call_id;
    }
  }
}

function sanitizeToolUseId(raw: string): string {
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

function flattenAnthropicText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(flattenAnthropicText).join('');
  if (typeof content === 'object') {
    const t = String((content as any).type || '').toLowerCase();
    if (t === 'text' && typeof (content as any).text === 'string') return String((content as any).text);
    if (Array.isArray((content as any).content)) return (content as any).content.map(flattenAnthropicText).join('');
    if (typeof (content as any).content === 'string') return String((content as any).content);
  }
  return '';
}

function normalizeToolResultContent(block: unknown): string {
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

function resolveProtocolErrorCode(context: string): 'TOOL_PROTOCOL_ERROR' | 'MALFORMED_REQUEST' {
  const ctx = context.toLowerCase();
  return ctx.includes('tool') ? 'TOOL_PROTOCOL_ERROR' : 'MALFORMED_REQUEST';
}

function requireTrimmedString(value: unknown, context: string): string {
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

function requireSystemText(block: unknown, context: string): string {
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

const ANTHROPIC_TOOL_NAME_ALIASES = new Map<string, string>();

const CANONICAL_TO_ANTHROPIC_TOOL_NAMES = new Map<string, string>([['shell_command', 'Bash']]);
const ANTHROPIC_TOP_LEVEL_FIELDS = new Set<string>([
  'model',
  'messages',
  'tools',
  'system',
  'stop_sequences',
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'max_output_tokens',
  'metadata',
  'stream',
  'tool_choice',
  'thinking'
]);
const ANTHROPIC_STABLE_TOOL_SCHEMA_NAMES = new Set<string>([
  'exec_command',
  'write_stdin',
  'apply_patch',
  'request_user_input',
  'update_plan',
  'view_image',
  'web_search',
  'clock',
  'continue_execution',
  'review'
]);
const ANTHROPIC_STABLE_TOOL_SCHEMA_KEYS = new Map<string, Set<string>>([
  ['exec_command', new Set(['cmd', 'command', 'workdir', 'justification', 'login', 'max_output_tokens', 'sandbox_permissions', 'shell', 'yield_time_ms', 'tty', 'prefix_rule'])],
  ['write_stdin', new Set(['session_id', 'chars', 'text', 'yield_time_ms', 'max_output_tokens'])],
  ['apply_patch', new Set(['patch', 'input', 'instructions', 'text', 'file', 'changes'])],
  ['request_user_input', new Set(['questions'])],
  ['update_plan', new Set(['explanation', 'plan'])],
  ['view_image', new Set(['path'])],
  ['web_search', new Set(['query', 'q', 'domains', 'recency'])],
  ['clock', new Set(['action', 'items', 'taskId'])]
]);

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

function normalizeShellLikeToolInput(toolName: string, input: unknown): unknown {
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

function invertAnthropicAliasMap(source: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!source) {
    return undefined;
  }
  const inverted: Record<string, string> = {};
  for (const [canonical, raw] of Object.entries(source)) {
    if (typeof canonical !== 'string' || typeof raw !== 'string') {
      continue;
    }
    const trimmedCanonical = canonical.trim();
    const trimmedRaw = raw.trim();
    if (!trimmedCanonical.length) {
      continue;
    }
    if (trimmedRaw.length) {
      inverted[trimmedRaw.toLowerCase()] = trimmedCanonical;
    }
    if (!inverted[trimmedCanonical.toLowerCase()]) {
      inverted[trimmedCanonical.toLowerCase()] = trimmedCanonical;
    }
  }
  return Object.keys(inverted).length ? inverted : undefined;
}

export function buildOpenAIChatFromAnthropic(
  payload: unknown,
  options?: { includeToolCallIds?: boolean }
): OpenAIChatPayload {
  const newMessages: UnknownArray = [];
  const body = isObject(payload) ? payload : {};
  const canonicalAliasMap = coerceAliasRecord(buildAnthropicToolAliasMap((body as Record<string, unknown>).tools));
  const reverseAliasMap = invertAnthropicAliasMap(canonicalAliasMap);
  const resolveToolName = (candidate: unknown): string => {
    if (typeof candidate !== 'string') {
      return '';
    }
    const trimmed = candidate.trim();
    if (!trimmed.length) {
      return trimmed;
    }
    const normalized = normalizeAnthropicToolName(trimmed) ?? trimmed;
    if (reverseAliasMap) {
      const direct = reverseAliasMap[trimmed.toLowerCase()];
      if (typeof direct === 'string' && direct.trim().length) {
        return direct.trim();
      }
      const normalizedLookup = reverseAliasMap[normalized.toLowerCase()];
      if (typeof normalizedLookup === 'string' && normalizedLookup.trim().length) {
        return normalizedLookup.trim();
      }
    }
    return normalized;
  };
  const rawSystem = body.system;
  const systemBlocks: unknown[] = Array.isArray(rawSystem)
    ? rawSystem
    : rawSystem !== undefined && rawSystem !== null
      ? [rawSystem]
      : [];
  for (const block of systemBlocks) {
    const text = requireSystemText(block, 'system entry');
    newMessages.push({ role: 'system', content: text });
  }

  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const role = typeof m.role === 'string' ? String(m.role) : 'user';
    const content = (m as any).content;
    if (!Array.isArray(content)) {
      const text = flattenAnthropicText(content);
      if (text) {
        const normalized = normalizeChatMessageContent(text);
        const message: Unknown = {
          role,
          content: normalized.contentText ?? text
        };
        if (typeof normalized.reasoningText === 'string' && normalized.reasoningText.trim().length) {
          (message as any).reasoning_content = normalized.reasoningText.trim();
        }
        newMessages.push(message);
      }
      continue;
    }
    const textParts: string[] = [];
    const imageBlocks: UnknownArray = [];
    const toolCalls: UnknownArray = [];
    const reasoningParts: string[] = [];
    const toolResults: UnknownArray = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const t = String((block as any).type || '').toLowerCase();
      if (t === 'text' && typeof (block as any).text === 'string') {
        const s = (block as any).text.trim();
        if (s) textParts.push(s);
      } else if (t === 'thinking' || t === 'reasoning') {
        const thinkingText = flattenAnthropicText(block).trim();
        if (thinkingText) {
          reasoningParts.push(thinkingText);
        }
      } else if (t === 'image') {
        const source = (block as any).source;
        if (source && typeof source === 'object') {
          const s = source as Record<string, unknown>;
          const srcType = typeof s.type === 'string' ? s.type.toLowerCase() : '';
          let url: string | undefined;
          if (srcType === 'url' && typeof s.url === 'string') {
            url = s.url;
          } else if (srcType === 'base64' && typeof s.data === 'string') {
            const mediaType =
              typeof s.media_type === 'string' && s.media_type.trim().length
                ? s.media_type.trim()
                : 'image/png';
            url = `data:${mediaType};base64,${s.data}`;
          }
          if (url && url.trim().length) {
            imageBlocks.push({
              type: 'image_url',
              image_url: { url: url.trim() }
            });
          }
        }
      } else if (t === 'tool_use') {
        const name = requireTrimmedString((block as any).name, 'tool_use.name');
        const id = requireTrimmedString((block as any).id, 'tool_use.id');
        const input = (block as any).input ?? {};
        const args = safeJson(input);
        const canonicalName = resolveToolName(name) || name;
        const includeIds = options?.includeToolCallIds === true;
        toolCalls.push({
          id,
          ...(includeIds ? { call_id: id, tool_call_id: id } : {}),
          type: 'function',
          function: { name: canonicalName, arguments: args }
        });
      } else if (t === 'tool_result') {
        const callId = requireTrimmedString(
          (block as any).tool_call_id ??
            (block as any).call_id ??
            (block as any).tool_use_id ??
            (block as any).id,
          'tool_result.tool_use_id'
        );
        const contentStr = normalizeToolResultContent(block);
        toolResults.push({ role: 'tool', tool_call_id: callId, content: contentStr });
      }
    }
    const combinedText = textParts.join('\n');
    const normalized = normalizeChatMessageContent(combinedText);
    const hasRawText = typeof combinedText === 'string' && combinedText.trim().length > 0;
    const mergedReasoning: string[] = [...reasoningParts];
    if (typeof normalized.reasoningText === 'string' && normalized.reasoningText.trim().length) {
      mergedReasoning.push(normalized.reasoningText.trim());
    }
    const hasText = typeof normalized.contentText === 'string' && normalized.contentText.length > 0;
    const hasReasoning = mergedReasoning.length > 0;
    if (hasText || hasRawText || toolCalls.length > 0 || hasReasoning || imageBlocks.length > 0) {
      let contentNode: unknown = (hasText ? normalized.contentText : undefined) ?? combinedText ?? '';
      if (imageBlocks.length > 0) {
        const blocks: UnknownArray = [];
        const textPayload = (hasText ? normalized.contentText : undefined) ?? combinedText ?? '';
        if (typeof textPayload === 'string' && textPayload.trim().length) {
          blocks.push({ type: 'text', text: textPayload.trim() });
        }
        for (const img of imageBlocks) {
          blocks.push(jsonClone(img as JsonValue) as Unknown);
        }
        contentNode = blocks;
      }
      const msg: Unknown = {
        role,
        content: contentNode
      };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (hasReasoning) {
        (msg as any).reasoning_content = mergedReasoning.join('\n');
      }
      newMessages.push(msg);
    }
    for (const tr of toolResults) newMessages.push(tr);
  }
  const request: OpenAIChatPayload = { messages: newMessages };
  if (typeof body.model === 'string') request.model = body.model;
  if (typeof body.max_tokens === 'number') request.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') request.temperature = body.temperature;
  if (typeof body.top_p === 'number') request.top_p = body.top_p;
  if (typeof body.stream === 'boolean') request.stream = body.stream;
  if (typeof (body as any).id === 'string') {
    (request as Record<string, unknown>).request_id = (body as any).id;
  } else if (typeof (body as any).request_id === 'string') {
    (request as Record<string, unknown>).request_id = (body as any).request_id;
  }
  if ('tool_choice' in body) request.tool_choice = body.tool_choice;
  const normalizedTools = mapAnthropicToolsToChat(body.tools);
  if (normalizedTools !== undefined) {
    request.tools = normalizedTools;
  }
  try {
    const bridgePolicy = resolveBridgePolicy({ protocol: 'anthropic-messages' });
    const actions = resolvePolicyActions(bridgePolicy, 'request_inbound');
    if (actions?.length) {
      const actionState = createBridgeActionState({
        messages: newMessages,
        rawRequest: body
      });
      runBridgeActionPipeline({
        stage: 'request_inbound',
        actions,
        protocol: bridgePolicy?.protocol ?? 'anthropic-messages',
        moduleType: bridgePolicy?.moduleType ?? 'anthropic-messages',
        requestId: typeof body?.id === 'string' ? String(body.id) : undefined,
        state: actionState
      });
    }
  } catch {
    // ignore policy failures
  }
  stripToolCallIdFieldsFromAssistant(newMessages);
  stripOpenAIChatToolAliasFields(newMessages);
  return request;
}

export interface BuildAnthropicFromOpenAIOptions {
  toolNameMap?: Record<string, string>;
  requestId?: string;
}

export function buildAnthropicFromOpenAIChat(oa: unknown, options?: BuildAnthropicFromOpenAIOptions): Unknown {
  const mapFinishReason = (reason: string | null | undefined): string | undefined => {
    if (typeof reason !== 'string' || !reason.trim().length) {
      return undefined;
    }
    const mapping: Record<string, string> = {
      stop: 'end_turn',
      length: 'max_tokens',
      tool_calls: 'tool_use',
      content_filter: 'stop_sequence',
      function_call: 'tool_use'
    };
    return mapping[reason.trim()];
  };

  const body = isObject(oa) ? oa : {};
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const primary = choices[0] && typeof choices[0] === 'object' ? (choices[0] as Unknown) : {};
  const msg = isObject(primary.message) ? (primary.message as Unknown) : {};
  const role = typeof msg.role === 'string' ? msg.role : 'assistant';
  const blocks: UnknownArray = [];
  const content = (msg as Unknown)?.content;
  const contentArray = Array.isArray(content) ? content : undefined;
  if (typeof content === 'string') {
    blocks.push({ type: 'text', text: content });
  }
  if (contentArray) {
    const text = contentArray
      .map((p: unknown) =>
        p && typeof (p as Unknown).text === 'string'
          ? String((p as Unknown).text)
          : typeof p === 'string'
            ? p
            : ''
      )
      .filter(Boolean)
      .join('');
    if (text) {
      blocks.push({ type: 'text', text });
    }
  }
  const extensionReasoning = (body as any)?.__responses_reasoning as
    | { content?: Array<{ text: string }>; summary?: Array<{ text: string }> }
    | undefined;
  const extensionContent = Array.isArray(extensionReasoning?.content)
    ? extensionReasoning?.content?.map((entry) => String(entry.text ?? '')).filter((text) => text.trim().length > 0)
    : [];
  const extensionSummary = Array.isArray(extensionReasoning?.summary)
    ? extensionReasoning?.summary?.map((entry) => String(entry.text ?? '')).filter((text) => text.trim().length > 0)
    : [];
  const extensionText =
    extensionContent.length > 0
      ? extensionContent.join('\n')
      : (extensionSummary.length > 0 ? extensionSummary.join('\n') : undefined);
  const reasoningField =
    extensionText ??
    (typeof (msg as any)?.reasoning_content === 'string'
      ? (msg as any).reasoning_content
      : typeof (msg as any)?.reasoning === 'string'
        ? (msg as any).reasoning
        : undefined);
  if (reasoningField && reasoningField.trim().length) {
    blocks.push({ type: 'thinking', text: reasoningField.trim() });
  }
  const toolCalls = Array.isArray((msg as Unknown)?.tool_calls) ? ((msg as Unknown).tool_calls as unknown[]) : [];
  const toolNameResolver = createAnthropicToolNameResolver(
    options?.toolNameMap ?? extractToolNameMapFromPayload(oa)
  );
  for (const tc of toolCalls) {
    try {
      const id = sanitizeToolUseId(requireTrimmedString((tc as Unknown)?.id, 'chat.tool_call.id'));
      const fn = isObject((tc as Unknown)?.function) ? ((tc as Unknown).function as Unknown) : {};
      const canonicalName = requireTrimmedString(fn.name, 'chat.tool_call.function.name');
      const name = toolNameResolver ? toolNameResolver(canonicalName) : canonicalName;
      const argsRaw = fn.arguments;
      let input: unknown;
      if (typeof argsRaw === 'string') {
        const parsed = parseLenientJsonishWithNative(argsRaw);
        input = parsed && typeof parsed === 'object' ? parsed : { _raw: argsRaw };
      } else {
        input = argsRaw ?? {};
      }
      input = normalizeShellLikeToolInput(name, input);
      blocks.push({ type: 'tool_use', id, name, input });
    } catch {
      // ignore malformed tool call
    }
  }
  const usageChunk = isObject(body.usage) ? body.usage : {};
  const inputTokens = Number(usageChunk.prompt_tokens ?? usageChunk.input_tokens ?? 0);
  const outputTokens = Number(usageChunk.completion_tokens ?? usageChunk.output_tokens ?? 0);
  const finishReason =
    Array.isArray(body.choices) &&
    body.choices[0] &&
    typeof (body.choices[0] as Unknown)?.finish_reason === 'string'
      ? String((body.choices[0] as Unknown).finish_reason).trim()
      : undefined;
  const stopReasonCandidate =
    mapFinishReason(finishReason) ||
    mapFinishReason(typeof (primary as any)?.finish_reason === 'string' ? String((primary as any).finish_reason) : undefined) ||
    (typeof (body as any)?.stop_reason === 'string' ? String((body as any).stop_reason).trim() : undefined) ||
    (typeof (primary as any)?.stop_reason === 'string' ? String((primary as any).stop_reason).trim() : undefined);
  const hasToolCalls = toolCalls.length > 0;
  const stopReason = stopReasonCandidate ?? (hasToolCalls ? 'tool_use' : 'end_turn');
  const resolveResponseId = (): string => {
    const preferred = [
      (body as any)?.id,
      (body as any)?.response?.id,
      (body as any)?.response_id
    ];
    for (const candidateRaw of preferred) {
      if (typeof candidateRaw !== 'string') continue;
      const candidate = candidateRaw.trim();
      if (!candidate.length) continue;
      if (candidate.startsWith('resp_')) {
        return candidate;
      }
    }
    const fromRequest =
      typeof options?.requestId === 'string' && options.requestId.trim().startsWith('resp_')
        ? options.requestId.trim()
        : undefined;
    return fromRequest ?? `resp_${Date.now()}`;
  };
  const resolveCreated = (): number => {
    const candidateNumbers = [
      (body as any)?.created,
      (body as any)?.created_at,
      (body as any)?.response?.created,
      (body as any)?.response?.created_at
    ];
    for (const candidate of candidateNumbers) {
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        return Math.floor(candidate);
      }
    }
    return Math.floor(Date.now() / 1000);
  };
  return {
    id: resolveResponseId(),
    type: 'message',
    role,
    model: String(body.model || 'unknown'),
    created: resolveCreated(),
    content: blocks,
    usage: inputTokens || outputTokens ? { input_tokens: inputTokens, output_tokens: outputTokens } : undefined,
    stop_reason: stopReason
  } as Unknown;
}

function extractToolNameMapFromPayload(payload: unknown): Record<string, string> | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const candidateSources: unknown[] = [
    (payload as Record<string, unknown>).anthropicToolNameMap,
    (payload as Record<string, unknown>).__anthropicToolNameMap,
    (payload as Record<string, unknown>).metadata &&
    typeof (payload as Record<string, unknown>).metadata === 'object'
      ? ((payload as Record<string, unknown>).metadata as Record<string, unknown>).anthropicToolNameMap
      : undefined,
    (payload as Record<string, unknown>).metadata &&
    typeof (payload as Record<string, unknown>).metadata === 'object'
      ? ((payload as Record<string, unknown>).metadata as Record<string, unknown>).extraFields &&
        typeof ((payload as Record<string, unknown>).metadata as Record<string, unknown>).extraFields === 'object'
        ? (((payload as Record<string, unknown>).metadata as Record<string, unknown>).extraFields as Record<
            string,
            unknown
          >).anthropicToolNameMap
        : undefined
      : undefined,
    (payload as Record<string, unknown>).metadata &&
    typeof (payload as Record<string, unknown>).metadata === 'object' &&
    ((payload as Record<string, unknown>).metadata as Record<string, unknown>).capturedContext &&
    typeof ((payload as Record<string, unknown>).metadata as Record<string, unknown>).capturedContext === 'object'
      ? ((((payload as Record<string, unknown>).metadata as Record<string, unknown>).capturedContext as Record<
          string,
          unknown
        >).__hub_capture &&
          typeof (
            ((payload as Record<string, unknown>).metadata as Record<string, unknown>).capturedContext as Record<
              string,
              unknown
            >
          ).__hub_capture === 'object'
        ? ((((payload as Record<string, unknown>).metadata as Record<string, unknown>).capturedContext as Record<
            string,
            unknown
          >).__hub_capture as Record<string, unknown>).extraFields &&
          typeof (
            (((payload as Record<string, unknown>).metadata as Record<string, unknown>).capturedContext as Record<
              string,
              unknown
            >).__hub_capture as Record<string, unknown>
          ).extraFields === 'object'
          ? ((((payload as Record<string, unknown>).metadata as Record<string, unknown>).capturedContext as Record<
              string,
              unknown
            >).__hub_capture as Record<string, unknown>).extraFields as Record<string, unknown>
          : undefined
        : undefined)
      : undefined
  ];
  for (const candidate of candidateSources) {
    const map = coerceAliasRecord(candidate);
    if (map) {
      return map;
    }
  }
  return undefined;
}

function coerceAliasRecord(candidate: unknown): Record<string, string> | undefined {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return undefined;
  }
  let hasEntry = false;
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      continue;
    }
    const trimmedKey = key.trim();
    if (!trimmedKey.length) {
      continue;
    }
    output[trimmedKey] = value;
    hasEntry = true;
  }
  return hasEntry ? output : undefined;
}

function createAnthropicToolNameResolver(source?: Record<string, string>): ((name: string) => string) | undefined {
  if (!source) {
    return undefined;
  }
  const lookup = new Map<string, string>();
  for (const [key, value] of Object.entries(source)) {
    if (typeof key !== 'string' || typeof value !== 'string') continue;
    const canonical = key.trim();
    if (!canonical.length) continue;
    const alias = value.trim() || canonical;
    lookup.set(canonical, alias);
    const lower = canonical.toLowerCase();
    if (!lookup.has(lower)) {
      lookup.set(lower, alias);
    }
  }
  if (!lookup.size) {
    return undefined;
  }
  return (name: string): string => {
    const trimmed = name.trim();
    if (!trimmed.length) {
      return name;
    }
    const direct = lookup.get(trimmed) ?? lookup.get(trimmed.toLowerCase());
    if (direct) {
      return direct;
    }
    const normalized = normalizeAnthropicToolName(trimmed);
    if (normalized) {
      return lookup.get(normalized) ?? lookup.get(normalized.toLowerCase()) ?? trimmed;
    }
    return trimmed;
  };
}

function normalizeAnthropicToolChoice(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (isPlainRecord(value)) {
    // Already an object – best-effort clone while trimming type, and also support
    // Chat-style { type: 'function', function: { name } } by mapping to Anthropic's
    // { type: 'tool', name } shape.
    const cloned = cloneAnthropicSchema(value);
    const rawType = typeof (cloned as any).type === 'string' ? String((cloned as any).type).trim() : '';
    if (rawType) {
      (cloned as any).type = rawType;
      return cloned;
    }
    const selectorType = typeof (cloned as any).type === 'string' ? String((cloned as any).type).trim() : '';
    const fn = (cloned as any).function;
    if (
      selectorType === 'function' &&
      fn &&
      typeof fn === 'object' &&
      typeof (fn as any).name === 'string' &&
      String((fn as any).name).trim().length
    ) {
      return { type: 'tool', name: String((fn as any).name).trim() };
    }
    return cloned;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.length) {
      return undefined;
    }
    const lower = trimmed.toLowerCase();
    if (lower === 'auto') {
      return { type: 'auto' };
    }
    if (lower === 'none') {
      return { type: 'none' };
    }
    if (lower === 'any') {
      return { type: 'any' };
    }
    if (lower === 'required') {
      // "required" in canonical Chat roughly maps to Anthropic's "any" semantics:
      // the model must choose some tool if available.
      return { type: 'any' };
    }
    // Fallback: preserve custom mode as-is in type field.
    return { type: trimmed };
  }

  return undefined;
}

export function buildAnthropicRequestFromOpenAIChat(chatReq: unknown): Unknown {
  const requestBody: Unknown = isObject(chatReq) ? chatReq : {};
  const model = String(requestBody?.model || 'unknown');
  const messages: UnknownArray = [];

  try {
    const bridgePolicy = resolveBridgePolicy({ protocol: 'anthropic-messages' });
    const actions = resolvePolicyActions(bridgePolicy, 'request_outbound');
    if (actions?.length && Array.isArray((requestBody as Unknown).messages)) {
      const actionState = createBridgeActionState({
        messages: (requestBody as Unknown).messages as UnknownArray,
        rawRequest: requestBody
      });
      runBridgeActionPipeline({
        stage: 'request_outbound',
        actions,
        protocol: bridgePolicy?.protocol ?? 'anthropic-messages',
        moduleType: bridgePolicy?.moduleType ?? 'anthropic-messages',
        state: actionState
      });
    }
  } catch {
    // ignore policy errors
  }

  const collectText = (val: unknown): string => {
    if (!val) return '';
    if (typeof val === 'string') return val;
    if (Array.isArray(val)) return val.map(collectText).join('');
    if (typeof val === 'object') {
      if (typeof (val as any).text === 'string') return String((val as any).text);
      if (Array.isArray((val as any).content)) return collectText((val as any).content);
    }
    return '';
  };

  const msgs = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  const mirrorShapes = extractMirrorShapesFromRequest(requestBody);
  let mirrorIndex = 0;
  const knownToolCallIds = new Set<string>();
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const role = String((m as any).role || 'user');
    if (role !== 'assistant') continue;
    const toolCalls = (m as any).tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== 'object') continue;
      const id = sanitizeToolUseId(requireTrimmedString((tc as any).id, 'chat.tool_call.id'));
      knownToolCallIds.add(id);
    }
  }

  const systemBlocks: Array<{ type: 'text'; text: string }> = [];
  const pushSystemBlock = (text: string) => {
    const trimmed = text.trim();
    if (trimmed) systemBlocks.push({ type: 'text', text: trimmed });
  };
  try {
    const sys = requestBody.system;
    const ingestSystem = (val: unknown): void => {
      if (!val) return;
      if (typeof val === 'string') {
        pushSystemBlock(requireSystemText(val, 'top-level system'));
        return;
      }
      if (Array.isArray(val)) {
        for (const entry of val) ingestSystem(entry);
        return;
      }
      if (typeof val === 'object') {
        pushSystemBlock(requireSystemText(val, 'top-level system'));
        return;
      }
      throw new ProviderProtocolError(
        'Anthropic bridge constraint violated: unsupported system payload type',
        {
          code: 'MALFORMED_REQUEST',
          protocol: 'anthropic-messages',
          providerType: 'anthropic',
          details: { context: 'top-level system', actualType: typeof val }
        }
      );
    };
    ingestSystem(sys);
  } catch {
    // ignore system pre-scan errors
  }
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const role = String((m as any).role || 'user');
    let targetShape: string | undefined;
    if (role !== 'system' && Array.isArray(mirrorShapes)) {
      targetShape = mirrorShapes[mirrorIndex];
      mirrorIndex += 1;
    }
    const contentNode = (m as any).content;
    const text = collectText(contentNode).trim();

    if (role === 'system') {
      if (!text) {
        throw new ProviderProtocolError(
          'Anthropic bridge constraint violated: Chat system message must contain text',
          {
            code: 'MALFORMED_REQUEST',
            protocol: 'anthropic-messages',
            providerType: 'anthropic',
            details: { context: 'chat.system', original: contentNode }
          }
        );
      }
      pushSystemBlock(text);
      continue;
    }

    if (role === 'tool') {
      const toolCallId = sanitizeToolUseId(
        requireTrimmedString(
          (m as any).tool_call_id ?? (m as any).call_id ?? (m as any).tool_use_id ?? (m as any).id,
          'tool_result.tool_call_id'
        )
      );
      if (!knownToolCallIds.has(toolCallId)) {
        throw new ProviderProtocolError(
          `Anthropic bridge constraint violated: tool result ${toolCallId} has no matching tool call`,
          {
            code: 'TOOL_PROTOCOL_ERROR',
            protocol: 'anthropic-messages',
            providerType: 'anthropic',
            details: { toolCallId }
          }
        );
      }
      const block: any = {
        type: 'tool_result',
        content: text
      };
      block.tool_use_id = toolCallId;
      messages.push({
        role: 'user',
        content: [block]
      });
      continue;
    }

    const blocks: any[] = [];
    if (Array.isArray(contentNode)) {
      // Preserve or synthesize image blocks where possible, and fall back to text for the rest.
      for (const entry of contentNode) {
        if (!entry || typeof entry !== 'object') continue;
        const node = entry as Record<string, unknown>;
        const t = typeof node.type === 'string' ? node.type.toLowerCase() : '';
        if (t === 'image' && node.source && typeof node.source === 'object') {
          // Pass-through Anthropic image block as-is.
          blocks.push({
            type: 'image',
            source: jsonClone(node.source as JsonValue)
          });
          continue;
        }
        if (t === 'image_url') {
          let url = '';
          const imageUrl = node.image_url as unknown;
          if (typeof imageUrl === 'string') {
            url = imageUrl;
          } else if (imageUrl && typeof imageUrl === 'object' && typeof (imageUrl as Record<string, unknown>).url === 'string') {
            url = (imageUrl as Record<string, unknown>).url as string;
          }
          const trimmed = url.trim();
          if (!trimmed.length) continue;
          const source: Record<string, unknown> = {};
          if (trimmed.startsWith('data:')) {
            const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(trimmed);
            if (match) {
              const mediaType = (match[1] || '').trim() || 'image/png';
              source.type = 'base64';
              source.media_type = mediaType;
              source.data = match[2] || '';
            } else {
              source.type = 'url';
              source.url = trimmed;
            }
          } else {
            source.type = 'url';
            source.url = trimmed;
          }
          blocks.push({
            type: 'image',
            source
          });
        }
      }
    }
    if (text) {
      blocks.push({ type: 'text', text });
    }

    const toolCalls = Array.isArray((m as any).tool_calls) ? (m as any).tool_calls : [];
    for (const tc of toolCalls) {
      if (!tc || typeof tc !== 'object') continue;
      const id = sanitizeToolUseId(requireTrimmedString((tc as any).id, 'chat.tool_call.id'));
      const fn = (tc as any).function || {};
      const name = requireTrimmedString((fn as any).name, 'chat.tool_call.function.name');
      const argsRaw = (fn as any).arguments;
      let input: any;
      if (typeof argsRaw === 'string') {
        const parsed = parseLenientJsonishWithNative(argsRaw);
        input = parsed && typeof parsed === 'object' ? parsed : { _raw: argsRaw };
      } else {
        input = argsRaw ?? {};
      }
      input = normalizeShellLikeToolInput(name, input);
      blocks.push({ type: 'tool_use', id, name, input });
    }

    if (blocks.length > 0) {
      const hasStructuredBlocks = blocks.some((block) => block && typeof block === 'object' && (block as any).type !== 'text');
      let contentNode: unknown = blocks;
      if (!hasStructuredBlocks && (targetShape === 'string' || !targetShape)) {
        contentNode = text;
      }
      messages.push({ role, content: contentNode });
    }
  }

  const out: any = { model };
  if (systemBlocks.length) {
    out.system = systemBlocks;
  }
  out.messages = messages;
  const anthropicTools = mapChatToolsToAnthropicTools((requestBody as Unknown).tools);
  if (anthropicTools !== undefined) {
    out.tools = anthropicTools;
  }

  const normalizedToolChoice = normalizeAnthropicToolChoice((requestBody as any).tool_choice);
  if (normalizedToolChoice !== undefined) {
    out.tool_choice = normalizedToolChoice;
  }

  if ((requestBody as any).thinking !== undefined) {
    try {
      out.thinking = JSON.parse(JSON.stringify((requestBody as any).thinking));
    } catch {
      out.thinking = (requestBody as any).thinking;
    }
  }

  try {
    if (requestBody.metadata && typeof requestBody.metadata === 'object') {
      out.metadata = JSON.parse(JSON.stringify(requestBody.metadata));
    }
  } catch {
    // best-effort metadata clone
  }

  const mt = Number(
    (requestBody as { max_tokens?: unknown; maxTokens?: unknown }).max_tokens ??
      (requestBody as { max_tokens?: unknown; maxTokens?: unknown }).maxTokens ??
      NaN
  );
  if (Number.isFinite(mt) && mt > 0) out.max_tokens = mt;
  if (typeof (requestBody as { temperature?: unknown }).temperature === 'number') {
    out.temperature = Number((requestBody as { temperature?: number }).temperature);
  }
  if (typeof (requestBody as { top_p?: unknown }).top_p === 'number') {
    out.top_p = Number((requestBody as { top_p?: number }).top_p);
  }
  if (typeof (requestBody as { stream?: unknown }).stream === 'boolean') {
    out.stream = Boolean((requestBody as { stream?: boolean }).stream);
  }
  const stop = (requestBody as { stop?: unknown }).stop;
  if (typeof stop === 'string' && stop.trim()) {
    out.stop_sequences = [stop.trim()];
  } else if (Array.isArray(stop) && stop.length > 0) {
    out.stop_sequences = stop.map((s: any) => String(s)).filter(Boolean);
  }

  return pruneAnthropicRequest(out);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function coerceJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value as JsonValue;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => coerceJsonValue(entry)) as JsonValue;
  }
  if (isPlainRecord(value)) {
    const obj: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      obj[key] = coerceJsonValue(entry);
    }
    return obj;
  }
  return String(value ?? '') as JsonValue;
}

function cloneAnthropicSchema(value: unknown): Record<string, unknown> {
  if (isPlainRecord(value)) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return value as Record<string, unknown>;
    }
  }
  return { type: 'object', properties: {} } as Record<string, unknown>;
}

function normalizeAnthropicSchemaType(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    if (
      trimmed === 'string' ||
      trimmed === 'number' ||
      trimmed === 'integer' ||
      trimmed === 'boolean' ||
      trimmed === 'object' ||
      trimmed === 'array'
    ) {
      return trimmed;
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const normalized = normalizeAnthropicSchemaType(entry);
      if (normalized) {
        return normalized;
      }
    }
  }
  return undefined;
}

function compactAnthropicPropertySchema(schema: unknown): Record<string, unknown> {
  if (!isPlainRecord(schema)) {
    return { type: 'string' };
  }
  const out: Record<string, unknown> = {};
  const type = normalizeAnthropicSchemaType(schema.type);
  if (type) {
    out.type = type;
  }
  if (typeof schema.description === 'string' && schema.description.trim()) {
    out.description = schema.description;
  }
  const enumRaw = Array.isArray(schema.enum) ? schema.enum : undefined;
  if (enumRaw && enumRaw.length) {
    const enumValues = enumRaw
      .filter((entry) => {
        const entryType = typeof entry;
        return entryType === 'string' || entryType === 'number' || entryType === 'boolean';
      })
      .slice(0, 64);
    if (enumValues.length) {
      out.enum = enumValues;
      if (!out.type) {
        const inferred = typeof enumValues[0];
        out.type = inferred === 'boolean' ? 'boolean' : inferred === 'number' ? 'number' : 'string';
      }
    }
  }
  if (out.type === 'array') {
    const items = isPlainRecord(schema.items) ? schema.items : {};
    const itemType = normalizeAnthropicSchemaType(items.type) ?? 'string';
    out.items = { type: itemType };
  } else if (out.type === 'object') {
    out.properties = {};
    out.additionalProperties = false;
  }
  if (!out.type) {
    out.type = 'string';
  }
  return out;
}

function sanitizeAnthropicBuiltinInputSchema(toolName: string, schemaSource: unknown): Record<string, unknown> {
  const normalizedName = toolName.trim().toLowerCase();
  if (!ANTHROPIC_STABLE_TOOL_SCHEMA_NAMES.has(normalizedName)) {
    return cloneAnthropicSchema(schemaSource);
  }

  const source = cloneAnthropicSchema(schemaSource);
  const sourceProperties = isPlainRecord(source.properties) ? (source.properties as Record<string, unknown>) : {};
  const allowedKeys = ANTHROPIC_STABLE_TOOL_SCHEMA_KEYS.get(normalizedName);
  const sanitizedProperties: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(sourceProperties)) {
    if (allowedKeys && !allowedKeys.has(key)) {
      continue;
    }
    sanitizedProperties[key] = compactAnthropicPropertySchema(value);
  }

  const required = Array.isArray(source.required)
    ? source.required.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
  const filteredRequired = allowedKeys
    ? required.filter((key) => allowedKeys.has(key))
    : required;

  for (const key of filteredRequired) {
    if (!Object.prototype.hasOwnProperty.call(sanitizedProperties, key)) {
      sanitizedProperties[key] = { type: 'string' };
    }
  }

  const output: Record<string, unknown> = {
    type: 'object',
    properties: sanitizedProperties,
    additionalProperties: false
  };
  if (filteredRequired.length) {
    output.required = Array.from(new Set(filteredRequired));
  }
  return output;
}

function prepareAnthropicBridgeTools(rawTools: JsonValue | undefined, missing?: MissingField[]): BridgeToolDefinition[] | undefined {
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    return undefined;
  }
  const result: BridgeToolDefinition[] = [];
  rawTools.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      missing?.push({
        path: `tools[${index}]`,
        reason: 'invalid_entry',
        originalValue: jsonClone(coerceJsonValue(entry))
      });
      return;
    }
    const name = typeof (entry as Record<string, unknown>).name === 'string'
      ? ((entry as Record<string, unknown>).name as string)
      : undefined;
    if (!name) {
      missing?.push({ path: `tools[${index}].name`, reason: 'missing_name' });
      return;
    }
    const description = typeof (entry as Record<string, unknown>).description === 'string'
      ? ((entry as Record<string, unknown>).description as string)
      : undefined;
    const schemaSource = (entry as Record<string, unknown>).input_schema;
    const parameters = cloneAnthropicSchema(schemaSource);
    result.push({
      type: 'function',
      function: {
        name,
        description,
        parameters
      }
    });
  });
  return result.length ? result : undefined;
}

function convertBridgeToolToAnthropic(def: BridgeToolDefinition): Record<string, unknown> | null {
  if (!def || typeof def !== 'object') {
    return null;
  }
  const fnNode = def.function && typeof def.function === 'object' ? def.function : undefined;
  const name = typeof fnNode?.name === 'string'
    ? fnNode.name
    : typeof def.name === 'string'
      ? def.name
      : undefined;
  if (!name) {
    return null;
  }
  const description = typeof fnNode?.description === 'string'
    ? fnNode.description
    : typeof def.description === 'string'
      ? def.description
      : undefined;
  const schemaSource = fnNode?.parameters ?? (def as Record<string, unknown>).parameters;
  const inputSchema = sanitizeAnthropicBuiltinInputSchema(name, schemaSource);
  const tool: Record<string, unknown> = {
    name,
    input_schema: inputSchema
  };
  if (description !== undefined) {
    tool.description = description;
  }
  return tool;
}

export function mapAnthropicToolsToChat(rawTools: unknown, missing?: MissingField[]): ChatToolDefinition[] | undefined {
  const prepared = prepareAnthropicBridgeTools(rawTools as JsonValue | undefined, missing);
  if (prepared === undefined) {
    return undefined;
  }
  return mapBridgeToolsToChat(prepared, { sanitizeName: normalizeAnthropicToolName });
}

export function mapChatToolsToAnthropicTools(rawTools: unknown): UnknownArray | undefined {
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    return undefined;
  }
  const bridgeDefs = mapChatToolsToBridge(rawTools, { sanitizeName: denormalizeAnthropicToolName });
  if (!bridgeDefs || !bridgeDefs.length) {
    return undefined;
  }
  const converted = bridgeDefs
    .map((def) => convertBridgeToolToAnthropic(def))
    .filter((entry): entry is Record<string, unknown> => !!entry);
  return converted.length ? converted : undefined;
}

function pruneAnthropicRequest(payload: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(payload)) {
    if (!ANTHROPIC_TOP_LEVEL_FIELDS.has(key)) {
      delete payload[key];
    }
  }
  return payload;
}

function extractMirrorShapesFromRequest(source: Unknown): string[] | undefined {
  const directMirror =
    source &&
    typeof source === 'object' &&
    (source as Record<string, unknown>).__anthropicMirror &&
    typeof (source as Record<string, unknown>).__anthropicMirror === 'object'
      ? ((source as Record<string, unknown>).__anthropicMirror as Record<string, unknown>)
      : extractMirrorFromMetadata(source);
  if (!directMirror) {
    return undefined;
  }
  const shapes = directMirror.messageContentShape;
  if (!Array.isArray(shapes)) {
    return undefined;
  }
  return shapes.map((entry) => (typeof entry === 'string' ? entry : String(entry ?? '')));
}

function extractMirrorFromMetadata(source: Unknown): Record<string, unknown> | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }
  const metadata = (source as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== 'object') {
    return undefined;
  }
  const extraFields = (metadata as Record<string, unknown>).extraFields;
  if (!extraFields || typeof extraFields !== 'object') {
    return undefined;
  }
  const mirror = (extraFields as Record<string, unknown>).anthropicMirror;
  return mirror && typeof mirror === 'object' ? (mirror as Record<string, unknown>) : undefined;
}

export function buildAnthropicToolAliasMap(rawTools: unknown): JsonObject | undefined {
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    return undefined;
  }
  const aliasMap = new Map<string, string>();
  for (const entry of rawTools) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const rawName = typeof (entry as Record<string, unknown>).name === 'string'
      ? ((entry as Record<string, unknown>).name as string).trim()
      : undefined;
    if (!rawName) {
      continue;
    }
    const normalized = normalizeAnthropicToolName(rawName) ?? rawName;
    const canonicalKey = normalized.trim();
    if (!canonicalKey.length) {
      continue;
    }
    aliasMap.set(canonicalKey, rawName);
    const lowered = canonicalKey.toLowerCase();
    const lowerKey = canonicalKey.toLowerCase();
    if (lowerKey !== canonicalKey && !aliasMap.has(lowerKey)) {
      aliasMap.set(lowerKey, rawName);
    }
  }
  if (!aliasMap.size) {
    return undefined;
  }
  const serialized: JsonObject = {};
  for (const [key, value] of aliasMap.entries()) {
    serialized[key] = value;
  }
  return serialized;
}
