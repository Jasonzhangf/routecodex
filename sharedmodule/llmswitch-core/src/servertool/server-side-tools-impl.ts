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

function normalizeFilterTokenSet(values: string[] | undefined): Set<string> | null {
  if (!Array.isArray(values) || values.length === 0) {
    return null;
  }
  const normalized = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== 'string') {
      continue;
    }
    const value = raw.trim().toLowerCase();
    if (!value) {
      continue;
    }
    normalized.add(value);
  }
  return normalized.size > 0 ? normalized : null;
}

export const runServerSideToolEngine = async (
  options: ServerSideToolEngineOptions
): Promise<ServerSideToolEngineResult> => {
  const base = asObject(options.chatResponse);
  const entryPreflight = runServertoolEntryPreflight({
    options,
    base
  });
  if (entryPreflight.action === 'return_result') {
    return entryPreflight.result;
  }
  const baseObject = entryPreflight.baseObject;
  const toolCalls = extractToolCallsFromResponseStage(baseObject, options.requestId);
  const contextBase: Omit<ServerToolHandlerContext, 'toolCall'> = {
    base: baseObject,
    toolCalls,
    adapterContext: options.adapterContext,
    requestId: options.requestId,
    entryEndpoint: options.entryEndpoint,
    providerProtocol: options.providerProtocol
  };
  const includeToolCallNames = normalizeFilterTokenSet(options.includeToolCallHandlerNames);
  const excludeToolCallNames = normalizeFilterTokenSet(options.excludeToolCallHandlerNames);
  const includeAutoHookIds = normalizeFilterTokenSet(options.includeAutoHookIds);
  const excludeAutoHookIds = normalizeFilterTokenSet(options.excludeAutoHookIds);
  const responseStagePrePass = await runServertoolResponseStagePrePass({
    options,
    baseObject,
    contextBase: contextBase as ServerToolHandlerContext,
    includeAutoHookIds,
    excludeAutoHookIds
  });
  if (responseStagePrePass.action === 'return_result') {
    return responseStagePrePass.result;
  }

  return runServertoolExecutionStage({
    options,
    baseObject,
    toolCalls,
    contextBase,
    includeToolCallNames,
    excludeToolCallNames,
    includeAutoHookIds,
    excludeAutoHookIds,
    responseStageGatePlan: responseStagePrePass.responseStageGatePlan
  });
};

export const extractToolCalls = (chatResponse: JsonObject, requestId = ''): ToolCall[] => {
  return extractToolCallsFromResponseStage(chatResponse, requestId);
};

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

export function extractTextFromChatLike(payload: JsonObject): string {
  return extractTextFromChatLikeWithNative(payload);
}
