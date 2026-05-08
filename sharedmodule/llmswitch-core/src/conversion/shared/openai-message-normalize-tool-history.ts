import {
  isSyntheticRouteCodexToolCallId,
  readTrimmedString,
  type ToolHistoryContractViolation
} from './openai-message-normalize-contract.js';

function finalizePendingToolCalls(
  pendingToolCalls: Map<string, { index: number; role: string; itemType: string }>,
  options?: {
    allowDanglingToolCalls?: boolean;
    allowTerminalPendingSuffix?: boolean;
  }
): ToolHistoryContractViolation | null {
  if (
    options?.allowDanglingToolCalls === true
    && pendingToolCalls.size > 0
    && options.allowTerminalPendingSuffix === true
  ) {
    return null;
  }
  const firstPending = pendingToolCalls.entries().next();
  if (firstPending.done) {
    return null;
  }
  const [callId, meta] = firstPending.value;
  return {
    code: 'dangling_tool_call',
    index: meta.index,
    callId,
    role: meta.role,
    itemType: meta.itemType,
    reason: `tool call ${callId} does not have a matching tool result in history`
  };
}

function inspectAssistantToolCallEntries(
  toolCalls: unknown,
  args: {
    index: number;
    role: string;
    itemType: string;
    pendingToolCalls: Map<string, { index: number; role: string; itemType: string }>;
    seenToolCalls: Set<string>;
    missingIdReason: string;
    syntheticIdReason: (callId: string) => string;
    onValidatedCallId?: (callId: string) => 'pending' | 'preconsumed';
  }
): ToolHistoryContractViolation | null {
  if (!Array.isArray(toolCalls)) {
    return null;
  }
  for (const rawToolCall of toolCalls) {
    if (!rawToolCall || typeof rawToolCall !== 'object' || Array.isArray(rawToolCall)) {
      continue;
    }
    const toolCall = rawToolCall as Record<string, unknown>;
    const callId =
      readTrimmedString(toolCall.id)
      ?? readTrimmedString(toolCall.call_id)
      ?? readTrimmedString(toolCall.tool_call_id);
    if (!callId) {
      return {
        code: 'missing_tool_call_id',
        index: args.index,
        role: args.role,
        itemType: args.itemType,
        reason: args.missingIdReason
      };
    }
    if (isSyntheticRouteCodexToolCallId(callId)) {
      return {
        code: 'synthetic_tool_call_id',
        index: args.index,
        callId,
        role: args.role,
        itemType: args.itemType,
        reason: args.syntheticIdReason(callId)
      };
    }
    args.seenToolCalls.add(callId);
    const action = args.onValidatedCallId?.(callId) ?? 'pending';
    if (action === 'preconsumed') {
      continue;
    }
    args.pendingToolCalls.set(callId, {
      index: args.index,
      role: args.role,
      itemType: args.itemType
    });
  }
  return null;
}

function incrementToolCallCount(counts: Map<string, number>, callId: string): void {
  counts.set(callId, (counts.get(callId) ?? 0) + 1);
}

function decrementToolCallCount(counts: Map<string, number>, callId: string): void {
  const next = (counts.get(callId) ?? 0) - 1;
  if (next > 0) {
    counts.set(callId, next);
  } else {
    counts.delete(callId);
  }
}

function decrementFutureToolCallCount(counts: Map<string, number>, callId: string): void {
  decrementToolCallCount(counts, callId);
}

function collectBridgeInputFutureToolCallCounts(input: Array<Record<string, unknown>>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of input) {
    const itemType = readTrimmedString(entry.type)?.toLowerCase();
    const role = readTrimmedString(entry.role)?.toLowerCase();
    if (itemType === 'message' && role === 'assistant' && Array.isArray(entry.tool_calls)) {
      for (const rawToolCall of entry.tool_calls) {
        if (!rawToolCall || typeof rawToolCall !== 'object' || Array.isArray(rawToolCall)) {
          continue;
        }
        const toolCall = rawToolCall as Record<string, unknown>;
        const callId =
          readTrimmedString(toolCall.id)
          ?? readTrimmedString(toolCall.call_id)
          ?? readTrimmedString(toolCall.tool_call_id);
        if (callId) {
          incrementToolCallCount(counts, callId);
        }
      }
      continue;
    }
    if (itemType !== 'function_call') {
      continue;
    }
    const callId =
      readTrimmedString(entry.call_id)
      ?? readTrimmedString(entry.tool_call_id)
      ?? readTrimmedString(entry.id);
    if (callId) {
      incrementToolCallCount(counts, callId);
    }
  }
  return counts;
}

