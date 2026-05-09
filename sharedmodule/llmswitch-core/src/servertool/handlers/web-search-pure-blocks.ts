/**
 * Shared pure functions from web-search.ts.
 *
 * Zero side effects. No env reads. No logging.
 * Deterministic input -> output for search result processing,
 * hit collection, formatting, and system prompt generation.
 */

import type { JsonObject, JsonValue } from '../../conversion/hub/types/json.js';
import type { ToolCall } from '../types.js';

// ── constants ─────────────────────────────────────────────────────────
const LEGACY_TOOL_NAME = 'web_search';
const SERVERTOOL_TOOL_NAME = 'websearch';

// ── local types (mirrored from web-search.ts to avoid circular import) ─
export interface WebSearchEngineConfig {
  providerKey: string;
  backendKind?: 'serper' | 'openai-responses' | 'gemini-grounding' | 'qwen-search' | 'iflow-retrieve' | 'websearch' | 'direct';
  directActivation?: 'route' | 'builtin';
  modelId?: string;
  maxUses?: number;
  serverToolsDisabled?: boolean;
  searchEngineList?: string[];
}

export interface WebSearchItem {
  title?: string;
  link: string;
  media?: string;
  publish_date?: string;
  content?: string;
  refer?: string;
}

export function resolveWebSearchToolName(raw: unknown): string {
  const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (normalized === 'websearch' || normalized === 'web-search') {
    return SERVERTOOL_TOOL_NAME;
  }
  if (normalized === LEGACY_TOOL_NAME) {
    return LEGACY_TOOL_NAME;
  }
  return SERVERTOOL_TOOL_NAME;
}

export function parseToolArguments(toolCall: ToolCall): Record<string, unknown> {
  if (!toolCall.arguments || typeof toolCall.arguments !== 'string') {
    return {};
  }
  try {
    return JSON.parse(toolCall.arguments) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function isGeminiWebSearchEngine(engine: WebSearchEngineConfig): boolean {
  const key = engine.providerKey.toLowerCase();
  return key.startsWith('gemini.');
}

export function isQwenWebSearchEngine(engine: WebSearchEngineConfig): boolean {
  const key = engine.providerKey.toLowerCase();
  return key.startsWith('qwen.');
}

export function isIflowRetrieveWebSearchEngine(engine: WebSearchEngineConfig): boolean {
  return Array.isArray(engine.searchEngineList) && engine.searchEngineList.length > 0;
}

export function normalizeResultCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = Math.trunc(value);
    if (normalized >= 5 && normalized <= 15) {
      return normalized;
    }
  }
  return 10;
}

export function extractAssistantMessage(chatResponse: JsonObject): JsonObject | null {
  const choices = Array.isArray((chatResponse as { choices?: unknown }).choices)
    ? ((chatResponse as { choices: JsonValue[] }).choices as JsonValue[])
    : [];
  if (!choices.length) return null;
  const firstChoice = choices[0] && typeof choices[0] === 'object' && !Array.isArray(choices[0])
    ? (choices[0] as JsonObject)
    : null;
  if (!firstChoice) return null;
  return firstChoice.message && typeof firstChoice.message === 'object'
    ? (firstChoice.message as JsonObject)
    : null;
}

export function buildToolMessages(chatResponse: JsonObject): JsonObject[] {
  const toolOutputs = Array.isArray((chatResponse as { tool_outputs?: unknown }).tool_outputs)
    ? ((chatResponse as { tool_outputs: JsonValue[] }).tool_outputs as JsonValue[])
    : [];
  const messages: JsonObject[] = [];
  for (const entry of toolOutputs) {
    if (!entry || typeof entry !== 'object') continue;
    const toolCallId = typeof (entry as { tool_call_id?: unknown }).tool_call_id === 'string'
      ? ((entry as { tool_call_id: string }).tool_call_id as string)
      : undefined;
    if (!toolCallId) continue;
    const name = typeof (entry as { name?: unknown }).name === 'string'
      ? ((entry as { name: string }).name as string)
      : 'tool';
    const output = typeof (entry as { output?: unknown }).output === 'string'
      ? ((entry as { output: string }).output as string)
      : '';
    messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      name,
      content: output,
    });
  }
  return messages;
}

