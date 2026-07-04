import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext
} from './types.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { runServertoolResponseStageAutoHookPass } from './response-stage-auto-hook-shell.js';
import { finalizeServertoolResponseStageWithNative } from 'rcc-llmswitch-core/native/servertool-wrapper';
import type { NativeServertoolResponseStageGate } from 'rcc-llmswitch-core/native/servertool-wrapper';

export async function finalizeServertoolResponseStage(args: {
  options: ServerSideToolEngineOptions;
  baseObject: JsonObject;
  contextBase: Omit<ServerToolHandlerContext, 'toolCall'>;
  includeAutoHookIds: Set<string> | null;
  excludeAutoHookIds: Set<string> | null;
  responseStageGatePlan: NativeServertoolResponseStageGate;
}): Promise<ServerSideToolEngineResult> {
  const responseStageAutoHook = await runServertoolResponseStageAutoHookPass({
    options: args.options,
    contextBase: args.contextBase,
    includeAutoHookIds: args.includeAutoHookIds,
    excludeAutoHookIds: args.excludeAutoHookIds,
    responseStageGatePlan: args.responseStageGatePlan,
    baseObject: args.baseObject
  });
  return finalizeServertoolResponseStageWithNative({
    responseStageGatePlan: args.responseStageGatePlan,
    baseObject: args.baseObject,
    responseStageAutoHookResult: responseStageAutoHook
  });
}
