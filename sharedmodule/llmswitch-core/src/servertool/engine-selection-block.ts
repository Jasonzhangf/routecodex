import type { ServerSideToolEngineOptions, ServerSideToolEngineResult } from './types.js';
import { planServertoolSkeletonDerivedConfigWithNative } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
import {
  planEngineSelectionAfterRunWithNative,
  planEngineSelectionStartWithNative,
} from '../native/router-hotpath/native-servertool-core-semantics.js';

// feature_id: hub.servertool_engine_selection
type ServerToolEngineRunner = (
  overrides: Partial<ServerSideToolEngineOptions>
) => Promise<ServerSideToolEngineResult>;

export async function runPrimaryServerToolEngineSelection(args: {
  runEngine: ServerToolEngineRunner;
}): Promise<ServerSideToolEngineResult> {
  const startPlan = planEngineSelectionStartWithNative({
    primaryAutoHookIds: (planServertoolSkeletonDerivedConfigWithNative().autoHookQueueConfig as {
      optionalPrimaryOrder: string[];
    }).optionalPrimaryOrder
  });
  const engineResult = await args.runEngine(startPlan.overrides);
  const afterRunPlan = planEngineSelectionAfterRunWithNative({
    primaryAutoHookIds: startPlan.primaryAutoHookIds,
    engineResult
  });
  if (afterRunPlan.action === 'rerun_excluding_primary_hooks') {
    return await args.runEngine(afterRunPlan.overrides ?? {});
  }
  return engineResult;
}
