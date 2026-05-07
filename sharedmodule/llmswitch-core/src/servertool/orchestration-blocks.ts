import type { JsonObject, JsonValue } from '../conversion/hub/types/json.js';
import { buildServertoolAutoHookQueueConfig } from './skeleton-config.js';
import { planServertoolAutoHookQueuesWithNative } from '../router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';
import type { ServerToolFollowupInjectionOp, ToolCall } from './types.js';

function normalizeServerToolCallName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (normalized === 'websearch' || normalized === 'web-search') {
    return 'web_search';
  }
  if (normalized === 'reasoning_stop' || normalized === 'reasoning-stop') {
    return 'reasoning.stop';
  }
  return normalized;
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function getArray(value: unknown): JsonValue[] {
  return Array.isArray(value) ? (value as JsonValue[]) : [];
}

export function buildAutoHookQueuesFromConfig<THook extends {
  id: string;
  phase: string;
  priority: number;
  order: number;
}>(args: {
  hooks: THook[];
  includeAutoHookIds: Set<string> | null;
  excludeAutoHookIds: Set<string> | null;
}): {
  optionalQueue: THook[];
  mandatoryQueue: THook[];
} {
  const queueConfig = buildServertoolAutoHookQueueConfig();
  const hookById = new Map<string, THook>();
  for (const hook of args.hooks) {
    if (!hook || typeof hook.id !== 'string') {
      continue;
    }
    hookById.set(normalizeServerToolCallName(hook.id), hook);
  }
  const nativePlan = planServertoolAutoHookQueuesWithNative({
    hooks: args.hooks.map((hook) => ({
      id: hook.id,
      phase: hook.phase,
      priority: hook.priority,
      order: hook.order
    })),
    ...(args.includeAutoHookIds ? { includeAutoHookIds: [...args.includeAutoHookIds] } : {}),
    ...(args.excludeAutoHookIds ? { excludeAutoHookIds: [...args.excludeAutoHookIds] } : {}),
    optionalPrimaryHookOrder: queueConfig.optionalPrimaryOrder,
    mandatoryHookOrder: queueConfig.mandatoryOrder
  });
  const mapQueue = (entries: Array<{ id: string }>): THook[] =>
    entries
      .map((entry) => hookById.get(normalizeServerToolCallName(entry.id)))
      .filter((hook): hook is THook => Boolean(hook));
  return {
    optionalQueue: mapQueue(nativePlan.optionalQueue),
    mandatoryQueue: mapQueue(nativePlan.mandatoryQueue)
  };
}

export function buildAssistantToolCallMessage(toolCalls: ToolCall[]): JsonObject {
  const calls = toolCalls.map((toolCall) => ({
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments: toolCall.arguments
    }
  }));
  return { role: 'assistant', content: null, tool_calls: calls } as JsonObject;
}

export function appendToolOutput(base: JsonObject, toolCallId: string, name: string, content: string): void {
  const outputs = Array.isArray((base as any).tool_outputs) ? ((base as any).tool_outputs as any[]) : [];
  outputs.push({ tool_call_id: toolCallId, name, content });
  (base as any).tool_outputs = outputs;
}

export function buildToolMessagesFromOutputs(base: JsonObject, allowIds: Set<string>): JsonObject[] {
  const outputs = Array.isArray((base as any).tool_outputs) ? ((base as any).tool_outputs as any[]) : [];
  const out: JsonObject[] = [];
  for (const entry of outputs) {
    if (!entry || typeof entry !== 'object') continue;
    const toolCallId = typeof (entry as any).tool_call_id === 'string' ? String((entry as any).tool_call_id) : '';
    if (!toolCallId || !allowIds.has(toolCallId)) continue;
    const name =
      typeof (entry as any).name === 'string' && String((entry as any).name).trim()
        ? String((entry as any).name).trim()
        : 'tool';
    const content =
      typeof (entry as any).content === 'string'
        ? String((entry as any).content)
        : JSON.stringify((entry as any).content ?? {});
    out.push({ role: 'tool', tool_call_id: toolCallId, name, content } as JsonObject);
  }
  return out;
}

export function stripToolOutputs(base: JsonObject): void {
  try {
    delete (base as any).tool_outputs;
  } catch {
    // ignore
  }
}

export function replaceJsonObjectInPlace(target: JsonObject, next: JsonObject): void {
  const newKeys = new Set(Object.keys(next));
  for (const [key, value] of Object.entries(next)) {
    (target as any)[key] = value;
  }
  for (const key of Object.keys(target)) {
    if (!newKeys.has(key)) {
      delete (target as any)[key];
    }
  }
}

export function patchToolCallArgumentsById(
  chatResponse: JsonObject,
  toolCallId: string,
  argumentsText: string
): void {
  if (!toolCallId || typeof argumentsText !== 'string') {
    return;
  }
  const choices = getArray((chatResponse as any).choices);
  for (const choice of choices) {
    const choiceObj = asObject(choice);
    if (!choiceObj) continue;
    const message = asObject((choiceObj as any).message);
    if (!message) continue;
    const toolCalls = getArray((message as any).tool_calls);
    for (const toolCall of toolCalls) {
      const record = asObject(toolCall);
      if (!record) continue;
      const id = typeof (record as any).id === 'string' ? String((record as any).id).trim() : '';
      if (!id || id !== toolCallId) {
        continue;
      }
      const fn = asObject((record as any).function);
      if (fn) {
        (fn as any).arguments = argumentsText;
      }
      const fnCamel = asObject((record as any).functionCall);
      if (fnCamel) {
        (fnCamel as any).arguments = argumentsText;
      }
      const fnSnake = asObject((record as any).function_call);
      if (fnSnake) {
        (fnSnake as any).arguments = argumentsText;
      }
      if (Object.prototype.hasOwnProperty.call(record as any, 'arguments')) {
        (record as any).arguments = argumentsText;
      }
    }
  }
}

export function filterOutExecutedToolCalls(chatResponse: JsonObject, executedIds: Set<string>): void {
  const choices = getArray((chatResponse as any).choices);
  for (const choice of choices) {
    const choiceObj = asObject(choice);
    if (!choiceObj) continue;
    const message = asObject((choiceObj as any).message);
    if (!message) continue;
    const toolCalls = getArray((message as any).tool_calls);
    if (!toolCalls.length) continue;
    const next = toolCalls.filter((toolCall) => {
      if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) return true;
      const id = typeof (toolCall as any).id === 'string' ? String((toolCall as any).id).trim() : '';
      if (!id) return true;
      return !executedIds.has(id);
    });
    (message as any).tool_calls = next;
  }
}
