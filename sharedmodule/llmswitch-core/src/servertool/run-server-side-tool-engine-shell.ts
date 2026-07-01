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
import { planServertoolEnginePrepassActionWithNative } from '../native/router-hotpath/native-servertool-core-semantics.js';

export async function orchestrateServertoolEngine(
  options: ServerSideToolEngineOptions
): Promise<ServerSideToolEngineResult> {
  const entryPreflight = runServertoolEntryPreflight({ options });
  switch (entryPreflight.action) {
    case 'return_result':
      return entryPreflight.result;
    case 'continue':
      break;
    default:
      throw new Error('[servertool] invalid entry preflight result action');
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
  const responseStagePrePass = await runServertoolResponseStagePrePass({
    options,
    baseObject: entryContext.baseObject,
    contextBase: entryContext.contextBase as ServerToolHandlerContext,
    includeAutoHookIds: entryContext.includeAutoHookIds,
    excludeAutoHookIds: entryContext.excludeAutoHookIds
  });
  const prepassResult = 'result' in responseStagePrePass ? responseStagePrePass.result : null;
  const enginePrepassAction = planServertoolEnginePrepassActionWithNative({
    hasPrepassResult: prepassResult != null
  });
  switch (enginePrepassAction.action) {
    case 'return_prepass_result':
      if (prepassResult == null) {
        throw new Error('[servertool] native engine prepass requested result but prepass result was empty');
      }
      return prepassResult;
    case 'continue_to_execution':
      break;
    default:
      throw new Error('[servertool] invalid engine prepass action');
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
