import type { ServerSideToolEngineOptions, ServerSideToolEngineResult } from './types.js';
import { buildServertoolAutoHookQueueConfig } from './skeleton-config.js';

type ServerToolEngineRunner = (
  overrides: Partial<ServerSideToolEngineOptions>
) => Promise<ServerSideToolEngineResult>;

export async function runPrimaryServerToolEngineSelection(args: {
  runEngine: ServerToolEngineRunner;
}): Promise<ServerSideToolEngineResult> {
  const primaryAutoHookIds = buildServertoolAutoHookQueueConfig().optionalPrimaryOrder;
  if (primaryAutoHookIds.length < 1) {
    return await args.runEngine({});
  }
  let engineResult = await args.runEngine({
    disableToolCallHandlers: true,
    includeAutoHookIds: primaryAutoHookIds
  });
  if (engineResult.mode === 'passthrough' || !engineResult.execution) {
    engineResult = await args.runEngine({
      excludeAutoHookIds: primaryAutoHookIds
    });
  }
  return engineResult;
}
