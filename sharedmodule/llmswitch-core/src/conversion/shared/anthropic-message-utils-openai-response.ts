import { parseLenientJsonishWithNative } from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';
import {
  isObject,
  normalizeAnthropicToolName,
  normalizeShellLikeToolInput,
  requireTrimmedString,
  sanitizeToolUseId
} from './anthropic-message-utils-core.js';

type Unknown = Record<string, unknown>;
type UnknownArray = Unknown[];

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
    | { content?: Array<{ text: string }>; summary?: Array<{ text: string }>; encrypted_content?: string | null }
    | undefined;
  const extensionContent = Array.isArray(extensionReasoning?.content)
    ? extensionReasoning?.content?.map((entry) => String(entry.text ?? '')).filter((text) => text.trim().length > 0)
    : [];
  const extensionSummary = Array.isArray(extensionReasoning?.summary)
    ? extensionReasoning?.summary?.map((entry) => String(entry.text ?? '')).filter((text) => text.trim().length > 0)
    : [];
  const extensionEncrypted =
    typeof extensionReasoning?.encrypted_content === 'string' && extensionReasoning.encrypted_content.trim().length
      ? extensionReasoning.encrypted_content.trim()
      : undefined;
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
  if (extensionEncrypted) {
    blocks.push({ type: 'redacted_thinking', data: extensionEncrypted });
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
    const map = coerceAnthropicAliasRecord(candidate);
    if (map) {
      return map;
    }
  }
  return undefined;
}

export function coerceAnthropicAliasRecord(candidate: unknown): Record<string, string> | undefined {
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

export function normalizeAnthropicToolChoice(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (isPlainRecord(value)) {
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
      return { type: 'any' };
    }
    return { type: trimmed };
  }

  return undefined;
}
