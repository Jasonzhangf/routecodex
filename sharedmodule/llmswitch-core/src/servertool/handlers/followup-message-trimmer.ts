import type { JsonObject } from '../../conversion/hub/types/json.js';

type Options = {
  maxNonSystemMessages: number;
};

function isMessageRecord(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRole(role: unknown): string {
  return typeof role === 'string' ? role.trim().toLowerCase() : '';
}

function isSystemRole(role: string): boolean {
  const normalized = role.trim().toLowerCase();
  return normalized === 'system' || normalized === 'developer';
}

function isUserMessage(msg: JsonObject): boolean {
  return normalizeRole(msg.role) === 'user';
}

function isToolResponseMessage(msg: JsonObject): boolean {
  const role = normalizeRole(msg.role);
  return role === 'tool' || role === 'function';
}

function isAssistantToolCallMessage(msg: JsonObject): boolean {
  const role = normalizeRole(msg.role);
  if (role !== 'assistant' && role !== 'model') {
    return false;
  }
  const toolCalls = Array.isArray((msg as { tool_calls?: unknown }).tool_calls)
    ? ((msg as { tool_calls: unknown[] }).tool_calls)
    : [];
  if (toolCalls.length > 0) {
    return true;
  }
  const fnCall = (msg as { function_call?: unknown }).function_call;
  if (fnCall && typeof fnCall === 'object' && !Array.isArray(fnCall)) {
    return true;
  }
  return false;
}

function findPrevIndex(
  messages: JsonObject[],
  startIndexExclusive: number,
  predicate: (msg: JsonObject) => boolean
): number | null {
  for (let i = startIndexExclusive - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!msg) continue;
    if (predicate(msg)) return i;
  }
  return null;
}

/**
 * Trim OpenAI-style messages for internal servertool followups.
 *
 * Goal: avoid sending a massive chat history on auto-followup requests (e.g. stop_message_flow),
 * which can push Gemini/Antigravity into empty/malformed responses under long-context loads.
 *
 * Strategy:
 * - Always keep system/developer messages (regardless of position).
 * - Keep only the tail of non-system messages (maxNonSystemMessages), preserving original order.
 */
