import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import {
  parseJson,
  readNativeFunction,
  safeStringify
} from './native-shared-conversion-semantics-core.js';

function parseExtractToolCallsOutput(
  raw: string
): { cleanedText: string; toolCalls: Array<Record<string, unknown>> } | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  if (typeof row.cleanedText !== 'string' || !Array.isArray(row.toolCalls)) {
    return null;
  }
  const toolCalls = row.toolCalls.filter((entry) => entry && typeof entry === 'object') as Array<Record<string, unknown>>;
  return {
    cleanedText: row.cleanedText,
    toolCalls
  };
}

function parseExtractReasoningSegmentsOutput(
  raw: string
): { text: string; segments: string[] } | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  if (typeof row.text !== 'string' || !Array.isArray(row.segments)) {
    return null;
  }
  const segments = row.segments.filter((entry): entry is string => typeof entry === 'string');
  if (segments.length !== row.segments.length) {
    return null;
  }
  return { text: row.text, segments };
}

function parseNormalizeReasoningOutput(raw: string): { payload: unknown } | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  return { payload: row.payload };
}

type NormalizedToolCall = {
  id?: string;
  type: 'function';
  function: { name: string; arguments: string };
};

function normalizeToolCallEntries(raw: unknown[]): NormalizedToolCall[] {
  return raw
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => {
      const row = entry as Record<string, unknown>;
      const functionRow =
        row.function && typeof row.function === 'object' && !Array.isArray(row.function)
          ? (row.function as Record<string, unknown>)
          : null;
      const name = (
        typeof functionRow?.name === 'string'
          ? functionRow.name
          : typeof row.name === 'string'
            ? row.name
            : ''
      ).trim();
      const argsCandidate =
        typeof functionRow?.arguments === 'string'
          ? functionRow.arguments
          : typeof row.args === 'string'
            ? row.args
            : typeof row.arguments === 'string'
              ? row.arguments
              : '';
      if (!name) {
        return null;
      }
      return {
        ...(typeof row.id === 'string' && row.id ? { id: row.id } : {}),
        type: 'function' as const,
        function: {
          name,
          arguments: argsCandidate
        }
      };
    })
    .filter((entry): entry is NormalizedToolCall => Boolean(entry));
}

export function extractToolCallsFromReasoningTextWithNative(
  text: string,
  idPrefix?: string
): { cleanedText: string; toolCalls: Array<Record<string, unknown>> } {
  const capability = 'extractToolCallsFromReasoningTextJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ cleanedText: string; toolCalls: Array<Record<string, unknown>> }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(String(text ?? ''), idPrefix);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseExtractToolCallsOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function extractReasoningSegmentsWithNative(
  text: string
): { text: string; segments: string[] } {
  const capability = 'extractReasoningSegmentsJson';
  const fail = (reason?: string) => failNativeRequired<{ text: string; segments: string[] }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(String(text ?? ''));
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseExtractReasoningSegmentsOutput(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeAssistantTextToToolCallsWithNative(
  message: Record<string, unknown>,
  options?: Record<string, unknown>
): Record<string, unknown> {
  const capability = 'normalizeAssistantTextToToolCallsJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const baseMessage = message && typeof message === 'object' ? { ...message } : {};
  const payloadJson = safeStringify(baseMessage);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    let normalizedMessage = { ...baseMessage };
    let toolCallsSource: unknown[] = [];
    if (Array.isArray(parsed)) {
      toolCallsSource = parsed;
    } else if (parsed && typeof parsed === 'object') {
      const row = parsed as Record<string, unknown>;
      const messageNode =
        row.message && typeof row.message === 'object' && !Array.isArray(row.message)
          ? (row.message as Record<string, unknown>)
          : row;
      normalizedMessage = {
        ...normalizedMessage,
        ...messageNode
      };
      toolCallsSource = Array.isArray(messageNode.tool_calls)
        ? messageNode.tool_calls
        : [];
    } else {
      return fail('invalid payload');
    }
    const normalizedCalls = normalizeToolCallEntries(toolCallsSource);
    if (normalizedCalls.length > 0) {
      return {
        ...normalizedMessage,
        tool_calls: normalizedCalls
      };
    }
    return normalizedMessage;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeReasoningInChatPayloadWithNative(payload: unknown): unknown {
  const capability = 'normalizeReasoningInChatPayloadJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseNormalizeReasoningOutput(raw);
    return parsed ? parsed.payload : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeReasoningInResponsesPayloadWithNative(payload: unknown, options?: Record<string, unknown>): unknown {
  const capability = 'normalizeReasoningInResponsesPayloadJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ payload: payload ?? null, options: options ?? {} });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseNormalizeReasoningOutput(raw);
    return parsed ? parsed.payload : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeReasoningInGeminiPayloadWithNative(payload: unknown): unknown {
  const capability = 'normalizeReasoningInGeminiPayloadJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseNormalizeReasoningOutput(raw);
    return parsed ? parsed.payload : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeReasoningInAnthropicPayloadWithNative(payload: unknown): unknown {
  const capability = 'normalizeReasoningInAnthropicPayloadJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseNormalizeReasoningOutput(raw);
    return parsed ? parsed.payload : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeReasoningInOpenAIPayloadWithNative(payload: unknown): unknown {
  const capability = 'normalizeReasoningInOpenaiPayloadJson';
  const fail = (reason?: string) => failNativeRequired<unknown>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(payload ?? null);
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseNormalizeReasoningOutput(raw);
    return parsed ? parsed.payload : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function sanitizeReasoningTaggedTextWithNative(text: string): string {
  const capability = 'sanitizeReasoningTaggedTextJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  try {
    const raw = fn(String(text ?? ''));
    if (typeof raw !== 'string') {
      return fail('invalid payload');
    }
    return raw;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
