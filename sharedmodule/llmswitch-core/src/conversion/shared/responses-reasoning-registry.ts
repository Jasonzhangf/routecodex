// Registry thin wrappers — delegates to Rust NAPI.
// All state is managed in Rust; TS only validates inputs and serializes JSON.

export interface ResponsesOutputTextMeta {
  hasField: boolean;
  value?: string;
  raw?: string;
}

export interface ResponsesReasoningPayload {
  summary?: Array<{ type: 'summary_text'; text: string }>;
  content?: Array<{ type: 'reasoning_text' | 'text'; text: string }>;
  encrypted_content?: string | null;
}

import {
  extractNativeErrorMessage,
  failNative,
  isNativeDisabledByEnv,
  readNativeFunction,
  safeStringify
} from '../../native/router-hotpath/native-hub-pipeline-resp-semantics-shared.js';

function callNativeRequired(capability: string, ...args: unknown[]): unknown {
  if (isNativeDisabledByEnv()) {
    return failNative<unknown>(capability, 'native disabled');
  }
  const fn = readNativeFunction(capability);
  if (!fn) {
    return failNative<unknown>(capability);
  }
  try {
    return fn(...args);
  } catch (error) {
    return failNative<unknown>(capability, extractNativeErrorMessage(error));
  }
}

function stringifyRegistryPayload(capability: string, value: unknown): string {
  const encoded = safeStringify(value);
  if (!encoded) {
    return failNative<string>(capability, 'json stringify failed');
  }
  return encoded;
}

function parseRegistryPayload<T>(capability: string, raw: unknown): T | undefined {
  if (raw === null || raw === undefined || raw === '') {
    return undefined;
  }
  if (typeof raw !== 'string') {
    return failNative<T>(capability, 'native returned non-string payload');
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    return failNative<T>(capability, `invalid native json: ${extractNativeErrorMessage(error)}`);
  }
}

export function registerResponsesReasoning(
  id: unknown,
  reasoning: ResponsesReasoningPayload | undefined,
): void {
  if (typeof id !== 'string') return;
  if (!reasoning) return;
  const capability = 'registerResponsesReasoningJson';
  callNativeRequired(capability, id, stringifyRegistryPayload(capability, reasoning));
}

export function consumeResponsesReasoning(
  id: unknown,
): ResponsesReasoningPayload | undefined {
  if (typeof id !== 'string') return undefined;
  const capability = 'consumeResponsesReasoningJson';
  const result = callNativeRequired(capability, id);
  return parseRegistryPayload<ResponsesReasoningPayload>(capability, result);
}

export function registerResponsesOutputTextMeta(
  id: unknown,
  meta: ResponsesOutputTextMeta | undefined,
): void {
  if (typeof id !== 'string') return;
  if (!meta) return;
  const capability = 'registerResponsesOutputTextMetaJson';
  callNativeRequired(capability, id, stringifyRegistryPayload(capability, meta));
}

export function consumeResponsesOutputTextMeta(
  id: unknown,
): ResponsesOutputTextMeta | undefined {
  if (typeof id !== 'string') return undefined;
  const capability = 'consumeResponsesOutputTextMetaJson';
  const result = callNativeRequired(capability, id);
  return parseRegistryPayload<ResponsesOutputTextMeta>(capability, result);
}

export function registerResponsesPayloadSnapshot(
  id: unknown,
  snapshot: Record<string, unknown> | undefined,
  options?: { clone?: boolean },
): void {
  if (typeof id !== 'string') return;
  if (!snapshot || typeof snapshot !== 'object') return;
  const capability = 'registerResponsesPayloadSnapshotJson';
  callNativeRequired(capability, id, stringifyRegistryPayload(capability, snapshot), options?.clone ?? true);
}

export function consumeResponsesPayloadSnapshot(
  id: unknown,
): Record<string, unknown> | undefined {
  if (typeof id !== 'string') return undefined;
  const capability = 'consumeResponsesPayloadSnapshotJson';
  const result = callNativeRequired(capability, id);
  return parseRegistryPayload<Record<string, unknown>>(capability, result);
}

export function consumeResponsesPayloadSnapshotByAliases(
  ids: unknown[],
): Record<string, unknown> | undefined {
  const capability = 'consumeResponsesPayloadSnapshotByAliasesJson';
  const result = callNativeRequired(capability, stringifyRegistryPayload(capability, ids));
  return parseRegistryPayload<Record<string, unknown>>(capability, result);
}

export function registerResponsesPassthrough(
  id: unknown,
  payload: Record<string, unknown> | undefined,
  options?: { clone?: boolean },
): void {
  if (typeof id !== 'string') return;
  if (!payload || typeof payload !== 'object') return;
  const capability = 'registerResponsesPassthroughJson';
  callNativeRequired(capability, id, stringifyRegistryPayload(capability, payload), options?.clone ?? true);
}

export function consumeResponsesPassthrough(
  id: unknown,
): Record<string, unknown> | undefined {
  if (typeof id !== 'string') return undefined;
  const capability = 'consumeResponsesPassthroughJson';
  const result = callNativeRequired(capability, id);
  return parseRegistryPayload<Record<string, unknown>>(capability, result);
}

export function consumeResponsesPassthroughByAliases(
  ids: unknown[],
): Record<string, unknown> | undefined {
  const capability = 'consumeResponsesPassthroughByAliasesJson';
  const result = callNativeRequired(capability, stringifyRegistryPayload(capability, ids));
  return parseRegistryPayload<Record<string, unknown>>(capability, result);
}
