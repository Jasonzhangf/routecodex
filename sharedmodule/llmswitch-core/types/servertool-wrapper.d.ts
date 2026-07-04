// Compile-time shim for the package self-reference used by source files.
// Runtime packages resolve this specifier through package.json exports to dist/native/servertool-wrapper.js.

import type { JsonObject } from '../src/conversion/hub/types/json.js';

export type ServertoolResponseStageGatePayload = {
  shouldBypass: boolean;
  nextAction: 'bypass' | 'run_auto_hooks' | 'continue_to_execution';
  responseHookMatched: boolean;
  responseHookRequired: boolean;
  responseHookName?: string;
  interceptKind?: string;
  schemaSource?: string;
  skipReason?: string;
};

export type NativeServertoolResponseStageGate = ServertoolResponseStageGatePayload;
export type ServertoolAutoHookQueueItems<T> = { queueOrder?: Array<{ queue: string; entries: T[] }> } & Record<string, unknown>;
export type ServertoolDispatchPlan = {
  executableToolCalls: Array<{ id: string; name: string; arguments: string }>;
  noopToolCalls: Array<{ id: string; name: string; arguments: string }>;
  chatResponse: JsonObject;
};

export const buildServertoolHandlerErrorToolOutputPayloadWithNative: any;
export const buildServertoolMatchSkippedProgressEventWithNative: any;
export const buildServertoolAutoHookTraceProgressEventWithNative: any;
export const buildServertoolStopEntryProgressEventWithNative: any;
export const buildServertoolStopCompareProgressEventWithNative: any;
export const buildServertoolToolOutputPayloadWithNative: any;
export const collectServertoolAdditionalClientToolCallsWithNative: any;
export const containsSyntheticRouteCodexControlTextWithNative: any;
export const detectEmptyAssistantPayloadContractSignalWithNative: any;
export const detectProviderResponseShapeWithNative: any;
export const extractCapturedChatSeedWithNative: any;
export const extractAssistantFollowupMessageWithNative: any;
export const isServertoolClientExecCliProjectionToolCallWithNative: any;
export const normalizeFollowupParametersWithNative: any;
export const normalizeServertoolProgressFlowIdWithNative: any;
export const normalizeServertoolProgressResultWithNative: any;
export const normalizeServertoolProgressTokenWithNative: any;
export const normalizeServertoolRegistrationSpecWithNative: any;
export const planChatWebSearchOperationsWithNative: any;
export const planServertoolAutoHookQueueItemsWithNative: any;
export const planServertoolAutoHookQueuesWithNative: any;
export const planServertoolBuiltinAutoHandlerEntriesWithNative: any;
export const planServertoolBuiltinHandlerEntryWithNative: any;
export const planServertoolBuiltinHandlerNamesWithNative: any;
export const planServertoolBuiltinHandlerRecordEntriesWithNative: any;
export const planServertoolRegistryLookupFromSkeletonWithNative: any;
export const planServertoolResponseStageGateWithNative: any;
export const planServertoolFollowupRuntimeWithNative: any;
export const planServertoolHandlerContractWithNative: any;
export const planServertoolNoopOutcomeWithNative: any;
export const buildServertoolDispatchPlanInputWithNative: any;
export const buildServertoolOutcomePlanInputWithNative: any;
export const planServertoolOutcomeWithNative: any;
export const planServertoolSkeletonDerivedConfigWithNative: any;
export const planServertoolToolCallDispatchWithNative: any;
export const readServertoolPrimaryAutoHookIdsWithNative: any;
export const resolveServertoolBuiltinHandlerEntryWithNative: any;
export const resolveServertoolProgressStageWithNative: any;
export const resolveServertoolProgressToolNameWithNative: any;
export const resolveServertoolRegisteredNameWithNative: any;
export const resolveServertoolRegistryHandlerWithNative: any;
export const resolveServertoolToolSpecWithNative: any;
export const runServertoolOrchestrationMutationWithNative: any;
export const runServertoolResponseStageWithNative: any;
export const shouldUseServertoolGoldProgressHighlightWithNative: any;
export const visionBuildAnalysisPayloadWithNative: any;
export const visionBuildPinnedMetadataWithNative: any;
export const visionExtractOriginalUserPromptWithNative: any;
export const webSearchBuildSystemPromptWithNative: any;
export const webSearchBuildToolMessagesWithNative: any;
export const webSearchCollectHitsWithNative: any;
export const webSearchExtractAssistantMessageWithNative: any;
export const webSearchFormatHitsSummaryWithNative: any;
export const webSearchIsGeminiEngineWithNative: any;
export const webSearchIsGlmEngineWithNative: any;
export const webSearchIsQwenEngineWithNative: any;
export const webSearchLimitHitsWithNative: any;
export const webSearchNormalizeResultCountWithNative: any;
export const webSearchSanitizeBackendErrorWithNative: any;
