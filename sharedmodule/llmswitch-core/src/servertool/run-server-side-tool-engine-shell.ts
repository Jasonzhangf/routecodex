import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult
} from './types.js';
import { extractToolCallsFromResponseStage } from './extract-tool-calls-shell.js';
import { runServertoolEntryPreflight } from './entry-preflight-shell.js';
import { runServertoolResponseStagePrePass } from './response-stage-prepass-shell.js';
import { runServertoolExecutionStage } from './execution-stage-shell.js';
import { resolveServertoolEntryContext } from './entry-context-shell.js';
import {
  resolveServertoolRunEngineEntryPreflightApplicationWithNative,
  resolveServertoolRunEngineEntryPreflightDecisionWithNative,
  resolveServertoolRunEnginePrepassApplicationWithNative,
  resolveServertoolRunEnginePrepassDecisionWithNative
} from '../native/router-hotpath/native-servertool-core-semantics.js';

export async function orchestrateServertoolEngine(
  options: ServerSideToolEngineOptions
): Promise<ServerSideToolEngineResult> {
  const entryPreflight = runServertoolEntryPreflight({ options });
  const entryPreflightDecision = resolveServertoolRunEngineEntryPreflightDecisionWithNative({
    entryPreflight
  });
  const entryPreflightApplication = resolveServertoolRunEngineEntryPreflightApplicationWithNative({
    entryPreflight: entryPreflightDecision
  });
  if (entryPreflightApplication.returnResult === true) {
    return entryPreflightApplication.result;
  }
  const toolCalls = extractToolCallsFromResponseStage(
    entryPreflightApplication.baseObject,
    options.requestId
  );
  const entryContext = resolveServertoolEntryContext({
    options,
    toolCalls,
    base: entryPreflightApplication.baseObject
  });
  const responseStagePrePass = await runServertoolResponseStagePrePass({
    options,
    baseObject: entryContext.baseObject,
    contextBase: entryContext.contextBase,
    includeAutoHookIds: entryContext.includeAutoHookIds,
    excludeAutoHookIds: entryContext.excludeAutoHookIds
  });
  const prepassResult = 'result' in responseStagePrePass ? responseStagePrePass.result : null;
  const enginePrepassDecision = resolveServertoolRunEnginePrepassDecisionWithNative({
    hasPrepassResult: prepassResult != null,
    prepassResult
  });
  const enginePrepassApplication = resolveServertoolRunEnginePrepassApplicationWithNative({
    decision: enginePrepassDecision
  });
  if (enginePrepassApplication.returnResult === true) {
    return enginePrepassApplication.result;
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