function isBridgeInputTerminalPendingSuffix(
  input: Array<Record<string, unknown>>,
  pendingToolCalls: Map<string, { index: number; role: string; itemType: string }>
): boolean {
  if (!input.length || pendingToolCalls.size === 0) {
    return false;
  }
  const remaining = new Set<string>(pendingToolCalls.keys());
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const entry = input[index];
    const itemType = readTrimmedString(entry.type)?.toLowerCase();
    const role = readTrimmedString(entry.role)?.toLowerCase();
    if (role === 'system') {
      continue;
    }
    if (itemType === 'function_call') {
      const callId =
        readTrimmedString(entry.call_id)
        ?? readTrimmedString(entry.tool_call_id)
        ?? readTrimmedString(entry.id);
      if (callId && remaining.has(callId)) {
        remaining.delete(callId);
        if (remaining.size === 0) {
          return true;
        }
        continue;
      }
      return false;
    }
    if (itemType === 'message' && role === 'assistant' && Array.isArray(entry.tool_calls)) {
      const callIds = (entry.tool_calls as unknown[])
        .map((rawToolCall) => {
          if (!rawToolCall || typeof rawToolCall !== 'object' || Array.isArray(rawToolCall)) {
            return undefined;
          }
          const toolCall = rawToolCall as Record<string, unknown>;
          return (
            readTrimmedString(toolCall.id)
            ?? readTrimmedString(toolCall.call_id)
            ?? readTrimmedString(toolCall.tool_call_id)
          );
        })
        .filter((callId): callId is string => Boolean(callId));
      if (callIds.length > 0 && callIds.every((callId) => remaining.has(callId))) {
        for (const callId of callIds) {
          remaining.delete(callId);
        }
        if (remaining.size === 0) {
          return true;
        }
        continue;
      }
      return false;
    }
    return false;
  }
  return remaining.size === 0;
}

function isChatTerminalPendingSuffix(
  messages: Array<Record<string, unknown>>,
  pendingToolCalls: Map<string, { index: number; role: string; itemType: string }>
): boolean {
  if (!messages.length || pendingToolCalls.size === 0) {
    return false;
  }
  const remaining = new Set<string>(pendingToolCalls.keys());
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const role = readTrimmedString(message.role)?.toLowerCase();
    if (role === 'system') {
      continue;
    }
    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      const callIds = (message.tool_calls as unknown[])
        .map((rawToolCall) => {
          if (!rawToolCall || typeof rawToolCall !== 'object' || Array.isArray(rawToolCall)) {
            return undefined;
          }
          const toolCall = rawToolCall as Record<string, unknown>;
          return (
            readTrimmedString(toolCall.id)
            ?? readTrimmedString(toolCall.call_id)
            ?? readTrimmedString(toolCall.tool_call_id)
          );
        })
        .filter((callId): callId is string => Boolean(callId));
      if (callIds.length > 0 && callIds.every((callId) => remaining.has(callId))) {
        for (const callId of callIds) {
          remaining.delete(callId);
        }
        if (remaining.size === 0) {
          return true;
        }
        continue;
      }
      return false;
    }
    return false;
  }
  return remaining.size === 0;
}

