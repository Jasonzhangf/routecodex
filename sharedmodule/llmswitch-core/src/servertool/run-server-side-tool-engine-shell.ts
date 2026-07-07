import type {
  JsonObject,
  ServerSideToolEngineResult,
  ServerSideToolEngineOptions,
  ServerToolHandlerContext,
  ToolCall
} from './types.js';
import {
  runServertoolExecutionStage,
  runServertoolResponseStageAutoHookPass
} from './execution-stage-shell.js';
import {
  createServertoolProviderProtocolErrorFromPlan
} from './timeout-error-block.js';
import {
  readRuntimeControlFromAnyBoundMetadataCenter,
  readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter
} from './metadata-center-carrier.js';
import {
  isAdapterClientDisconnectedWithNative,
  planServertoolEntryContextWithNative,
  planServertoolResponseStageGateWithNative,
  readServertoolEntryBaseObjectWithNative,
  resolveServertoolEntryPreflightApplicationWithNative,
  resolveServertoolEntryPreflightWithNative,
  resolveServertoolResponseStagePrepassAfterAutoHookWithNative,
  resolveServertoolResponseStagePrepassInitialApplicationWithNative,
  resolveServertoolResponseStagePrepassInitialDecisionWithNative,
  resolveServertoolRunEngineEntryPreflightApplicationWithNative,
  resolveServertoolRunEngineEntryPreflightDecisionWithNative,
  resolveServertoolRunEnginePrepassApplicationWithNative,
  resolveServertoolRunEnginePrepassDecisionWithNative,
  runServertoolResponseStageWithNative
} from 'rcc-llmswitch-core/native/servertool-wrapper';
import type { NativeServertoolResponseStageGate } from 'rcc-llmswitch-core/native/servertool-wrapper';

type NativeResponseStageExtraction = {
  normalizedPayload?: unknown;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
};

function replaceJsonObjectInPlace(target: JsonObject, next: JsonObject): void {
  const newKeys = new Set(Object.keys(next));
  for (const [key, value] of Object.entries(next)) {
    target[key] = value;
  }
  for (const key of Object.keys(target)) {
    if (!newKeys.has(key)) {
      delete target[key];
    }
  }
}

function applyServertoolResponseStageExtraction(chatResponse: JsonObject, requestId = ''): ToolCall[] {
  const stage = runServertoolResponseStageWithNative(
    chatResponse,
    requestId
  ) as NativeResponseStageExtraction;
  const normalizedPayload =
    stage.normalizedPayload != null &&
    typeof stage.normalizedPayload === 'object' &&
    !Array.isArray(stage.normalizedPayload)
      ? (stage.normalizedPayload as JsonObject)
      : chatResponse;
  replaceJsonObjectInPlace(chatResponse, normalizedPayload);
  return stage.toolCalls.map((entry) => ({
    id: entry.id,
    name: entry.name,
    arguments: entry.arguments
  }));
}

function applyServertoolEntryPreflight(options: ServerSideToolEngineOptions):
  | { action: 'continue'; baseObject: JsonObject }
  | { action: 'return_result'; result: ServerSideToolEngineResult } {
  const entryPreflightDecision = resolveServertoolEntryPreflightWithNative({
    requestId: options.requestId,
    baseObject: readServertoolEntryBaseObjectWithNative(options.chatResponse),
    adapterClientDisconnected: isAdapterClientDisconnectedWithNative(options.adapterContext),
    chatResponse: options.chatResponse
  });
  const entryPreflightApplication = resolveServertoolEntryPreflightApplicationWithNative({
    entryPreflight: entryPreflightDecision
  });
  if (entryPreflightApplication.throwError === true) {
    throw createServertoolProviderProtocolErrorFromPlan(entryPreflightApplication.errorPlan);
  }
  if (entryPreflightApplication.returnResult === true) {
    return {
      action: 'return_result',
      result: entryPreflightApplication.result
    };
  }
  return {
    action: 'continue',
    baseObject: entryPreflightApplication.baseObject
  };
}

function nativeEntryTokenSet(tokens: readonly string[] | null | undefined): Set<string> | null {
  return tokens != null ? new Set(tokens) : null;
}

