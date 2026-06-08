import {
  failNativeRequired,
  isNativeDisabledByEnv
} from './native-router-hotpath-policy.js';
import {
  parseJson,
  parseRecord,
  readNativeFunction,
  safeStringify
} from './native-shared-conversion-semantics-core.js';

export function normalizeIdValueWithNative(value: unknown, forceGenerate = false): string {
  const capability = 'normalizeIdValueJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ value, forceGenerate });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return typeof parsed === 'string' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function extractToolCallIdWithNative(obj: unknown): string | undefined {
  const capability = 'extractToolCallIdJson';
  const fail = (reason?: string) => failNativeRequired<string | undefined>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ obj: obj ?? null });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function createToolCallIdTransformerWithNative(style: string): Record<string, unknown> {
  const capability = 'createToolCallIdTransformerJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ style });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function transformToolCallIdWithNative(state: Record<string, unknown>, id: string): { id: string; state: Record<string, unknown> } {
  const capability = 'transformToolCallIdJson';
  const fail = (reason?: string) => failNativeRequired<{ id: string; state: Record<string, unknown> }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ state, id });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || typeof parsed.id !== 'string' || !parsed.state || typeof parsed.state !== 'object') {
      return fail('invalid payload');
    }
    return parsed as { id: string; state: Record<string, unknown> };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function enforceToolCallIdStyleWithNative(messages: unknown[], state: Record<string, unknown>): { messages: unknown[]; state: Record<string, unknown> } {
  const capability = 'enforceToolCallIdStyleJson';
  const fail = (reason?: string) => failNativeRequired<{ messages: unknown[]; state: Record<string, unknown> }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({ messages: Array.isArray(messages) ? messages : [], state });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || !Array.isArray(parsed.messages) || !parsed.state || typeof parsed.state !== 'object') {
      return fail('invalid payload');
    }
    return parsed as { messages: unknown[]; state: Record<string, unknown> };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function normalizeResponsesToolCallIdsWithNative(payload: unknown): Record<string, unknown> | null {
  const capability = 'normalizeResponsesToolCallIdsJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | null>(capability, reason);
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
    return parseRecord(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resolveToolCallIdStyleWithNative(metadata: unknown): string {
  const capability = 'resolveToolCallIdStyleJson';
  const fail = (reason?: string) => failNativeRequired<string>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata ?? null);
  if (!metadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return typeof parsed === 'string' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function stripInternalToolingMetadataWithNative(metadata: unknown): Record<string, unknown> | null {
  const capability = 'stripInternalToolingMetadataJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown> | null>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const metadataJson = safeStringify(metadata ?? null);
  if (!metadataJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(metadataJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseRecord(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function buildProviderProtocolErrorWithNative(input: {
  message: string;
  code: string;
  protocol?: string;
  providerType?: string;
  category?: string;
  details?: Record<string, unknown>;
}): Record<string, unknown> {
  const capability = 'buildProviderProtocolErrorJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify({
    message: input.message,
    code: input.code,
    protocol: input.protocol,
    providerType: input.providerType,
    category: input.category,
    details: input.details
  });
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    return parsed ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function isImagePathWithNative(pathValue: unknown): boolean {
  const capability = 'isImagePathJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const pathJson = safeStringify(pathValue ?? null);
  if (!pathJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(pathJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseJson(raw);
    return typeof parsed === 'boolean' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function extractStreamingToolCallsWithNative(input: {
  buffer: string;
  text: string;
  idPrefix: string;
  idCounter: number;
  nowMs: number;
}): { buffer: string; idCounter: number; toolCalls: Array<Record<string, unknown>> } {
  const capability = 'extractStreamingToolCallsJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ buffer: string; idCounter: number; toolCalls: Array<Record<string, unknown>> }>(
      capability,
      reason
    );
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(input ?? {});
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed) {
      return fail('invalid payload');
    }
    const buffer = typeof parsed.buffer === 'string' ? parsed.buffer : '';
    const idCounter = typeof parsed.idCounter === 'number' ? parsed.idCounter : input.idCounter;
    const toolCalls = Array.isArray(parsed.toolCalls)
      ? (parsed.toolCalls as Array<unknown>).filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
          .map((entry) => entry as Record<string, unknown>)
      : [];
    return { buffer, idCounter, toolCalls };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function createStreamingToolExtractorStateWithNative(idPrefix?: string): Record<string, unknown> {
  const capability = 'createStreamingToolExtractorStateJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(idPrefix ? { idPrefix } : {});
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseRecord(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function resetStreamingToolExtractorStateWithNative(state: Record<string, unknown>): Record<string, unknown> {
  const capability = 'resetStreamingToolExtractorStateJson';
  const fail = (reason?: string) => failNativeRequired<Record<string, unknown>>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(state ?? {});
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    return parseRecord(raw) ?? fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function feedStreamingToolExtractorWithNative(input: {
  state: Record<string, unknown>;
  text: string;
  nowMs?: number;
}): { state: Record<string, unknown>; toolCalls: Array<Record<string, unknown>> } {
  const capability = 'feedStreamingToolExtractorJson';
  const fail = (reason?: string) =>
    failNativeRequired<{ state: Record<string, unknown>; toolCalls: Array<Record<string, unknown>> }>(capability, reason);
  if (isNativeDisabledByEnv()) {
    return fail('native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return fail();
  }
  const payloadJson = safeStringify(input ?? {});
  if (!payloadJson) {
    return fail('json stringify failed');
  }
  try {
    const raw = fn(payloadJson);
    if (typeof raw !== 'string' || !raw) {
      return fail('empty result');
    }
    const parsed = parseRecord(raw);
    if (!parsed || !parsed.state || typeof parsed.state !== 'object' || Array.isArray(parsed.state)) {
      return fail('invalid payload');
    }
    const toolCalls = Array.isArray(parsed.toolCalls)
      ? (parsed.toolCalls as Array<unknown>).filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
          .map((entry) => entry as Record<string, unknown>)
      : [];
    return { state: parsed.state as Record<string, unknown>, toolCalls };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}

export function isCompactionRequestWithNative(payload: unknown): boolean {
  const capability = 'isCompactionRequestJson';
  const fail = (reason?: string) => failNativeRequired<boolean>(capability, reason);
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
    const parsed = parseJson(raw);
    return typeof parsed === 'boolean' ? parsed : fail('invalid payload');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error ?? 'unknown');
    return fail(reason);
  }
}