export function findWebSearchArray(chatResponse: JsonObject): JsonValue[] {
  const assistant = extractAssistantMessage(chatResponse);
  if (!assistant) return [];
  const content = assistant.content;
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? (parsed as JsonValue[]) : [];
    } catch {
      return [];
    }
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object' && (part as JsonObject).type === 'text') {
        const text = (part as JsonObject).text;
        if (typeof text === 'string') {
          try {
            const parsed = JSON.parse(text);
            return Array.isArray(parsed) ? (parsed as JsonValue[]) : [];
          } catch {
            return [];
          }
        }
      }
    }
  }
  return [];
}

export function collectWebSearchHits(chatResponse: JsonObject, targetCount: number): WebSearchItem[] {
  const array = findWebSearchArray(chatResponse);
  if (!array.length) return [];
  const maxItems = Math.max(5, Math.min(15, targetCount || 10));
  const hits: WebSearchItem[] = [];
  for (const entry of array.slice(0, maxItems)) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    hits.push({
      title: typeof record.title === 'string' ? record.title : undefined,
      link: typeof record.link === 'string' ? record.link : '',
      media: typeof record.media === 'string' ? record.media : undefined,
      publish_date: typeof record.publish_date === 'string' ? record.publish_date : undefined,
      content: typeof record.content === 'string' ? record.content : undefined,
      refer: typeof record.refer === 'string' ? record.refer : undefined
    });
  }
  return hits;
}

export function limitHits(hits: WebSearchItem[]): WebSearchItem[] {
  if (!hits.length) return [];
  const filtered = hits.slice(0, 15);
  if (filtered.length >= 5) {
    return filtered;
  }
  return filtered;
}

export function formatHitsSummary(hits: WebSearchItem[]): string {
  if (!hits.length) {
    return '';
  }
  const segments: string[] = [];
  hits.forEach((hit, index) => {
    const idx = hit.refer && hit.refer.trim() ? hit.refer.trim() : String(index + 1);
    const headerParts: string[] = [];
    if (hit.title) headerParts.push(hit.title);
    if (hit.media) headerParts.push(hit.media);
    if (hit.publish_date) headerParts.push(hit.publish_date);
    const header = headerParts.length ? headerParts.join(' · ') : '搜索结果';
    const details = [hit.content, hit.link].filter(Boolean).join('\n');
    segments.push(`【${idx}】${header}\n${details}`);
  });
  return segments.join('\n\n');
}

export function getArray(value: unknown): JsonValue[] {
  return Array.isArray(value) ? (value as JsonValue[]) : [];
}

export function sanitizeBackendError(message: string): string {
  const lowered = message.toLowerCase();
  if (lowered.includes('contentfilter')) {
    return '搜索请求被后端暂时拒绝';
  }
  if (lowered.includes('instructions are not valid')) {
    return '搜索指令格式未被后端接受';
  }
  return message;
}

export function buildWebSearchSystemPrompt(targetCount: number): string {
  const normalizedTarget = Math.max(5, Math.min(15, targetCount));
  const instructions = [
    'You are an up-to-date web search engine that aggregates public internet results.',
    `Return between 5 and 15 high-quality search results (aim for about ${normalizedTarget} when available).`,
    'Each result must include: title, source/media, publish date if available, a concise summary (<=200 characters), and a direct URL that users can click for verification.',
    'Prefer de-duplicated sources and include diverse outlets. If fewer than 5 results exist, return what you can find and explain the limitation.',
    'Only mention that the query was blocked when the backend explicitly rejects it, and encourage the user to adjust their keywords before retrying.',
    'Structure the answer so downstream systems can extract each result cleanly.'
  ];
  return instructions.join('\n');
}
