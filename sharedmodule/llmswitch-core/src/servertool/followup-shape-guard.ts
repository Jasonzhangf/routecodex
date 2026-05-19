import type { JsonObject } from '../conversion/hub/types/json.js';

export type FollowupShapeViolation = {
  code: 'RESPONSES_FOLLOWUP_MESSAGES_ONLY';
  reason: string;
};

export function validateServertoolFollowupPayloadShape(args: {
  entryEndpoint: string;
  payload: JsonObject | null | undefined;
}): { ok: true } | { ok: false; violation: FollowupShapeViolation } {
  const endpoint = String(args.entryEndpoint || '').toLowerCase();
  const payload = args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload)
    ? (args.payload as Record<string, unknown>)
    : undefined;

  if (!endpoint.includes('/v1/responses')) {
    return { ok: true };
  }

  const hasInput = Array.isArray(payload?.input);
  const hasMessages = Array.isArray(payload?.messages);

  if (!hasInput && hasMessages) {
    return {
      ok: false,
      violation: {
        code: 'RESPONSES_FOLLOWUP_MESSAGES_ONLY',
        reason: 'responses followup payload must use input shape; messages-only payload is illegal'
      }
    };
  }

  return { ok: true };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function toResponsesInputTextItem(text: string): Record<string, unknown> {
  return { type: 'input_text', text };
}

function parseToolCallArguments(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw;
  }
  if (raw === undefined || raw === null) {
    return '{}';
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return '{}';
  }
}

function coerceAssistantToolCallsToResponsesInputItems(message: Record<string, unknown>): Record<string, unknown>[] {
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const out: Record<string, unknown>[] = [];
  for (const entry of toolCalls) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : '';
    const fn = asRecord(record.function);
    const name =
      typeof fn?.name === 'string' && fn.name.trim()
        ? fn.name.trim()
        : (typeof record.name === 'string' && record.name.trim() ? record.name.trim() : '');
    if (!id || !name) {
      continue;
    }
    out.push({
      type: 'function_call',
      call_id: id,
      name,
      arguments: parseToolCallArguments(fn?.arguments)
    });
  }
  return out;
}

function coerceMessageToResponsesInputItems(message: Record<string, unknown>): Record<string, unknown>[] {
  const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
  const content = message.content;

  if (role === 'tool') {
    const callId =
      typeof message.tool_call_id === 'string' && message.tool_call_id.trim()
        ? message.tool_call_id.trim()
        : undefined;
    const output =
      typeof content === 'string'
        ? content
        : content === undefined
          ? ''
          : JSON.stringify(content);
    if (!callId) {
      return [{
        role: 'user',
        content: [toResponsesInputTextItem(output)]
      }];
    }
    return [{
      type: 'function_call_output',
      call_id: callId,
      output
    }];
  }

  if (role === 'assistant') {
    const toolCallItems = coerceAssistantToolCallsToResponsesInputItems(message);
    if (toolCallItems.length > 0) {
      return toolCallItems;
    }
  }

  if (Array.isArray(content)) {
    return [{
      role: role || 'user',
      content
    }];
  }

  const text =
    typeof content === 'string'
      ? content
      : content === undefined
        ? ''
        : JSON.stringify(content);
  return [{
    role: role || 'user',
    content: [toResponsesInputTextItem(text)]
  }];
}

export function normalizeServertoolFollowupPayloadShape(args: {
  entryEndpoint: string;
  payload: JsonObject | null | undefined;
}): JsonObject | null {
  const payload = asRecord(args.payload);
  if (!payload) {
    return null;
  }
  const endpoint = String(args.entryEndpoint || '').toLowerCase();
  if (!endpoint.includes('/v1/responses')) {
    return payload as JsonObject;
  }

  const hasInput = Array.isArray(payload.input);
  const messages = Array.isArray(payload.messages) ? payload.messages : undefined;
  if (hasInput || !messages) {
    return payload as JsonObject;
  }

  const seenToolOutputs = new Set<string>();
  const input = messages
    .flatMap((entry) => {
      const record = asRecord(entry);
      return record ? coerceMessageToResponsesInputItems(record) : [];
    })
    .filter((entry): entry is Record<string, unknown> => {
      if (!entry || typeof entry !== 'object') {
        return false;
      }
      const itemType = typeof entry.type === 'string' ? entry.type.trim().toLowerCase() : '';
      if (itemType !== 'function_call_output') {
        return true;
      }
      const callId = typeof entry.call_id === 'string' ? entry.call_id.trim() : '';
      if (!callId) {
        return false;
      }
      if (seenToolOutputs.has(callId)) {
        return false;
      }
      seenToolOutputs.add(callId);
      return true;
    });

  const next: Record<string, unknown> = {
    ...payload,
    input
  };
  delete next.messages;
  return next as JsonObject;
}
