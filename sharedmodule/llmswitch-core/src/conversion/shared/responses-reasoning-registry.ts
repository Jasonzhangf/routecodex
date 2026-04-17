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

import { parseLenientJsonishWithNative } from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

interface ResponsesMetadataEntry {
  lastTouchedAtMs: number;
  reasoning?: ResponsesReasoningPayload;
  outputText?: ResponsesOutputTextMeta;
  payloadSnapshot?: Record<string, unknown>;
  passthroughPayload?: Record<string, unknown>;
}

const DEFAULT_RESPONSES_METADATA_TTL_MS = 10 * 60 * 1000;
const DEFAULT_RESPONSES_METADATA_MAX_ENTRIES = 2048;
const registry = new Map<string, ResponsesMetadataEntry>();

function readPositiveIntegerFromEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveRegistryTtlMs(): number {
  return readPositiveIntegerFromEnv(
    process.env.ROUTECODEX_RESPONSES_METADATA_TTL_MS
      ?? process.env.RCC_RESPONSES_METADATA_TTL_MS,
    DEFAULT_RESPONSES_METADATA_TTL_MS
  );
}

function resolveRegistryMaxEntries(): number {
  return readPositiveIntegerFromEnv(
    process.env.ROUTECODEX_RESPONSES_METADATA_MAX_ENTRIES
      ?? process.env.RCC_RESPONSES_METADATA_MAX_ENTRIES,
    DEFAULT_RESPONSES_METADATA_MAX_ENTRIES
  );
}

function pruneRegistry(nowMs: number): void {
  const ttlMs = resolveRegistryTtlMs();
  const staleIds: string[] = [];
  for (const [id, entry] of registry.entries()) {
    if (nowMs - entry.lastTouchedAtMs >= ttlMs) {
      staleIds.push(id);
    }
  }
  for (const id of staleIds) {
    registry.delete(id);
  }

  const maxEntries = resolveRegistryMaxEntries();
  if (registry.size <= maxEntries) {
    return;
  }

  const overflow = Array.from(registry.entries())
    .sort((a, b) => a[1].lastTouchedAtMs - b[1].lastTouchedAtMs)
    .slice(0, Math.max(0, registry.size - maxEntries));
  for (const [id] of overflow) {
    registry.delete(id);
  }
}

function collapseReasoningSegments(segments: string[]): string[] {
  const cleaned = segments.map((text) => text.trim()).filter((text) => text.length > 0);
  const merged: string[] = [];
  for (const entry of cleaned) {
    if (merged.length === 0) {
      merged.push(entry);
      continue;
    }
    const last = merged[merged.length - 1];
    if (entry === last) {
      continue;
    }
    if (entry.startsWith(last)) {
      merged[merged.length - 1] = entry;
      continue;
    }
    if (last.startsWith(entry)) {
      continue;
    }
    merged.push(entry);
  }
  return merged;
}

function ensureEntry(id: string): ResponsesMetadataEntry {
  const nowMs = Date.now();
  pruneRegistry(nowMs);
  let entry = registry.get(id);
  if (!entry) {
    entry = { lastTouchedAtMs: nowMs };
    registry.set(id, entry);
    return entry;
  }
  entry.lastTouchedAtMs = nowMs;
  return entry;
}

function pruneEntry(id: string): void {
  const entry = registry.get(id);
  if (!entry) return;
  if (!entry.reasoning && !entry.outputText && !entry.payloadSnapshot && !entry.passthroughPayload) {
    registry.delete(id);
    return;
  }
  entry.lastTouchedAtMs = Date.now();
}

function cloneSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> | undefined {
  try {
    const structuredCloneImpl = (globalThis as { structuredClone?: <T>(input: T) => T }).structuredClone;
    if (typeof structuredCloneImpl === 'function') {
      return structuredCloneImpl(snapshot);
    }
  } catch {
    /* ignore structuredClone failures */
  }
  try {
    const serialized = JSON.stringify(snapshot);
    const parsed = parseLenientJsonishWithNative(serialized);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function normalizeResponseRegistryAliases(ids: unknown[]): string[] {
  const normalized = new Set<string>();
  for (const candidate of ids) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    normalized.add(trimmed);
  }
  return Array.from(normalized);
}

function consumeRetentionByAliases(
  ids: unknown[],
  field: 'payloadSnapshot' | 'passthroughPayload'
): Record<string, unknown> | undefined {
  const aliases = normalizeResponseRegistryAliases(ids);
  if (!aliases.length) {
    return undefined;
  }
  pruneRegistry(Date.now());

  let matchedValue: Record<string, unknown> | undefined;
  for (const alias of aliases) {
    const entry = registry.get(alias);
    const candidate = entry?.[field];
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      matchedValue = candidate;
      break;
    }
  }
  if (!matchedValue) {
    return undefined;
  }

  for (const alias of aliases) {
    const entry = registry.get(alias);
    if (!entry?.[field]) {
      continue;
    }
    entry[field] = undefined;
    pruneEntry(alias);
  }

  return cloneSnapshot(matchedValue) ?? matchedValue;
}

