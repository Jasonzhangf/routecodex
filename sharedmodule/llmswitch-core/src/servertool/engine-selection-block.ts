import type { ServerSideToolEngineOptions, ServerSideToolEngineResult } from './types.js';
import { readServertoolPrimaryAutoHookIdsWithNative } from 'rcc-llmswitch-core/native/servertool-wrapper';
import {
  planEngineSelectionStartWithNative,
  resolveEngineSelectionAfterRunWithNative,
} from 'rcc-llmswitch-core/native/servertool-wrapper';

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
  const afterRunDecision = resolveEngineSelectionAfterRunWithNative({
    primaryAutoHookIds: startPlan.primaryAutoHookIds,
    engineResult
  });
  if (afterRunDecision.rerunOverrides != null) {
    return await args.runEngine(afterRunDecision.rerunOverrides);
  }
  return engineResult;
}
