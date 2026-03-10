import type { TextMarkupNormalizeOptions } from '../../types/text-markup-normalizer.js';
import {
  extractToolCallsFromReasoningTextWithNative,
  parseLenientJsonishWithNative,
  normalizeAssistantTextToToolCallsWithNative
} from '../../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

function enabled(): boolean {
  try {
    return String((process as any)?.env?.RCC_TEXT_MARKUP_COMPAT ?? '1').trim() !== '0';
  } catch {
    return true;
  }
}

function tryBuildToolCallFromPartialJson(raw: string): Record<string, any> | null {
  const match = raw.match(/```tool_call\s*([\s\S]*?)```/i);
  const body = match?.[1]?.trim();
  if (!body) {
    return null;
  }
  const openBraces = (body.match(/\{/g) || []).length;
  const closeBraces = (body.match(/\}/g) || []).length;
  const balanced = closeBraces < openBraces ? body + '}'.repeat(openBraces - closeBraces) : body;
  let parsed: any = null;
  try {
    parsed = JSON.parse(balanced);
  } catch {
    parsed = parseLenientJsonishWithNative(balanced);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
  if (!name) {
    return null;
  }
  const args = parsed.arguments;
  const argumentsText =
    typeof args === 'string'
      ? args
      : JSON.stringify(args && typeof args === 'object' ? args : {});
  return {
    id: 'reasoning_1',
    type: 'function',
    function: {
      name,
      arguments: argumentsText
    }
  };
}

export function normalizeAssistantTextToToolCalls(
  message: Record<string, any>,
  options?: TextMarkupNormalizeOptions
): Record<string, any> {
  if (!enabled()) return message;
  const normalized = normalizeAssistantTextToToolCallsWithNative(message, options) as Record<string, any>;
  if (Array.isArray(normalized?.tool_calls) && normalized.tool_calls.length > 0) {
    return normalized;
  }

  for (const key of ['content', 'reasoning', 'reasoning_content'] as const) {
    const raw = typeof normalized?.[key] === 'string'
      ? normalized[key]
      : typeof message?.[key] === 'string'
        ? message[key]
        : '';
    if (!raw.trim()) {
      continue;
    }
    const extracted = extractToolCallsFromReasoningTextWithNative(raw, 'reasoning');
    if (!Array.isArray(extracted.toolCalls) || extracted.toolCalls.length === 0) {
      continue;
    }
    const next = { ...normalized, tool_calls: extracted.toolCalls };
    if (typeof extracted.cleanedText === 'string') {
      next[key] = extracted.cleanedText;
    }
    return next;
  }

  for (const key of ['content', 'reasoning', 'reasoning_content'] as const) {
    const raw = typeof normalized?.[key] === 'string'
      ? normalized[key]
      : typeof message?.[key] === 'string'
        ? message[key]
        : '';
    if (!raw.trim()) {
      continue;
    }
    const toolCall = tryBuildToolCallFromPartialJson(raw);
    if (!toolCall) {
      continue;
    }
    return {
      ...normalized,
      [key]: '',
      tool_calls: [toolCall]
    };
  }

  return normalized;
}
