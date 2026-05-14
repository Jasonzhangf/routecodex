import type { ServerSideToolEngineOptions, ServerSideToolEngineResult } from './types.js';

type ServerToolEngineRunner = (
  overrides: Partial<ServerSideToolEngineOptions>
) => Promise<ServerSideToolEngineResult>;

export async function runPrimaryServerToolEngineSelection(args: {
  runEngine: ServerToolEngineRunner;
}): Promise<ServerSideToolEngineResult> {
  let engineResult = await args.runEngine({
    disableToolCallHandlers: true,
    includeAutoHookIds: ['stop_message_auto']
  });
  if (engineResult.mode === 'passthrough' || !engineResult.execution) {
    engineResult = await args.runEngine({
      excludeAutoHookIds: ['stop_message_auto']
    });
  }
  return engineResult;
}
