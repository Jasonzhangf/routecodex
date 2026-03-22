import type {
  ChatEnvelope,
  ChatMessage,
  ChatToolCall,
  ChatToolOutput,
  MissingField
} from '../../types/chat-envelope.js';
import { type JsonObject, type JsonValue } from '../../types/json.js';

export function normalizeToolOutputs(
  messages: ChatEnvelope['messages'],
  missing: MissingField[]
): ChatToolOutput[] | undefined {
  const outputs: ChatToolOutput[] = [];
  messages.forEach((msg, index) => {
    if (msg.role !== 'tool') return;
    const callId = (msg as JsonObject).tool_call_id || (msg as JsonObject).id;
    if (typeof callId !== 'string' || !callId.trim()) {
      missing.push({ path: `messages[${index}].tool_call_id`, reason: 'missing_tool_call_id' });
      return;
    }
    outputs.push({
      tool_call_id: callId.trim(),
      content: normalizeToolContent((msg as JsonObject).content),
      name: typeof msg.name === 'string' ? msg.name : undefined
    });
  });
  return outputs.length ? outputs : undefined;
}

export function synthesizeToolOutputsFromMessages(messages: ChatMessage[] | undefined): ChatToolOutput[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  const outputs: ChatToolOutput[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    if (message.role !== 'assistant') continue;
    const toolCalls = Array.isArray((message as JsonObject).tool_calls)
      ? ((message as JsonObject).tool_calls as ChatToolCall[])
      : [];
    for (const call of toolCalls) {
      if (!call || typeof call !== 'object') {
        continue;
      }
      const callId = typeof call.id === 'string' ? call.id : undefined;
      if (!callId) {
        continue;
      }
      const existing = outputs.find((entry) => entry.tool_call_id === callId);
      if (existing) {
        continue;
      }
      outputs.push({
        tool_call_id: callId,
        content: '',
        name: (call.function && call.function.name) || undefined
      });
    }
  }
  return outputs;
}

export function normalizeToolContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? '');
  }
}

export function convertToolMessageToOutput(message: JsonObject, allowedIds?: Set<string>): ChatToolOutput | null {
  const rawId = (message.tool_call_id ?? message.id) as JsonValue;
  const callId = typeof rawId === 'string' && rawId.trim().length ? rawId.trim() : undefined;
  if (!callId) {
    return null;
  }
  if (allowedIds && !allowedIds.has(callId)) {
    return null;
  }
  return {
    tool_call_id: callId,
    content: normalizeToolContent(message.content),
    name: typeof message.name === 'string' ? message.name : undefined
  };
}

export function sanitizeAntigravityToolCallId(raw: string): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    return trimmed;
  }
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    return trimmed;
  }
  const sanitized = trimmed
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '');
  return sanitized || `call_${Math.random().toString(36).slice(2, 10)}`;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function ensureFunctionResponsePayload(value: JsonValue): JsonValue {
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) {
      return {
        result: value
      } as JsonObject;
    }
    return value;
  }
  return {
    result: value === undefined ? null : value
  } as JsonObject;
}

export function cloneAsJsonValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
  } catch {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      return value as JsonValue;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => cloneAsJsonValue(entry)) as JsonValue;
    }
    if (value && typeof value === 'object') {
      const out: JsonObject = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = cloneAsJsonValue(entry);
      }
      return out;
    }
    return String(value ?? '') as JsonValue;
  }
}

export function buildFunctionResponseEntry(output: ChatToolOutput, options?: { includeCallId?: boolean }): JsonObject {
  const parsedPayload = safeParseJson(output.content);
  const normalizedPayload = ensureFunctionResponsePayload(cloneAsJsonValue(parsedPayload));
  const includeCallId = options?.includeCallId === true;
  const part: JsonObject = {
    functionResponse: {
      name: output.name || 'tool',
      response: normalizedPayload
    }
  };
  if (includeCallId) {
    (part.functionResponse as JsonObject).id = sanitizeAntigravityToolCallId(output.tool_call_id);
  }
  return { role: 'user', parts: [part] };
}
