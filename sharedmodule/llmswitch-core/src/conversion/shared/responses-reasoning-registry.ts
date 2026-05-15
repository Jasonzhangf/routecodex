// Registry thin wrappers — delegates to Rust NAPI
// All state managed in Rust; TS handles JSON serialization + error isolation

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

import { isNativeDisabledByEnv, readNativeFunction } from '../../router/virtual-router/engine-selection/native-hub-pipeline-resp-semantics-shared.js';

function callNative(capability: string, ...args: unknown[]): unknown {
  if (isNativeDisabledByEnv()) return undefined;
  const fn = readNativeFunction(capability);
  if (!fn) return undefined;
  try {
    return fn(...args);
  } catch {
    return undefined;
  }
}

export function registerResponsesReasoning(
  id: unknown,
  reasoning: ResponsesReasoningPayload | undefined,
): void {
  if (typeof id !== 'string') return;
  if (!reasoning) return;
  const t = JSON.stringify(reasoning);
  if (!t) return;
  callNative('registerResponsesReasoningJson', id, t);
}

export function consumeResponsesReasoning(
  id: unknown,
): ResponsesReasoningPayload | undefined {
  if (typeof id !== 'string') return undefined;
  const result = callNative('consumeResponsesReasoningJson', id);
  if (typeof result !== 'string' || !result) return undefined;
  try { return JSON.parse(result); } catch { return undefined; }
}

export function registerResponsesOutputTextMeta(
  id: unknown,
  meta: ResponsesOutputTextMeta | undefined,
): void {
  if (typeof id !== 'string') return;
  if (!meta) return;
  const t = JSON.stringify(meta);
  if (!t) return;
  callNative('registerResponsesOutputTextMetaJson', id, t);
}

export function consumeResponsesOutputTextMeta(
  id: unknown,
): ResponsesOutputTextMeta | undefined {
  if (typeof id !== 'string') return undefined;
  const result = callNative('consumeResponsesOutputTextMetaJson', id);
  if (typeof result !== 'string' || !result) return undefined;
  try { return JSON.parse(result); } catch { return undefined; }
}

export function registerResponsesPayloadSnapshot(
  id: unknown,
  snapshot: Record<string, unknown> | undefined,
  options?: { clone?: boolean },
): void {
  if (typeof id !== 'string') return;
  if (!snapshot || typeof snapshot !== 'object') return;
  const t = JSON.stringify(snapshot);
  if (!t) return;
  callNative('registerResponsesPayloadSnapshotJson', id, t, options?.clone ?? true);
}

export function consumeResponsesPayloadSnapshot(
  id: unknown,
): Record<string, unknown> | undefined {
  if (typeof id !== 'string') return undefined;
  const result = callNative('consumeResponsesPayloadSnapshotJson', id);
  if (typeof result !== 'string' || !result) return undefined;
  try { return JSON.parse(result); } catch { return undefined; }
}

export function consumeResponsesPayloadSnapshotByAliases(
  ids: unknown[],
): Record<string, unknown> | undefined {
  const t = JSON.stringify(ids);
  if (!t) return undefined;
  const result = callNative('consumeResponsesPayloadSnapshotByAliasesJson', t);
  if (typeof result !== 'string' || !result) return undefined;
  try { return JSON.parse(result); } catch { return undefined; }
}

export function registerResponsesPassthrough(
  id: unknown,
  payload: Record<string, unknown> | undefined,
  options?: { clone?: boolean },
): void {
  if (typeof id !== 'string') return;
  if (!payload || typeof payload !== 'object') return;
  const t = JSON.stringify(payload);
  if (!t) return;
  callNative('registerResponsesPassthroughJson', id, t, options?.clone ?? true);
}

export function consumeResponsesPassthrough(
  id: unknown,
): Record<string, unknown> | undefined {
  if (typeof id !== 'string') return undefined;
  const result = callNative('consumeResponsesPassthroughJson', id);
  if (typeof result !== 'string' || !result) return undefined;
  try { return JSON.parse(result); } catch { return undefined; }
}

export function consumeResponsesPassthroughByAliases(
  ids: unknown[],
): Record<string, unknown> | undefined {
  const t = JSON.stringify(ids);
  if (!t) return undefined;
  const result = callNative('consumeResponsesPassthroughByAliasesJson', t);
  if (typeof result !== 'string' || !result) return undefined;
  try { return JSON.parse(result); } catch { return undefined; }
}
