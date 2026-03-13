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
  reasoning?: ResponsesReasoningPayload;
  outputText?: ResponsesOutputTextMeta;
  payloadSnapshot?: Record<string, unknown>;
  passthroughPayload?: Record<string, unknown>;
}

const registry = new Map<string, ResponsesMetadataEntry>();

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
  let entry = registry.get(id);
  if (!entry) {
    entry = {};
    registry.set(id, entry);
  }
  return entry;
}

function pruneEntry(id: string): void {
  const entry = registry.get(id);
  if (!entry) return;
  if (!entry.reasoning && !entry.outputText && !entry.payloadSnapshot && !entry.passthroughPayload) {
    registry.delete(id);
  }
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

export function registerResponsesPayloadSnapshot(id: unknown, snapshot: Record<string, unknown> | undefined): void {
  if (typeof id !== 'string') return;
  if (!snapshot || typeof snapshot !== 'object') return;
  const clone = cloneSnapshot(snapshot);
  if (!clone) return;
  const entry = ensureEntry(id);
  entry.payloadSnapshot = clone;
}

export function consumeResponsesPayloadSnapshot(id: unknown): Record<string, unknown> | undefined {
  if (typeof id !== 'string') return undefined;
  const entry = registry.get(id);
  if (!entry?.payloadSnapshot) return undefined;
  const clone = cloneSnapshot(entry.payloadSnapshot) ?? entry.payloadSnapshot;
  entry.payloadSnapshot = undefined;
  pruneEntry(id);
  return clone;
}

export function registerResponsesPassthrough(id: unknown, payload: Record<string, unknown> | undefined): void {
  if (typeof id !== 'string') return;
  if (!payload || typeof payload !== 'object') return;
  const clone = cloneSnapshot(payload);
  if (!clone) return;
  const entry = ensureEntry(id);
  entry.passthroughPayload = clone;
}

export function consumeResponsesPassthrough(id: unknown): Record<string, unknown> | undefined {
  if (typeof id !== 'string') return undefined;
  const entry = registry.get(id);
  if (!entry?.passthroughPayload) return undefined;
  const clone = cloneSnapshot(entry.passthroughPayload) ?? entry.passthroughPayload;
  entry.passthroughPayload = undefined;
  pruneEntry(id);
  return clone;
}
