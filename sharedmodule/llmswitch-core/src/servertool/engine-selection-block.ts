import type { ServerSideToolEngineOptions, ServerSideToolEngineResult } from './types.js';
import { readServertoolPrimaryAutoHookIdsWithNative } from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';
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
    primaryAutoHookIds: readServertoolPrimaryAutoHookIdsWithNative()
  });
  const engineResult = await args.runEngine(startPlan.overrides);
  const afterRunPlan = planEngineSelectionAfterRunWithNative({
    primaryAutoHookIds: startPlan.primaryAutoHookIds,
    engineResult
  });
  switch (afterRunPlan.action) {
    case 'rerun_excluding_primary_hooks':
      return await args.runEngine(afterRunPlan.overrides);
    case 'return_current':
      return engineResult;
    default:
      throw new Error('[servertool] invalid engine selection action');
  }
}
