import type { JsonObject } from '../../hub/types/json.js';
import {
  normalizeAssistantTextToToolCalls,
  type TextMarkupNormalizeOptions
} from '../../shared/text-markup-normalizer.js';
import { normalizeFunctionCallId } from '../../bridge-id-utils.js';

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function pickString(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length) return c.trim();
  }
  return undefined;
}

function extractResponsesMessageText(item: UnknownRecord): string {
  const parts: string[] = [];
  const content = Array.isArray(item.content) ? (item.content as unknown[]) : [];
  for (const part of content) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
    const text = pickString((part as any).text, (part as any).content, (part as any).value);
    if (text) parts.push(text);
  }
  if (typeof (item as any).output_text === 'string' && (item as any).output_text.trim().length) {
    parts.push(String((item as any).output_text));
  }
  return parts.join('\n').trim();
}

export interface HarvestToolCallsFromTextConfig {
  normalizer?: TextMarkupNormalizeOptions;
}

function harvestToolCallsFromResponsesPayloadInPlace(
  root: UnknownRecord,
  config?: HarvestToolCallsFromTextConfig
): boolean {
  const output = Array.isArray(root.output) ? (root.output as unknown[]) : [];
  if (!output.length) return false;

  let changed = false;
  const nextOutput: unknown[] = [];
  for (const item of output) {
    if (!isRecord(item)) {
      nextOutput.push(item);
      continue;
    }
    const type = typeof item.type === 'string' ? String(item.type).trim().toLowerCase() : '';
    if (type !== 'message') {
      nextOutput.push(item);
      continue;
    }
    const role = typeof (item as any).role === 'string' ? String((item as any).role).trim().toLowerCase() : 'assistant';
    if (role !== 'assistant') {
      nextOutput.push(item);
      continue;
    }
    const text = extractResponsesMessageText(item);
    if (!text) {
      nextOutput.push(item);
      continue;
    }

    const normalized = normalizeAssistantTextToToolCalls(
      { role: 'assistant', content: text } as Record<string, any>,
      config?.normalizer
    );
    const toolCalls = Array.isArray((normalized as any).tool_calls) ? ((normalized as any).tool_calls as any[]) : [];
    if (!toolCalls.length) {
      nextOutput.push(item);
      continue;
    }

    // Drop the original assistant message item (it usually only contains the tool markup),
    // and append canonical Responses function_call output items.
    changed = true;
    for (const call of toolCalls) {
      if (!call || typeof call !== 'object') continue;
      const fn = (call as any).function && typeof (call as any).function === 'object' ? (call as any).function : null;
      const name = typeof fn?.name === 'string' ? String(fn.name).trim() : '';
      if (!name) continue;
      const args = typeof fn?.arguments === 'string' ? String(fn.arguments) : '{}';
      const callId = pickString((call as any).call_id, (call as any).id) ?? `call_${Math.random().toString(36).slice(2, 10)}`;
      const itemId = normalizeFunctionCallId({ callId, fallback: `fc_${callId}` });
      nextOutput.push({
        type: 'function_call',
        id: itemId,
        call_id: callId,
        name,
        arguments: args
      });
    }
  }

  if (changed) {
    root.output = nextOutput as any;
  }
  return changed;
}

/**
 * Harvest tool calls from assistant textual markup into OpenAI `tool_calls`.
 *
 * Some upstreams (including certain iFlow/hosted models) emit tool calls as plain text tokens
 * (e.g. `<|tool_call_begin|> ...`) instead of structured `tool_calls`.
 *
 * This action is response-only and provider-scoped via compatibility profiles.
 */
export function harvestToolCallsFromText(payload: JsonObject): JsonObject {
  return harvestToolCallsFromTextWithConfig(payload);
}

export function harvestToolCallsFromTextWithConfig(
  payload: JsonObject,
  config?: HarvestToolCallsFromTextConfig
): JsonObject {
  const root = structuredClone(payload) as UnknownRecord;
  const choices = Array.isArray(root.choices) ? (root.choices as unknown[]) : [];

  // Responses provider payload: harvest into canonical Responses output items first.
  // This allows the normal semantic mapper (Responses → Chat) to surface tool_calls for servertool orchestration.
  if (!choices.length) {
    harvestToolCallsFromResponsesPayloadInPlace(root, config);
    return root as JsonObject;
  }

  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const message = (choice as UnknownRecord).message;
    if (!isRecord(message)) continue;

    const normalized = normalizeAssistantTextToToolCalls(
      message as Record<string, any>,
      config?.normalizer
    );
    if (normalized !== message) {
      (choice as UnknownRecord).message = normalized as unknown as JsonObject;
      const hasToolCalls = Array.isArray((normalized as any).tool_calls) && (normalized as any).tool_calls.length > 0;
      if (hasToolCalls) {
        const finish = typeof (choice as any).finish_reason === 'string' ? String((choice as any).finish_reason).trim() : '';
        if (!finish || finish === 'stop' || finish === 'length') {
          (choice as any).finish_reason = 'tool_calls';
        }
      }
    }
  }

  return root as JsonObject;
}