export function inspectOpenAiChatToolHistory(
  messages: unknown,
  options?: {
    allowDanglingToolCalls?: boolean;
  }
): ToolHistoryContractViolation | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }
  const seenToolCalls = new Set<string>();
  const pendingToolCalls = new Map<string, { index: number; role: string; itemType: string }>();
  for (const [index, rawMessage] of messages.entries()) {
    if (!rawMessage || typeof rawMessage !== 'object' || Array.isArray(rawMessage)) {
      continue;
    }
    const message = rawMessage as Record<string, unknown>;
    const role = readTrimmedString(message.role)?.toLowerCase();
    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      const violation = inspectAssistantToolCallEntries(message.tool_calls, {
        index,
        role,
        itemType: 'tool_call',
        pendingToolCalls,
        seenToolCalls,
        missingIdReason: 'assistant tool_call is missing id/call_id',
        syntheticIdReason: (callId) =>
          `assistant tool_call uses synthetic RouteCodex fallback id: ${callId}`
      });
      if (violation) {
        return violation;
      }
      continue;
    }
    if (role !== 'tool') {
      continue;
    }
    const callId =
      readTrimmedString(message.tool_call_id)
      ?? readTrimmedString(message.call_id)
      ?? readTrimmedString(message.id);
    if (!callId) {
      return {
        code: 'missing_tool_call_id',
        index,
        role,
        itemType: 'tool_result',
        reason: 'tool message is missing tool_call_id/call_id'
      };
    }
    if (isSyntheticRouteCodexToolCallId(callId)) {
      return {
        code: 'synthetic_tool_call_id',
        index,
        callId,
        role,
        itemType: 'tool_result',
        reason: `tool message uses synthetic RouteCodex fallback id: ${callId}`
      };
    }
    if (!seenToolCalls.has(callId) || !pendingToolCalls.has(callId)) {
      return {
        code: 'orphan_tool_result',
        index,
        callId,
        role,
        itemType: 'tool_result',
        reason: `tool message references unknown or already-consumed tool_call_id: ${callId}`
      };
    }
    pendingToolCalls.delete(callId);
  }
  return finalizePendingToolCalls(pendingToolCalls, {
    allowDanglingToolCalls: options?.allowDanglingToolCalls === true,
    allowTerminalPendingSuffix: isChatTerminalPendingSuffix(
      messages as Array<Record<string, unknown>>,
      pendingToolCalls
    )
  });
}

