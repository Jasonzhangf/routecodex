import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  planServertoolSkeletonDerivedConfigWithNative,
  planServertoolAutoHookQueuesWithNative,
  runServertoolOrchestrationMutationWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import type { ToolCall } from './types.js';

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
  return output.map((entry, index): JsonObject => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`[servertool] orchestration mutation returned invalid array entry at index ${index}`);
    }
    return entry as JsonObject;
  });
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
  const queueConfig = planServertoolSkeletonDerivedConfigWithNative().autoHookQueueConfig as {
    optionalPrimaryOrder: string[];
    mandatoryOrder: string[];
  };
  const nativePlan = planServertoolAutoHookQueuesWithNative({
    hooks: args.hooks.map((hook, sourceIndex) => ({
      id: hook.id,
      phase: hook.phase,
      priority: hook.priority,
      order: hook.order,
      sourceIndex
    })),
    ...(args.includeAutoHookIds ? { includeAutoHookIds: [...args.includeAutoHookIds] } : {}),
    ...(args.excludeAutoHookIds ? { excludeAutoHookIds: [...args.excludeAutoHookIds] } : {}),
    optionalPrimaryHookOrder: queueConfig.optionalPrimaryOrder,
    mandatoryHookOrder: queueConfig.mandatoryOrder
  });
  const mapQueue = (entries: Array<{ sourceIndex: number }>): THook[] =>
    entries
      .map((entry) => args.hooks[entry.sourceIndex])
      .filter((hook): hook is THook => Boolean(hook));
  return {
    optionalQueue: mapQueue(nativePlan.optionalQueue),
    mandatoryQueue: mapQueue(nativePlan.mandatoryQueue)
  };
}

export function buildAssistantToolCallMessage(toolCalls: ToolCall[]): JsonObject {
  return nativeRecord({ op: 'build_assistant_tool_call_message', toolCalls });
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
