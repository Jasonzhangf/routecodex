import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext
} from './types.js';
import { extractToolCallsFromResponseStage } from './extract-tool-calls-shell.js';
import { runServertoolEntryPreflight } from './entry-preflight-shell.js';
import { runServertoolResponseStagePrePass } from './response-stage-prepass-shell.js';
import { runServertoolExecutionStage } from './execution-stage-shell.js';
import { resolveServertoolEntryContext } from './entry-context-shell.js';

export async function orchestrateServertoolEngine(
  options: ServerSideToolEngineOptions
): Promise<ServerSideToolEngineResult> {
  const entryPreflight = runServertoolEntryPreflight({ options });
  const entryPreflightAction = entryPreflight.action;
  switch (entryPreflightAction) {
    case 'return_result':
      return entryPreflight.result;
    case 'continue':
      break;
    default:
      throw new Error(`[servertool] invalid entry preflight result action: ${String(entryPreflightAction)}`);
  }
  const toolCalls = extractToolCallsFromResponseStage(
    entryPreflight.baseObject,
    options.requestId
  );
  const entryContext = resolveServertoolEntryContext({
    options,
    toolCalls,
    base: entryPreflight.baseObject
  });
  const entryContextAction = entryContext.action;
  switch (entryContextAction) {
    case 'continue':
      break;
    case 'return_non_object_base':
      return { mode: 'passthrough', finalChatResponse: options.chatResponse };
    default:
      throw new Error(`[servertool] invalid entry context action: ${String(entryContextAction)}`);
  }
  const responseStagePrePass = await runServertoolResponseStagePrePass({
    options,
    baseObject: entryContext.baseObject,
    contextBase: entryContext.contextBase as ServerToolHandlerContext,
    includeAutoHookIds: entryContext.includeAutoHookIds,
    excludeAutoHookIds: entryContext.excludeAutoHookIds
  });
  const responseStagePrePassAction = responseStagePrePass.action;
  switch (responseStagePrePassAction) {
    case 'return_result':
      return responseStagePrePass.result;
    case 'continue_to_execution':
      break;
    default:
      throw new Error(`[servertool] invalid response-stage prepass action: ${String(responseStagePrePassAction)}`);
  }
  return runServertoolExecutionStage({
    options,
    baseObject: entryContext.baseObject,
    toolCalls,
    contextBase: entryContext.contextBase,
    includeToolCallNames: entryContext.includeToolCallNames,
    excludeToolCallNames: entryContext.excludeToolCallNames,
    includeAutoHookIds: entryContext.includeAutoHookIds,
    excludeAutoHookIds: entryContext.excludeAutoHookIds,
    responseStageGatePlan: responseStagePrePass.responseStageGatePlan
  });
}
