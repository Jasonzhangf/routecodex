import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext
} from './types.js';
import type { JsonObject } from '../conversion/hub/types/json.js';
import { runServertoolResponseStageAutoHookPass } from './response-stage-auto-hook-shell.js';

export async function finalizeServertoolResponseStage(args: {
  options: ServerSideToolEngineOptions;
  baseObject: JsonObject;
  contextBase: ServerToolHandlerContext;
  includeAutoHookIds: Set<string> | null;
  excludeAutoHookIds: Set<string> | null;
  responseStageGatePlan: Record<string, unknown>;
}): Promise<ServerSideToolEngineResult> {
  const responseStageAutoHook = await runServertoolResponseStageAutoHookPass({
    options: args.options,
    contextBase: args.contextBase,
    includeAutoHookIds: args.includeAutoHookIds,
    excludeAutoHookIds: args.excludeAutoHookIds,
    responseStageGatePlan: args.responseStageGatePlan
  });
  if (responseStageAutoHook.action === 'return_passthrough_bypass') {
    return { mode: 'passthrough', finalChatResponse: args.baseObject };
  }
  if (responseStageAutoHook.action === 'return_auto_hook_result') {
    return responseStageAutoHook.result;
  }
  return { mode: 'passthrough', finalChatResponse: args.baseObject };
}
