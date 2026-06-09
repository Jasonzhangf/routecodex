import type { ServerSideToolEngineOptions, ServerSideToolEngineResult } from './types.js';
import { buildServertoolAutoHookQueueConfig } from './skeleton-config.js';
import {
  planEngineSelectionAfterRunWithNative,
  planEngineSelectionStartWithNative,
  type EngineSelectionOverridesPlan
} from '../native/router-hotpath/native-servertool-core-semantics.js';

export const SERVERTOOL_ENGINE_SELECTION_FEATURE_ID = 'feature_id: hub.servertool_engine_selection';

type ServerToolEngineRunner = (
  overrides: Partial<ServerSideToolEngineOptions>
) => Promise<ServerSideToolEngineResult>;

export async function runPrimaryServerToolEngineSelection(args: {
  runEngine: ServerToolEngineRunner;
}): Promise<ServerSideToolEngineResult> {
  const startPlan = planEngineSelectionStartWithNative({
    primaryAutoHookIds: buildServertoolAutoHookQueueConfig().optionalPrimaryOrder
  });
  const engineResult = await args.runEngine(toEngineOverrides(startPlan.overrides));
  const afterRunPlan = planEngineSelectionAfterRunWithNative({
    primaryAutoHookIds: startPlan.primaryAutoHookIds,
    engineResult
  });
  if (afterRunPlan.action === 'rerun_excluding_primary_hooks') {
    return await args.runEngine(toEngineOverrides(afterRunPlan.overrides ?? {}));
  }
  return engineResult;
}

function toEngineOverrides(plan: EngineSelectionOverridesPlan): Partial<ServerSideToolEngineOptions> {
  return {
    ...(typeof plan.disableToolCallHandlers === 'boolean'
      ? { disableToolCallHandlers: plan.disableToolCallHandlers }
      : {}),
    ...(Array.isArray(plan.includeAutoHookIds) ? { includeAutoHookIds: plan.includeAutoHookIds } : {}),
    ...(Array.isArray(plan.excludeAutoHookIds) ? { excludeAutoHookIds: plan.excludeAutoHookIds } : {})
  };
}
