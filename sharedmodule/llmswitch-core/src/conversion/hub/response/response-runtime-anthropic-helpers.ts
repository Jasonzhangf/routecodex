import { normalizeAnthropicToolName } from '../../shared/anthropic-message-utils.js';

export type ToolAliasMap = Record<string, string>;

export interface MessageReasoningPayload {
  summary?: Array<{ type: 'summary_text'; text: string }>;
  content?: Array<{ type: 'reasoning_text'; text: string }>;
  encrypted_content?: string;
}

export function collapseReasoningSegments(segments: string[]): string[] {
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

export function normalizeMessageReasoningPayload(
  source: unknown
): MessageReasoningPayload | undefined {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return undefined;
  }
  const row = source as Record<string, unknown>;
  const summary = Array.isArray(row.summary)
    ? row.summary
      .map((entry) => {
        if (typeof entry === 'string') {
          const text = entry.trim();
          return text.length ? ({ type: 'summary_text' as const, text }) : null;
        }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return null;
        }
        const text = typeof (entry as Record<string, unknown>).text === 'string'
          ? String((entry as Record<string, unknown>).text).trim()
          : '';
        if (!text.length) {
          return null;
        }
        return { type: 'summary_text' as const, text };
      })
      .filter((entry): entry is { type: 'summary_text'; text: string } => entry !== null)
    : undefined;
  const content = Array.isArray(row.content)
    ? row.content
      .map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          return null;
        }
        const node = entry as Record<string, unknown>;
        const text = typeof node.text === 'string' ? String(node.text).trim() : '';
        if (!text.length) {
          return null;
        }
        const type = typeof node.type === 'string' ? node.type.trim().toLowerCase() : '';
        if (type && type !== 'reasoning_text' && type !== 'text') {
          return null;
        }
        return { type: 'reasoning_text' as const, text };
      })
      .filter((entry): entry is { type: 'reasoning_text'; text: string } => entry !== null)
    : undefined;
  const mergedSummary =
    Array.isArray(summary) && summary.length
      ? collapseReasoningSegments(summary.map((entry) => entry.text)).map((text) => ({ type: 'summary_text' as const, text }))
      : undefined;
  const mergedContent =
    Array.isArray(content) && content.length
      ? collapseReasoningSegments(content.map((entry) => entry.text)).map((text) => ({ type: 'reasoning_text' as const, text }))
      : undefined;
  const encrypted_content = typeof row.encrypted_content === 'string'
    ? row.encrypted_content.trim()
    : '';
  const hasSummary = Array.isArray(mergedSummary) && mergedSummary.length > 0;
  const hasContent = Array.isArray(mergedContent) && mergedContent.length > 0;
  const hasEncrypted = encrypted_content.length > 0;
  if (!hasSummary && !hasContent && !hasEncrypted) {
    return undefined;
  }
  return {
    summary: hasSummary ? mergedSummary : undefined,
    content: hasContent ? mergedContent : undefined,
    encrypted_content: hasEncrypted ? encrypted_content : undefined
  };
}

export function flattenAnthropicContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(flattenAnthropicContent).filter(Boolean).join('');
  }
  if (content && typeof content === 'object') {
    const block = content as Record<string, unknown>;
    if (typeof block.text === 'string') return block.text;
    if (typeof block.content === 'string') return block.content;
    if (Array.isArray(block.content)) return block.content.map(flattenAnthropicContent).filter(Boolean).join('');
  }
  return '';
}

export function createAnthropicToolNameResolver(aliasMap?: ToolAliasMap): (rawName: string) => string {
  const reverse = new Map<string, string>();
  const shouldReplaceAlias = (
    existingCanonical: string,
    nextCanonical: string,
    providerKey: string
  ): boolean => {
    const existing = existingCanonical.trim().toLowerCase();
    const next = nextCanonical.trim().toLowerCase();
    if (!existing) {
      return true;
    }
    // Prefer exact identity mapping first (providerName == canonicalName).
    if (next === providerKey && existing !== providerKey) {
      return true;
    }
    if (existing === providerKey && next !== providerKey) {
      return false;
    }
    // When provider emits exec_command, never downgrade back to shell_command.
    if (providerKey === 'exec_command') {
      if (next === 'exec_command' && existing !== 'exec_command') {
        return true;
      }
      if (existing === 'exec_command' && next !== 'exec_command') {
        return false;
      }
    }
    return false;
  };

  if (aliasMap && typeof aliasMap === 'object') {
    for (const [canonical, providerName] of Object.entries(aliasMap)) {
      if (typeof canonical !== 'string' || typeof providerName !== 'string') continue;
      const canonicalName = canonical.trim();
      if (!canonicalName.length) continue;
      const normalizedProvider = providerName.trim().toLowerCase();
      if (!normalizedProvider.length) continue;
      const existing = reverse.get(normalizedProvider);
      if (!existing || shouldReplaceAlias(existing, canonicalName, normalizedProvider)) {
        reverse.set(normalizedProvider, canonicalName);
      }
    }
  }

  return (rawName: string): string => {
    const trimmed = typeof rawName === 'string' ? rawName.trim() : '';
    if (!trimmed.length) {
      return '';
    }
    const lookup = reverse.get(trimmed.toLowerCase());
    if (lookup && lookup.trim().length) {
      return lookup.trim();
    }
    const normalized = normalizeAnthropicToolName(trimmed);
    return (normalized && normalized.trim().length ? normalized : trimmed).trim();
  };
}

export function applyReasoningPayload(
  message: Record<string, unknown>,
  reasoning: MessageReasoningPayload | undefined
): void {
  if (!reasoning) {
    return;
  }
  (message as any).reasoning = reasoning;
  const contentSegments = Array.isArray(reasoning.content)
    ? collapseReasoningSegments(reasoning.content.map((entry) => entry.text))
    : [];
  const projected = contentSegments.length
    ? contentSegments.join('\n')
    : (() => {
        const summarySegments = Array.isArray(reasoning.summary)
          ? collapseReasoningSegments(reasoning.summary.map((entry) => entry.text))
          : [];
        return summarySegments.length ? summarySegments.join('\n') : undefined;
      })();
  if (projected && projected.trim().length) {
    (message as any).reasoning_content = projected;
  }
}
