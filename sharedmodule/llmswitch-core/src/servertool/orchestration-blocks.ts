import type { JsonObject } from '../conversion/hub/types/json.js';
import {
  planServertoolSkeletonDerivedConfigWithNative,
  planServertoolAutoHookQueuesWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';

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

export function replaceJsonObjectInPlace(target: JsonObject, next: JsonObject): void {
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
