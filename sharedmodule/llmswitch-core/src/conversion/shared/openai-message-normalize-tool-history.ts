import {
  readTrimmedString,
  type ToolHistoryContractViolation
} from './openai-message-normalize-contract.js';

function buildMissingToolCallIdViolation(
  index: number,
  role: string,
  itemType: string,
  reason: string
): ToolHistoryContractViolation {
  return {
    code: 'missing_tool_call_id',
    index,
    role,
    itemType,
    reason
  };
}

function validateAssistantToolCallsShape(
  toolCalls: unknown,
  index: number,
  role: string,
  itemType: string,
  reasonPrefix: string
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
      readTrimmedString(toolCall.id) ??
      readTrimmedString(toolCall.call_id) ??
      readTrimmedString(toolCall.tool_call_id);
    if (!callId) {
      return buildMissingToolCallIdViolation(
        index,
        role,
        itemType,
        `${reasonPrefix} tool_call is missing id/call_id`
      );
    }
  }
  return null;
}

function validateToolResultShape(
  entry: Record<string, unknown>,
  index: number,
  role: string,
  itemType: string,
  reasonPrefix: string
): ToolHistoryContractViolation | null {
  const callId =
    readTrimmedString(entry.call_id) ??
    readTrimmedString(entry.tool_call_id) ??
    readTrimmedString(entry.tool_use_id) ??
    readTrimmedString(entry.id);
  if (!callId) {
    return buildMissingToolCallIdViolation(
      index,
      role,
      itemType,
      `${reasonPrefix} tool_result is missing call_id/tool_call_id`
    );
  }
  return null;
}

export function inspectOpenAiChatToolHistory(
  messages: unknown,
  _options?: {
    allowDanglingToolCalls?: boolean;
  }
): ToolHistoryContractViolation | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }
  for (const [index, rawMessage] of messages.entries()) {
    if (!rawMessage || typeof rawMessage !== 'object' || Array.isArray(rawMessage)) {
      continue;
    }
    const message = rawMessage as Record<string, unknown>;
    const role = readTrimmedString(message.role)?.toLowerCase();
    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      const violation = validateAssistantToolCallsShape(
        message.tool_calls,
        index,
        role,
        'tool_call',
        'assistant'
      );
      if (violation) {
        return violation;
      }
      continue;
    }
    if (role !== 'tool') {
      continue;
    }
    const violation = validateToolResultShape(message, index, role, 'tool_result', 'tool message');
    if (violation) {
      return violation;
    }
  }
  return null;
}

export function inspectBridgeInputToolHistory(
  input: unknown,
  _options?: {
    allowDanglingToolCalls?: boolean;
    allowOutputOnlyResumeBatches?: boolean;
  }
): ToolHistoryContractViolation | null {
  if (!Array.isArray(input) || input.length === 0) {
    return null;
  }
  for (const [index, rawEntry] of input.entries()) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      continue;
    }
    const entry = rawEntry as Record<string, unknown>;
    const itemType = readTrimmedString(entry.type)?.toLowerCase();
    const role = readTrimmedString(entry.role)?.toLowerCase();
    if (itemType === 'message' && role === 'assistant' && Array.isArray(entry.tool_calls)) {
      const violation = validateAssistantToolCallsShape(
        entry.tool_calls,
        index,
        role,
        itemType,
        'bridge assistant message'
      );
      if (violation) {
        return violation;
      }
      continue;
    }
    if (
      itemType === 'function_call'
      || itemType === 'function_call_output'
      || itemType === 'tool_result'
      || itemType === 'tool_message'
      || (itemType === 'message' && role === 'tool')
    ) {
      const callId =
        readTrimmedString(entry.call_id) ??
        readTrimmedString(entry.tool_call_id) ??
        readTrimmedString(entry.tool_use_id) ??
        readTrimmedString(entry.id);
      if (!callId) {
        return buildMissingToolCallIdViolation(
          index,
          role ?? 'tool',
          itemType ?? 'tool_result',
          'bridge tool item is missing call_id/tool_call_id'
        );
      }
    }
  }
  return null;
}
