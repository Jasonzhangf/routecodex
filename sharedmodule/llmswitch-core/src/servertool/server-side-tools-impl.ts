import type { JsonObject } from '../conversion/hub/types/json.js';
import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult,
  ServerToolHandlerContext,
  ToolCall
} from './types.js';
import {
  extractTextFromChatLikeWithNative,
} from '../native/router-hotpath/native-servertool-core-semantics.js';
import { extractToolCallsFromResponseStage } from './extract-tool-calls-shell.js';
import { runServertoolEntryPreflight } from './entry-preflight-shell.js';
import { runServertoolResponseStagePrePass } from './response-stage-prepass-shell.js';
import { runServertoolExecutionStage } from './execution-stage-shell.js';
import { asServertoolJsonObject, resolveServertoolEntryContext } from './entry-context-shell.js';

export const runServerSideToolEngine = async (
  options: ServerSideToolEngineOptions
): Promise<ServerSideToolEngineResult> => {
  const base = asServertoolJsonObject(options.chatResponse);
  const entryPreflight = runServertoolEntryPreflight({
    options,
    base
  });
  if (entryPreflight.action === 'return_result') {
    return entryPreflight.result;
  }
  const toolCalls = extractToolCallsFromResponseStage(entryPreflight.baseObject, options.requestId);
  const entryContext = resolveServertoolEntryContext({
    options,
    toolCalls,
    base: entryPreflight.baseObject
  });
  if (entryContext.action !== 'continue') {
    return {
      mode: 'passthrough',
      finalChatResponse: options.chatResponse
    };
  }
  const responseStagePrePass = await runServertoolResponseStagePrePass({
    options,
    baseObject: entryContext.baseObject,
    contextBase: entryContext.contextBase as ServerToolHandlerContext,
    includeAutoHookIds: entryContext.includeAutoHookIds,
    excludeAutoHookIds: entryContext.excludeAutoHookIds
  });
  if (responseStagePrePass.action === 'return_result') {
    return responseStagePrePass.result;
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
};

export const extractToolCalls = (chatResponse: JsonObject, requestId = ''): ToolCall[] => {
  return extractToolCallsFromResponseStage(chatResponse, requestId);
};

export function extractTextFromChatLike(payload: JsonObject): string {
  return extractTextFromChatLikeWithNative(payload);
}