export function inspectBridgeInputToolHistory(
  input: unknown,
  options?: {
    allowDanglingToolCalls?: boolean;
    allowOutputOnlyResumeBatches?: boolean;
  }
): ToolHistoryContractViolation | null {
  if (!Array.isArray(input) || input.length === 0) {
    return null;
  }
  const seenToolCalls = new Set<string>();
  const pendingToolCalls = new Map<string, { index: number; role: string; itemType: string }>();
  const futureToolCalls = collectBridgeInputFutureToolCallCounts(input as Array<Record<string, unknown>>);
  const deferredToolResults = new Map<string, Array<{ index: number; role: string; itemType: string }>>();
  const sawAnyToolCalls = futureToolCalls.size > 0;
  for (const [index, rawEntry] of input.entries()) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      continue;
    }
    const entry = rawEntry as Record<string, unknown>;
    const itemType = readTrimmedString(entry.type)?.toLowerCase();
    const role = readTrimmedString(entry.role)?.toLowerCase();
    if (itemType === 'message' && role === 'assistant' && Array.isArray(entry.tool_calls)) {
      const violation = inspectAssistantToolCallEntries(entry.tool_calls, {
        index,
        role,
        itemType,
        pendingToolCalls,
        seenToolCalls,
        missingIdReason: 'bridge assistant message tool_call is missing id/call_id',
        syntheticIdReason: (callId) =>
          `bridge assistant message tool_call uses synthetic RouteCodex fallback id: ${callId}`,
        onValidatedCallId: (callId) => {
          decrementFutureToolCallCount(futureToolCalls, callId);
          const deferred = deferredToolResults.get(callId);
          if (deferred?.length) {
            deferred.shift();
            if (!deferred.length) {
              deferredToolResults.delete(callId);
            }
            return 'preconsumed';
          }
          return 'pending';
        }
      });
      if (violation) {
        return violation;
      }
      continue;
    }
    if (itemType === 'function_call') {
      const callId =
        readTrimmedString(entry.call_id)
        ?? readTrimmedString(entry.tool_call_id)
        ?? readTrimmedString(entry.id);
      if (!callId) {
        return {
          code: 'missing_tool_call_id',
          index,
          role: role ?? 'assistant',
          itemType,
          reason: 'bridge function_call item is missing call_id/id'
        };
      }
      if (isSyntheticRouteCodexToolCallId(callId)) {
        return {
          code: 'synthetic_tool_call_id',
          index,
          callId,
          role: role ?? 'assistant',
          itemType,
          reason: `bridge function_call item uses synthetic RouteCodex fallback id: ${callId}`
        };
      }
      decrementFutureToolCallCount(futureToolCalls, callId);
      seenToolCalls.add(callId);
      const deferred = deferredToolResults.get(callId);
      if (deferred?.length) {
        deferred.shift();
        if (!deferred.length) {
          deferredToolResults.delete(callId);
        }
        continue;
      }
      pendingToolCalls.set(callId, {
        index,
        role: role ?? 'assistant',
        itemType
      });
      continue;
    }
    if (
      itemType === 'function_call_output'
      || itemType === 'tool_result'
      || itemType === 'tool_message'
      || (itemType === 'message' && role === 'tool')
    ) {
      const callId =
        readTrimmedString(entry.call_id)
        ?? readTrimmedString(entry.tool_call_id)
        ?? readTrimmedString(entry.tool_use_id)
        ?? readTrimmedString(entry.id);
      if (!callId) {
        return {
          code: 'missing_tool_call_id',
          index,
          role: role ?? 'tool',
          itemType: itemType ?? 'tool_result',
          reason: 'bridge tool result item is missing call_id/tool_call_id'
        };
      }
      if (isSyntheticRouteCodexToolCallId(callId)) {
        return {
          code: 'synthetic_tool_call_id',
          index,
          callId,
          role: role ?? 'tool',
          itemType: itemType ?? 'tool_result',
          reason: `bridge tool result item uses synthetic RouteCodex fallback id: ${callId}`
        };
      }
      if (pendingToolCalls.has(callId)) {
        pendingToolCalls.delete(callId);
        continue;
      }
      if (!sawAnyToolCalls && options?.allowOutputOnlyResumeBatches === true) {
        continue;
      }
      if ((futureToolCalls.get(callId) ?? 0) > 0) {
        const queue = deferredToolResults.get(callId) ?? [];
        queue.push({
          index,
          role: role ?? 'tool',
          itemType: itemType ?? 'tool_result'
        });
        deferredToolResults.set(callId, queue);
        continue;
      }
      if (!seenToolCalls.has(callId)) {
        return {
          code: 'orphan_tool_result',
          index,
          callId,
          role: role ?? 'tool',
          itemType: itemType ?? 'tool_result',
          reason: `bridge tool result item references unknown or already-consumed call_id: ${callId}`
        };
      }
      return {
        code: 'orphan_tool_result',
        index,
        callId,
        role: role ?? 'tool',
        itemType: itemType ?? 'tool_result',
        reason: `bridge tool result item references unknown or already-consumed call_id: ${callId}`
      };
    }
  }
  const firstDeferred = Array.from(deferredToolResults.values())
    .flat()
    .sort((a, b) => a.index - b.index)[0];
  if (firstDeferred) {
    const deferredCallId = Array.from(deferredToolResults.entries()).find(([, entries]) =>
      entries.includes(firstDeferred)
    )?.[0];
    return {
      code: 'orphan_tool_result',
      index: firstDeferred.index,
      callId: deferredCallId,
      role: firstDeferred.role,
      itemType: firstDeferred.itemType,
      reason: `bridge tool result item references unknown or already-consumed call_id: ${deferredCallId ?? 'unknown'}`
    };
  }
  return finalizePendingToolCalls(pendingToolCalls, {
    allowDanglingToolCalls: options?.allowDanglingToolCalls === true,
    allowTerminalPendingSuffix: isBridgeInputTerminalPendingSuffix(
      input as Array<Record<string, unknown>>,
      pendingToolCalls
    )
  });
}