function applyServertoolEntryContext(args: {
  options: ServerSideToolEngineOptions;
  toolCalls: ToolCall[];
  base: JsonObject;
}): {
  baseObject: JsonObject;
  contextBase: Omit<ServerToolHandlerContext, 'toolCall'>;
  includeToolCallNames: Set<string> | null;
  excludeToolCallNames: Set<string> | null;
  includeAutoHookIds: Set<string> | null;
  excludeAutoHookIds: Set<string> | null;
} {
  const runtimeMetadataSnapshot = readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter(
    args.options.adapterContext
  );
  if (!runtimeMetadataSnapshot) {
    throw new Error('Servertool entry context requires MetadataCenter request truth or runtime_control snapshot');
  }
  const entryContextPlan = planServertoolEntryContextWithNative({
    includeToolCallHandlerNames: args.options.includeToolCallHandlerNames,
    excludeToolCallHandlerNames: args.options.excludeToolCallHandlerNames,
    includeAutoHookIds: args.options.includeAutoHookIds,
    excludeAutoHookIds: args.options.excludeAutoHookIds
  });
  const includeToolCallNames = nativeEntryTokenSet(entryContextPlan.includeToolCallNames);
  const excludeToolCallNames = nativeEntryTokenSet(entryContextPlan.excludeToolCallNames);
  const includeAutoHookIds = nativeEntryTokenSet(entryContextPlan.includeAutoHookIds);
  const excludeAutoHookIds = nativeEntryTokenSet(entryContextPlan.excludeAutoHookIds);

  return {
    baseObject: args.base,
    contextBase: {
      base: args.base,
      toolCalls: args.toolCalls,
      adapterContext: args.options.adapterContext,
      requestId: args.options.requestId,
      entryEndpoint: args.options.entryEndpoint,
      runtimeMetadata: runtimeMetadataSnapshot
    },
    includeToolCallNames,
    excludeToolCallNames,
    includeAutoHookIds,
    excludeAutoHookIds
  };
}

async function applyServertoolResponseStagePrePass(args: {
  options: ServerSideToolEngineOptions;
  baseObject: JsonObject;
  contextBase: Omit<ServerToolHandlerContext, 'toolCall'>;
  includeAutoHookIds: Set<string> | null;
  excludeAutoHookIds: Set<string> | null;
}): Promise<
  | { action: 'continue_to_execution'; responseStageGatePlan: NativeServertoolResponseStageGate }
  | {
      action: 'return_result';
      responseStageGatePlan: NativeServertoolResponseStageGate;
      result: ServerSideToolEngineResult;
    }
> {
  const responseStageGatePlan = planServertoolResponseStageGateWithNative({
    payload: args.baseObject,
    adapterContext: args.options.adapterContext,
    runtimeControl: readRuntimeControlFromAnyBoundMetadataCenter(
      args.options.adapterContext
    ),
    allowFollowup: false
  });

  const prepassDecision = resolveServertoolResponseStagePrepassInitialDecisionWithNative({
    responseStageGatePlan,
    baseObject: args.baseObject
  });
  const initialApplication = resolveServertoolResponseStagePrepassInitialApplicationWithNative({
    decision: prepassDecision
  });
  if (initialApplication.runAutoHook === false) {
    return initialApplication.result;
  }

  const responseStageAutoHook = await runServertoolResponseStageAutoHookPass({
    options: args.options,
    contextBase: args.contextBase,
    includeAutoHookIds: args.includeAutoHookIds,
    excludeAutoHookIds: args.excludeAutoHookIds,
    responseStageGatePlan,
    baseObject: args.baseObject
  });
  return resolveServertoolResponseStagePrepassAfterAutoHookWithNative({
    responseStageGatePlan,
    baseObject: args.baseObject,
    responseStageAutoHookResult: responseStageAutoHook
  }).result;
}

export async function orchestrateServertoolEngine(
  options: ServerSideToolEngineOptions
): Promise<ServerSideToolEngineResult> {
  const entryPreflight = applyServertoolEntryPreflight(options);
  const entryPreflightDecision = resolveServertoolRunEngineEntryPreflightDecisionWithNative({
    entryPreflight
  });
  const entryPreflightApplication = resolveServertoolRunEngineEntryPreflightApplicationWithNative({
    entryPreflight: entryPreflightDecision
  });
  if (entryPreflightApplication.returnResult === true) {
    return entryPreflightApplication.result;
  }
  const toolCalls = applyServertoolResponseStageExtraction(
    entryPreflightApplication.baseObject,
    options.requestId
  );
  const entryContext = applyServertoolEntryContext({
    options,
    toolCalls,
    base: entryPreflightApplication.baseObject
  });
  const responseStagePrePass = await applyServertoolResponseStagePrePass({
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
