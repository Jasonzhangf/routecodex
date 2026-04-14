import type { JsonObject } from '../conversion/hub/types/json.js';

function collectExecutedServerToolCallIds(payload: JsonObject): Set<string> {
  const ids = new Set<string>();
  const toolOutputs = Array.isArray((payload as any).tool_outputs) ? (payload as any).tool_outputs : [];
  for (const entry of toolOutputs) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof (entry as any).name === 'string' ? String((entry as any).name).trim() : '';
    const toolCallId = typeof (entry as any).tool_call_id === 'string' ? String((entry as any).tool_call_id).trim() : '';
    if (!name || !toolCallId) continue;
    // tool_outputs at this stage are emitted by executed servertool handlers.
    // Strip every executed servertool call id so client remap only sees client-declared tools.
    ids.add(toolCallId);
  }
  return ids;
}

function filterToolCallsInMessage(message: Record<string, unknown>, executedIds: Set<string>): void {
  const toolCalls = Array.isArray((message as any).tool_calls) ? (message as any).tool_calls : [];
  if (!toolCalls.length) return;
  const next = toolCalls.filter((tc: unknown) => {
    if (!tc || typeof tc !== 'object' || Array.isArray(tc)) return true;
    const id = typeof (tc as any).id === 'string' ? String((tc as any).id).trim() : '';
    if (!id) return true;
    return !executedIds.has(id);
  });
  (message as any).tool_calls = next;
}

function stripFromChoices(payload: JsonObject, executedIds: Set<string>): void {
  const choices = Array.isArray((payload as any).choices) ? (payload as any).choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) continue;
    const message = (choice as any).message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    filterToolCallsInMessage(message as Record<string, unknown>, executedIds);
  }
}

function stripFromMessages(payload: JsonObject, executedIds: Set<string>): void {
  const messages = Array.isArray((payload as any).messages) ? (payload as any).messages : [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) continue;
    const role = (msg as any).role;
    if (role !== 'assistant') continue;
    filterToolCallsInMessage(msg as Record<string, unknown>, executedIds);
  }
}

export function filterOutExecutedServerToolCalls(
  finalizedPayload: JsonObject,
  orchestrationPayload: JsonObject
): JsonObject {
  const executedIds = collectExecutedServerToolCallIds(orchestrationPayload);
  if (executedIds.size === 0) return finalizedPayload;
  const cloned = JSON.parse(JSON.stringify(finalizedPayload)) as JsonObject;
  stripFromChoices(cloned, executedIds);
  stripFromMessages(cloned, executedIds);
  // If tool_calls are removed, ensure finish_reason/content consistency for chat choices.
  const choices = Array.isArray((cloned as any).choices) ? (cloned as any).choices : [];
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) continue;
    const message = (choice as any).message;
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const toolCalls = Array.isArray((message as any).tool_calls) ? (message as any).tool_calls : [];
    if (toolCalls.length === 0 && (choice as any).finish_reason === 'tool_calls') {
      (choice as any).finish_reason = 'stop';
    }
  }
  return cloned;
}