export function registerResponsesReasoning(id: unknown, reasoning: ResponsesReasoningPayload | undefined): void {
  if (typeof id !== 'string') return;
  if (!reasoning) return;
  const summaryRaw = Array.isArray(reasoning.summary)
    ? reasoning.summary
      .map((item) => String(item.text ?? '').trim())
      .filter((text) => text.length > 0)
    : [];
  const summaryCollapsed = summaryRaw.length
    ? collapseReasoningSegments(summaryRaw).map((text) => ({ type: 'summary_text' as const, text }))
    : undefined;
  const contentRaw = Array.isArray(reasoning.content)
    ? reasoning.content
      .map((item) => String(item.text ?? '').trim())
      .filter((text) => text.length > 0)
    : [];
  const contentCollapsed = contentRaw.length
    ? collapseReasoningSegments(contentRaw).map((text) => ({
      type: 'reasoning_text' as const,
      text
    }))
    : undefined;
  const hasSummary = Array.isArray(summaryCollapsed) && summaryCollapsed.length > 0;
  const hasContent = Array.isArray(contentCollapsed) && contentCollapsed.length > 0;
  const hasEncrypted = reasoning.encrypted_content !== undefined;
  if (!hasSummary && !hasContent && !hasEncrypted) return;
  const entry = ensureEntry(id);
  entry.reasoning = {
    summary: hasSummary ? summaryCollapsed : undefined,
    content: hasContent ? contentCollapsed : undefined,
    encrypted_content: reasoning.encrypted_content
  };
}

export function consumeResponsesReasoning(id: unknown): ResponsesReasoningPayload | undefined {
  if (typeof id !== 'string') return undefined;
  pruneRegistry(Date.now());
  const entry = registry.get(id);
  if (!entry?.reasoning) return undefined;
  const value: ResponsesReasoningPayload = {
    summary: entry.reasoning.summary ? [...entry.reasoning.summary] : undefined,
    content: entry.reasoning.content ? [...entry.reasoning.content] : undefined,
    encrypted_content: entry.reasoning.encrypted_content
  };
  entry.reasoning = undefined;
  pruneEntry(id);
  return value;
}

export function registerResponsesOutputTextMeta(id: unknown, meta: ResponsesOutputTextMeta | undefined): void {
  if (typeof id !== 'string') return;
  if (!meta) return;
  const entry = ensureEntry(id);
  entry.outputText = {
    hasField: Boolean(meta.hasField),
    value: typeof meta.value === 'string' ? meta.value : undefined,
    raw: typeof meta.raw === 'string' ? meta.raw : undefined
  };
}

export function consumeResponsesOutputTextMeta(id: unknown): ResponsesOutputTextMeta | undefined {
  if (typeof id !== 'string') return undefined;
  pruneRegistry(Date.now());
  const entry = registry.get(id);
  if (!entry?.outputText) return undefined;
  const value: ResponsesOutputTextMeta = {
    hasField: Boolean(entry.outputText.hasField),
    value: entry.outputText.value,
    raw: entry.outputText.raw
  };
  entry.outputText = undefined;
  pruneEntry(id);
  return value;
}

export function registerResponsesPayloadSnapshot(
  id: unknown,
  snapshot: Record<string, unknown> | undefined,
  options?: { clone?: boolean }
): void {
  if (typeof id !== 'string') return;
  if (!snapshot || typeof snapshot !== 'object') return;
  const retained = options?.clone === false ? snapshot : cloneSnapshot(snapshot);
  if (!retained) return;
  const entry = ensureEntry(id);
  entry.payloadSnapshot = retained;
}

export function consumeResponsesPayloadSnapshot(id: unknown): Record<string, unknown> | undefined {
  if (typeof id !== 'string') return undefined;
  pruneRegistry(Date.now());
  const entry = registry.get(id);
  if (!entry?.payloadSnapshot) return undefined;
  const clone = cloneSnapshot(entry.payloadSnapshot) ?? entry.payloadSnapshot;
  entry.payloadSnapshot = undefined;
  pruneEntry(id);
  return clone;
}

export function consumeResponsesPayloadSnapshotByAliases(ids: unknown[]): Record<string, unknown> | undefined {
  return consumeRetentionByAliases(ids, 'payloadSnapshot');
}

export function registerResponsesPassthrough(
  id: unknown,
  payload: Record<string, unknown> | undefined,
  options?: { clone?: boolean }
): void {
  if (typeof id !== 'string') return;
  if (!payload || typeof payload !== 'object') return;
  const retained = options?.clone === false ? payload : cloneSnapshot(payload);
  if (!retained) return;
  const entry = ensureEntry(id);
  entry.passthroughPayload = retained;
}

export function consumeResponsesPassthrough(id: unknown): Record<string, unknown> | undefined {
  if (typeof id !== 'string') return undefined;
  pruneRegistry(Date.now());
  const entry = registry.get(id);
  if (!entry?.passthroughPayload) return undefined;
  const clone = cloneSnapshot(entry.passthroughPayload) ?? entry.passthroughPayload;
  entry.passthroughPayload = undefined;
  pruneEntry(id);
  return clone;
}

export function consumeResponsesPassthroughByAliases(ids: unknown[]): Record<string, unknown> | undefined {
  return consumeRetentionByAliases(ids, 'passthroughPayload');
}
