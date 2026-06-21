import type { JsonObject } from '../conversion/hub/types/json.js';
import { buildServertoolAutoHookQueueConfig } from './skeleton-config.js';
import {
  planServertoolAutoHookQueuesWithNative,
  runServertoolOrchestrationMutationWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import { planServertoolHookScheduleWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';
import type { ToolCall } from './types.js';

function normalizeServerToolCallName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (normalized === 'websearch' || normalized === 'web-search') {
    return 'web_search';
  }
  return normalized;
}

function replaceJsonObjectInPlaceInternal(target: JsonObject, next: JsonObject): void {
  const newKeys = new Set(Object.keys(next));
  for (const [key, value] of Object.entries(next)) {
    (target as Record<string, unknown>)[key] = value;
  }
  for (const key of Object.keys(target)) {
    if (!newKeys.has(key)) {
      delete (target as Record<string, unknown>)[key];
    }
  }
}

function nativeRecord(input: Record<string, unknown>): JsonObject {
  const output = runServertoolOrchestrationMutationWithNative(input);
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    throw new Error('[servertool] orchestration mutation returned invalid object');
  }
  return output as JsonObject;
}

function nativeArray(input: Record<string, unknown>): JsonObject[] {
  const output = runServertoolOrchestrationMutationWithNative(input);
  if (!Array.isArray(output)) {
    throw new Error('[servertool] orchestration mutation returned invalid array');
  }
  return output.filter((entry): entry is JsonObject => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)));
}

function scheduleAutoHookQueueWithNative<THook extends {
  id: string;
  phase: string;
  priority: number;
  order: number;
}>(hooks: THook[], requiredness: 'required' | 'optional'): THook[] {
  if (hooks.length <= 1) {
    return hooks;
  }
  const plan = planServertoolHookScheduleWithNative({
    direction: 'response',
    respPhase: 'servertoolRespHook01Intercepted',
    hooks: hooks.map((hook) => ({
      id: hook.id,
      direction: 'response',
      respPhase: 'servertoolRespHook01Intercepted',
      requiredness,
      priority: hook.priority,
      order: hook.order,
      ownerFeatureId: 'binding pending',
      inputNode: 'HubRespChatProcess03Governed',
      outputNode: 'ServertoolRespHook01Intercepted',
      effectKind: `auto_hook:${normalizeServerToolCallName(hook.id)}:${requiredness}`,
      enabled: true
    })),
    requireAtLeastOneRequiredHook: false
  });
  const hookById = new Map(hooks.map((hook) => [normalizeServerToolCallName(hook.id), hook] as const));
  const scheduled = plan.projection.hookIds
    .map((id) => hookById.get(normalizeServerToolCallName(id)))
    .filter((hook): hook is THook => Boolean(hook));
  return scheduled.length === hooks.length ? scheduled : hooks;
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
    optionalQueue: scheduleAutoHookQueueWithNative(mapQueue(nativePlan.optionalQueue), 'optional'),
    mandatoryQueue: scheduleAutoHookQueueWithNative(mapQueue(nativePlan.mandatoryQueue), 'required')
  };
}

export function buildAssistantToolCallMessage(toolCalls: ToolCall[]): JsonObject {
  return nativeRecord({ op: 'build_assistant_tool_call_message', toolCalls });
}

export function appendToolOutput(base: JsonObject, toolCallId: string, name: string, content: string): void {
  replaceJsonObjectInPlaceInternal(base, nativeRecord({ op: 'append_tool_output', base, toolCallId, name, content }));
}

export function buildToolMessagesFromOutputs(base: JsonObject, allowIds: Set<string>): JsonObject[] {
  return nativeArray({ op: 'build_tool_messages_from_outputs', base, allowIds: [...allowIds] });
}

export function stripToolOutputs(base: JsonObject): void {
  replaceJsonObjectInPlaceInternal(base, nativeRecord({ op: 'strip_tool_outputs', base }));
}

export function replaceJsonObjectInPlace(target: JsonObject, next: JsonObject): void {
  replaceJsonObjectInPlaceInternal(target, next);
}

export function patchToolCallArgumentsById(
  chatResponse: JsonObject,
  toolCallId: string,
  argumentsText: string
): void {
  replaceJsonObjectInPlaceInternal(
    chatResponse,
    nativeRecord({ op: 'patch_tool_call_arguments_by_id', base: chatResponse, toolCallId, argumentsText })
  );
}

export function filterOutExecutedToolCalls(chatResponse: JsonObject, executedIds: Set<string>): void {
  replaceJsonObjectInPlaceInternal(
    chatResponse,
    nativeRecord({ op: 'filter_out_executed_tool_calls', base: chatResponse, executedIds: [...executedIds] })
  );
}
