import type { TextMarkupNormalizeOptions } from '../../types/text-markup-normalizer.js';
import { stripReasoningTransportNoise } from '../reasoning-normalizer.js';
import {
  extractToolCallsFromReasoningTextWithNative,
  normalizeAssistantTextToToolCallsWithNative,
  parseLenientJsonishWithNative
} from '../../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

const TOOL_HARVEST_KEYS = ['reasoning', 'reasoning_content', 'content'] as const;
const TOOL_CALL_OPEN_RE = /<tool_call(?:\s|>)/i;
const TOOL_CALL_CLOSE_RE = /<\/tool_call>/i;
const BARE_TOOL_CALL_PREFIX_RE = /^\s*[a-zA-Z0-9_.-]+\s*(?=<arg_key>|<arg_value>|<argument\b|<parameter\b)/i;
const TOOL_CALL_FENCE_RE = /^```tool_call\s*([\s\S]*?)```$/i;
const JSONISH_START_RE = /^\s*\{/;

function enabled(): boolean {
  try {
    return String((process as any)?.env?.RCC_TEXT_MARKUP_COMPAT ?? '1').trim() !== '0';
  } catch {
    return true;
  }
}

function prepareReasoningTextForHarvest(raw: string): string {
  const stripped = stripReasoningTransportNoise(raw);
  if (!stripped) {
    return '';
  }
  const fenced = tryNormalizeFencedToolCallJson(stripped);
  if (fenced) {
    return fenced;
  }
  if (!TOOL_CALL_OPEN_RE.test(stripped) && TOOL_CALL_CLOSE_RE.test(stripped) && BARE_TOOL_CALL_PREFIX_RE.test(stripped)) {
    return `<tool_call>${stripped}`;
  }
  return stripped;
}

function tryNormalizeFencedToolCallJson(raw: string): string | null {
  const match = raw.match(TOOL_CALL_FENCE_RE);
  const body = match?.[1]?.trim();
  if (!body || !JSONISH_START_RE.test(body)) {
    return null;
  }
  const balanced = balanceJsonishObject(body);
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
  const argumentsValue = parsed.arguments;
  const argumentsObject =
    argumentsValue && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)
      ? argumentsValue
      : {};
  return `[tool_call name="${name}"]${JSON.stringify({ arguments: argumentsObject })}[/tool_call]`;
}

function balanceJsonishObject(raw: string): string {
  const openBraces = (raw.match(/\{/g) || []).length;
  const closeBraces = (raw.match(/\}/g) || []).length;
  if (closeBraces >= openBraces) {
    return raw;
  }
  return raw + '}'.repeat(openBraces - closeBraces);
}

function consumeHarvestedReasoningText(
  target: Record<string, any>,
  sourceMessage: Record<string, any>
): Record<string, any> {
  let changed = false;
  const next = { ...target };

  for (const key of TOOL_HARVEST_KEYS) {
    const raw = typeof next?.[key] === 'string'
      ? next[key]
      : typeof sourceMessage?.[key] === 'string'
        ? sourceMessage[key]
        : '';
    if (!raw.trim()) {
      continue;
    }

    const sourceText = prepareReasoningTextForHarvest(raw);
    if (!sourceText) {
      if (key in next) {
        delete next[key];
        changed = true;
      }
      continue;
    }

    const extracted = extractToolCallsFromReasoningTextWithNative(sourceText, 'reasoning');
    if (!Array.isArray(extracted.toolCalls) || extracted.toolCalls.length === 0) {
      continue;
    }

    const cleanedText = typeof extracted.cleanedText === 'string' ? extracted.cleanedText.trim() : '';
    if (cleanedText) {
      if (next[key] !== cleanedText) {
        next[key] = cleanedText;
        changed = true;
      }
    } else if (key in next) {
      delete next[key];
      changed = true;
    }

    if (!Array.isArray(next.tool_calls) || next.tool_calls.length === 0) {
      next.tool_calls = extracted.toolCalls;
      changed = true;
    }
  }

  return changed ? next : target;
}

export function normalizeAssistantTextToToolCalls(
  message: Record<string, any>,
  options?: TextMarkupNormalizeOptions
): Record<string, any> {
  if (!enabled()) return message;
  const normalized = normalizeAssistantTextToToolCallsWithNative(message, options) as Record<string, any>;
  if (Array.isArray(normalized?.tool_calls) && normalized.tool_calls.length > 0) {
    return consumeHarvestedReasoningText(normalized, message);
  }

  return consumeHarvestedReasoningText(normalized, message);
}