export function trimOpenAiMessagesForFollowup(
  rawMessages: unknown,
  options: Options
): JsonObject[] {
  const maxNonSystemMessages =
    typeof options?.maxNonSystemMessages === 'number' && Number.isFinite(options.maxNonSystemMessages)
      ? Math.max(1, Math.floor(options.maxNonSystemMessages))
      : 16;

  const messages = Array.isArray(rawMessages) ? (rawMessages as unknown[]) : [];
  if (!messages.length) {
    return [];
  }

  const messageRecords = messages.filter(isMessageRecord);
  if (!messageRecords.length) {
    return [];
  }

  const nonSystemIndices: number[] = [];
  for (let i = 0; i < messageRecords.length; i += 1) {
    const entry = messageRecords[i];
    const role = typeof entry.role === 'string' ? entry.role : '';
    if (!role || isSystemRole(role)) {
      continue;
    }
    nonSystemIndices.push(i);
  }

  if (nonSystemIndices.length <= maxNonSystemMessages) {
    return messageRecords;
  }

  const keepSet = new Set<number>(nonSystemIndices.slice(nonSystemIndices.length - maxNonSystemMessages));

  // Expand keepSet to preserve tool-call adjacency:
  // - If we keep tool responses, keep their preceding tool call + its anchor.
  // - If we keep tool calls, keep their anchor + following tool responses.
  //
  // Gemini tool-calling constraint: functionCall turn must come immediately after a user turn
  // or after a functionResponse turn. When trimming, we must not cut away the user anchor.
  let changed = true;
  let guard = 0;
  while (changed && guard < 8) {
    changed = false;
    guard += 1;
    const sorted = Array.from(keepSet).sort((a, b) => a - b);
    for (const idx of sorted) {
      const msg = messageRecords[idx];
      if (!msg) continue;

      if (isToolResponseMessage(msg)) {
        const toolCallIndex = findPrevIndex(messageRecords, idx, isAssistantToolCallMessage);
        if (toolCallIndex !== null && !keepSet.has(toolCallIndex)) {
          keepSet.add(toolCallIndex);
          changed = true;
        }
        if (toolCallIndex !== null) {
          const anchorIndex = findPrevIndex(messageRecords, toolCallIndex, (m) => isUserMessage(m) || isToolResponseMessage(m));
          if (anchorIndex !== null && !keepSet.has(anchorIndex)) {
            keepSet.add(anchorIndex);
            changed = true;
          }
        }
        continue;
      }

      if (isAssistantToolCallMessage(msg)) {
        const anchorIndex = findPrevIndex(messageRecords, idx, (m) => isUserMessage(m) || isToolResponseMessage(m));
        if (anchorIndex !== null && !keepSet.has(anchorIndex)) {
          keepSet.add(anchorIndex);
          changed = true;
        }
        for (let i = idx + 1; i < messageRecords.length; i += 1) {
          const next = messageRecords[i];
          if (!next) continue;
          if (!isToolResponseMessage(next)) {
            break;
          }
          if (!keepSet.has(i)) {
            keepSet.add(i);
            changed = true;
          }
        }
      }
    }
  }

  // Ensure the first kept non-system message is a user turn (do not drop history; add an anchor).
  const firstKeptNonSystem = (() => {
    for (let i = 0; i < messageRecords.length; i += 1) {
      const role = normalizeRole(messageRecords[i]?.role);
      if (!role || isSystemRole(role)) continue;
      if (keepSet.has(i)) return i;
    }
    return null;
  })();
  if (firstKeptNonSystem !== null && !isUserMessage(messageRecords[firstKeptNonSystem])) {
    const userAnchor = findPrevIndex(messageRecords, firstKeptNonSystem, isUserMessage);
    if (userAnchor !== null) {
      keepSet.add(userAnchor);
      // One more pass to ensure tool adjacency around the newly added anchor.
      for (const idx of Array.from(keepSet).sort((a, b) => a - b)) {
        const msg = messageRecords[idx];
        if (!msg) continue;
        if (isToolResponseMessage(msg)) {
          const toolCallIndex = findPrevIndex(messageRecords, idx, isAssistantToolCallMessage);
          if (toolCallIndex !== null) keepSet.add(toolCallIndex);
        } else if (isAssistantToolCallMessage(msg)) {
          const anchorIndex = findPrevIndex(messageRecords, idx, (m) => isUserMessage(m) || isToolResponseMessage(m));
          if (anchorIndex !== null) keepSet.add(anchorIndex);
        }
      }
    } else {
      // If there is no user message before the kept window, the history prefix is already invalid
      // for Gemini tool-calling (tool_calls/functionCall must be preceded by user or tool response).
      // In this case, preserve system/developer messages and start the followup from the first user
      // message that exists inside the kept window.
      let firstUserAfter: number | null = null;
      for (let i = firstKeptNonSystem; i < messageRecords.length; i += 1) {
        if (keepSet.has(i) && isUserMessage(messageRecords[i])) {
          firstUserAfter = i;
          break;
        }
      }
      if (firstUserAfter !== null) {
        for (const idx of Array.from(keepSet)) {
          if (idx < firstUserAfter) {
            keepSet.delete(idx);
          }
        }
      }
    }
  }

  const trimmed: JsonObject[] = [];
  for (let i = 0; i < messageRecords.length; i += 1) {
    const entry = messageRecords[i];
    const role = typeof entry.role === 'string' ? entry.role : '';
    if (role && isSystemRole(role)) {
      trimmed.push(entry);
      continue;
    }
    if (keepSet.has(i)) {
      trimmed.push(entry);
    }
  }
  return trimmed;
}
