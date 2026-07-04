// Native bridge for servertool-core functions.
// Provides inspect_stop_gateway_signal, evaluate_loop_guard, calculate_budget.
// Also re-exports the 76 NAPI wrappers consumed by shell files and orchestration.

import type { JsonObject } from '../../conversion/hub/types/json.js';
import type { ServerSideToolEngineResult } from '../../servertool/types.js';
import {
  ProviderProtocolError,
  type ProviderErrorCategory,
  type ProviderProtocolErrorCode
} from '../../conversion/provider-protocol-error.js';
import { readNativeFunction } from './native-shared-conversion-semantics-core.js';
import {
  parseStopMessagePersistedLookupPlanPayload,
  parseServertoolDispatchPlanInputPayload,
  parseServertoolDispatchPlanPayload,
  parseServertoolOutcomePlanInputPayload,
  parseServertoolOutcomePlanPayload,
  parseServertoolResponseStagePayload
} from './native-router-hotpath-analysis.js';

import type {
  ServertoolResponseStageGatePayload,
  ServertoolResponseStageOutput
} from 'rcc-llmswitch-core/native/servertool-wrapper';
import {
  buildServertoolOutcomePlanInputWithNative,
  planServertoolOutcomeWithNative
} from 'rcc-llmswitch-core/native/servertool-wrapper';

// Re-export NAPI wrappers consumed by shell files and orchestration functions
export {
  buildServertoolAutoHookTraceProgressEventWithNative,
  buildServertoolCliProjectionExecutionContextWithNative,
  buildServertoolCliProjectionRuntimeBranchWithNative,
  buildServertoolHandlerErrorToolOutputPayloadWithNative,
  buildServertoolMatchSkippedProgressEventWithNative,
  buildServertoolStopCompareProgressEventWithNative,
  buildServertoolStopEntryProgressEventWithNative,
  buildServertoolToolOutputPayloadWithNative,
  collectServertoolAdditionalClientToolCallsWithNative,
  containsSyntheticRouteCodexControlTextWithNative,
  createServertoolExecutionLoopStateWithNative,
  detectEmptyAssistantPayloadContractSignalWithNative,
  detectProviderResponseShapeWithNative,
  extractAssistantFollowupMessageWithNative,
  extractCapturedChatSeedWithNative,
  extractTextFromChatLikeWithNative,
  inspectStopGatewaySignalWithNative,
  isAdapterClientDisconnectedWithNative,
  isServertoolClientExecCliProjectionToolCallWithNative,
  normalizeFollowupParametersWithNative,
  normalizeServertoolProgressFlowIdWithNative,
  normalizeServertoolProgressResultWithNative,
  normalizeServertoolProgressTokenWithNative,
  normalizeServertoolRegistrationSpecWithNative,
  normalizeStopGatewayContextWithNative,
  normalizeStopMessageCompareContextWithNative,
  parseServertoolCliProjectionToolArgumentsWithNative,
  parseServertoolTimeoutMsWithNative,
  planChatWebSearchOperationsWithNative,
  planServertoolAutoHookQueueItemsWithNative,
  planServertoolAutoHookQueuesWithNative,
  planServertoolBuiltinAutoHandlerEntriesWithNative,
  planServertoolBuiltinHandlerEntryWithNative,
  planServertoolBuiltinHandlerNamesWithNative,
  planServertoolBuiltinHandlerRecordEntriesWithNative,
  planServertoolFollowupRuntimeWithNative,
  planServertoolHandlerContractWithNative,
  planServertoolNoopOutcomeWithNative,
  planServertoolRegistryLookupFromSkeletonWithNative,
  planServertoolResponseStageGateWithNative,
  planServertoolSkeletonDerivedConfigWithNative,
  planServertoolTimeoutWatcherWithNative,
  planServertoolToolCallDispatchWithNative,
  readRuntimeStopMessageStageModeWithNative,
  readServertoolPrimaryAutoHookIdsWithNative,
  resolveRuntimeStopMessageStateFromMetadataCenterWithNative,
  resolveRuntimeStopMessageStateWithNative,
  resolveServertoolBuiltinHandlerEntryWithNative,
  resolveServertoolProgressStageWithNative,
  resolveServertoolProgressToolNameWithNative,
  resolveServertoolRegisteredNameWithNative,
  resolveServertoolRegistryHandlerWithNative,
  resolveServertoolToolSpecWithNative,
  runServertoolOrchestrationMutationWithNative,
  shouldUseServertoolGoldProgressHighlightWithNative,
  visionBuildAnalysisPayloadWithNative,
  visionBuildPinnedMetadataWithNative,
  visionExtractOriginalUserPromptWithNative,
  webSearchBuildSystemPromptWithNative,
  webSearchBuildToolMessagesWithNative,
  webSearchCollectHitsWithNative,
  webSearchExtractAssistantMessageWithNative,
  webSearchFormatHitsSummaryWithNative,
  webSearchIsGeminiEngineWithNative,
  webSearchIsGlmEngineWithNative,
  webSearchIsQwenEngineWithNative,
  webSearchLimitHitsWithNative,
  webSearchNormalizeResultCountWithNative,
  webSearchSanitizeBackendErrorWithNative
} from 'rcc-llmswitch-core/native/servertool-wrapper';

export type NativeServertoolResponseStageGate = ServertoolResponseStageGatePayload;
export type NativeServertoolResponseStage = ServertoolResponseStageOutput;

// ── Types ───────────────────────────────────────────────────────────────────
export interface StopGatewayContext {
  observed: boolean;
  eligible: boolean;
  source: 'chat' | 'responses' | 'none';
  reason: string;
  choiceIndex?: number;
  hasToolCalls?: boolean;
}

export interface LoopGuardInput {
  started_at_ms?: number;
  stop_pair_repeat_count?: number;
  stop_pair_warned?: boolean;
  now_ms?: number;
  warn_threshold: number;
  fail_threshold: number;
}

export interface LoopGuardOutput {
  should_inject_warning: boolean;
  stop_pair_warned?: boolean;
  hit_limit: boolean;
  elapsed_ms: number;
  repeat_count: number;
}

export interface BudgetDecision {
  observed: boolean;
  stop_eligible: boolean;
  next_used: number;
  max_repeats: number;
}

export interface StopMessageCompareContext {
  armed: boolean;
  mode: 'off' | 'on' | 'auto';
  allowModeOnly: boolean;
  textLength: number;
  maxRepeats: number;
  used: number;
  remaining: number;
  active: boolean;
  stopEligible: boolean;
  compactionRequest: boolean;
  hasSeed: boolean;
  decision: 'trigger' | 'skip';
  reason: string;
  stage?: string;
  bdWorkState?: string;
  observationHash?: string;
  observationStableCount?: number;
  toolSignatureHash?: string;
}

export interface BudgetSnapshot {
  text: string;
  max_repeats: number;
  used: number;
  source: string;
  stage_mode?: string;
  ai_mode?: string;
}

export interface DefaultBudgetConfig {
  enabled: boolean;
  text: string;
  max_repeats: number;
  is_non_active_managed_goal: boolean;
}

export type NativeServerToolExecution = {
  flowId: string;
  stopMessageReservation?: {
    stickyKey: string;
    previousState: Record<string, unknown> | null;
  };
};

export type NativeServerToolHandlerResult = {
  chatResponse: JsonObject;
  execution: NativeServerToolExecution;
  metadataWritePlan?: JsonObject;
};

export type NativeServertoolMaterializedEngineResult = {
  mode: 'tool_flow';
  finalChatResponse: JsonObject;
  execution: {
    flowId: string;
  };
};

export interface BudgetStateUpdatePlanInput {
  stopSignal: {
    observed: boolean;
    eligible: boolean;
    reason: string;
  };
  existingState?: Record<string, unknown> | null;
  snapshot?: BudgetSnapshot | null;
  defaultConfig?: DefaultBudgetConfig | null;
  nowMs: number;
}

export interface BudgetStateUpdatePlanOutput {
  observed: boolean;
  stopEligible: boolean;
  used?: number;
  maxRepeats?: number;
  shouldPersist: boolean;
  nextState?: Record<string, unknown> | null;
}

export interface PendingServerToolInjectionPlan {
  version: 1;
  sessionId: string;
  createdAtMs: number;
  afterToolCallIds: string[];
  messages: Record<string, unknown>[];
  sourceRequestId?: string;
}

export interface AutoHookTraceEventPlan {
  hookId: string;
  phase: string;
  priority: number;
  queue: 'A_optional' | 'B_mandatory';
  queueIndex: number;
  queueTotal: number;
  result: 'miss' | 'match' | 'error';
  reason: string;
  flowId?: string;
}

export interface AutoHookRuntimeAttemptPlan {
  action: 'return_result' | 'continue_queue' | 'rethrow_error';
  traceEvent: AutoHookTraceEventPlan;
  returnResult: boolean;
  continueQueue: boolean;
  rethrowError: boolean;
  errorMessage?: string;
}

export interface AutoHookRuntimeAttemptDecision {
  traceEvent: AutoHookTraceEventPlan;
  returnResult: boolean;
  continueQueue: boolean;
  rethrowError: boolean;
  errorMessage?: string;
}

export type AutoHookCallerFinalizationPlan =
  | {
      action: 'return_result';
      returnResult: true;
      continueNextQueue: false;
      returnNull: false;
      resultMode: 'tool_flow';
      result: {
        mode: 'tool_flow';
        finalChatResponse: JsonObject;
        execution: NativeServerToolExecution;
        metadataWritePlan?: JsonObject;
      };
    }
  | {
      action: 'continue_next_queue';
      returnResult: false;
      continueNextQueue: true;
      returnNull: false;
    }
  | {
      action: 'return_null';
      returnResult: false;
      continueNextQueue: false;
      returnNull: true;
    };

export interface AutoHookCallerFinalizationDecision {
  returnResult: boolean;
  continueNextQueue: boolean;
  returnNull: boolean;
  result?: {
    mode: 'tool_flow';
    finalChatResponse: JsonObject;
    execution: NativeServerToolExecution;
    metadataWritePlan?: JsonObject;
  };
}

export type AutoHookCallerResultProjectionPlan = {
  result: {
    mode: 'tool_flow';
    finalChatResponse: JsonObject;
    execution: NativeServerToolExecution;
    metadataWritePlan?: JsonObject;
  };
};

export interface EngineSelectionOverridesPlan {
  disableToolCallHandlers?: boolean;
  includeAutoHookIds?: string[];
  excludeAutoHookIds?: string[];
}

export interface EngineSelectionStartPlan {
  action: 'run_default' | 'run_primary_hooks';
  overrides: EngineSelectionOverridesPlan;
  primaryAutoHookIds: string[];
}

export type EngineSelectionAfterRunPlan = {
  action: 'return_current';
} | {
  action: 'rerun_excluding_primary_hooks';
  overrides: EngineSelectionOverridesPlan;
};

export type EngineSelectionAfterRunDecision = {
  rerunOverrides?: EngineSelectionOverridesPlan;
};

export interface ClientExecCliProjectionInput {
  toolName?: string;
  flowId?: string;
  input?: unknown;
  repeatCount?: number;
  maxRepeats?: number;
  stdoutPreview?: string;
  sessionDir?: string;
  sessionId?: string;
  requestId?: string;
}

export interface ClientExecCliProjectionOutput {
  toolName: string;
  flowId: string;
  execCommand: string;
  continuationPrompt?: string;
  repeatCount?: number;
  maxRepeats?: number;
  schemaGuidance?: unknown;
}

export interface ServertoolCliProjectionToolArgumentsInput {
  arguments: string;
}

export interface ClientVisibleProjectionShellInput {
  requestId: string;
  clientCallId: string;
  nativeProjection: ClientExecCliProjectionOutput;
  reasoningText: string;
  additionalToolCalls?: unknown[];
}

export type ServertoolHookSkeletonPhaseValidationPlan = Record<string, unknown>;
export type ServertoolHookSchedulePlan = Record<string, unknown>;

export interface ServertoolCliProjectionExecutionContextInput {
  requestId: string;
  clientCallId: string;
  toolName: string;
}

export interface ServertoolCliProjectionExecutionContextOutput {
  flowId: string;
}

export interface ServertoolCliProjectionRuntimeBranchInput {
  requestId: string;
  toolName: string;
  toolArguments: string;
  projectedToolCallId: string;
  base: Record<string, unknown>;
}

export interface ServertoolCliProjectionRuntimeBranchOutput {
  resultMode: 'tool_flow';
  chatResponse: JsonObject;
  execution: NativeServertoolExecutionSummary;
  result: {
    mode: 'tool_flow';
    finalChatResponse: JsonObject;
    execution: NativeServertoolExecutionSummary;
  };
}

export interface NativeServertoolExecutionSummary {
  flowId: string;
  context?: unknown;
}

export interface StoplessExecutionPlanOutput {
  execution: Record<string, unknown>;
  orchestrationPlan: {
    action: string;
    isStopMessageFlow: boolean;
    reason: string;
  };
}

export interface StoplessAutoCliProjectionFromEngineOutput {
  chatResponse: JsonObject;
}

export interface ServertoolEnginePostflightPayloadInput {
  runtimeAction: ServertoolEngineRuntimeActionPlan;
  engineResult: ServerSideToolEngineResult;
  metadataCenterSnapshot?: unknown;
  requestId?: string | null;
}

export interface NativeServertoolExecutedToolCall {
  id: string;
  name: string;
  arguments: string;
  executionMode: string;
  stripAfterExecute: boolean;
}

export interface NativeServertoolExecutedRecord {
  toolCall: NativeServertoolExecutedToolCall;
  execution?: NativeServertoolExecutionSummary;
}

export interface NativeServertoolExecutionLoopState {
  executedToolCalls: NativeServertoolExecutedRecord[];
  executedIds: string[];
  executedFlowIds: string[];
  lastExecution?: NativeServertoolExecutionSummary;
}

export type ServertoolExecutionBranchPlan =
  | {
      action: 'client_exec_cli_projection';
      projectedToolCall: {
        id: string;
        name: string;
        arguments: string;
      };
      projectedToolCallId?: string;
      projectedToolCallIndex?: number;
    }
  | {
      action: 'resolve_execution_outcome' | 'continue_response_stage';
      projectedToolCall?: never;
      projectedToolCallId?: never;
      projectedToolCallIndex?: never;
    };

export type ServertoolPreExecutionBranchDecision =
  | {
      projectClientExecCli: true;
      continueResponseStage: false;
      projectedToolCall: ServertoolProjectedToolCall;
    }
  | {
      projectClientExecCli: false;
      continueResponseStage: true;
    };

export type ServertoolPostExecutionBranchDecision =
  | {
      resolveExecutionOutcome: true;
      continueResponseStage: false;
    }
  | {
      resolveExecutionOutcome: false;
      continueResponseStage: true;
    };

export interface ServertoolProjectedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ServertoolEnginePreflightPlan {
  action:
    | 'return_original_chat'
    | 'return_original_chat_direct_passthrough'
    | 'continue_to_engine';
  attachStopGatewayContext: boolean;
  result:
    | {
        kind: 'return_original_chat' | 'return_original_chat_direct_passthrough';
        chat: JsonObject;
      }
    | {
        kind: 'continue';
        stopSignal: unknown;
      };
  logStopEntry?: {
    stage: 'entry' | 'trigger';
    result: string;
    includeChoiceFacts: boolean;
  };
  logStopCompare?: {
    stage: 'entry' | 'trigger';
  };
}

export interface ServertoolEnginePreflightDecision {
  result: ServertoolEnginePreflightPlan['result'];
  shouldRunSideEffects: boolean;
}

export interface ServertoolEngineOrchestrationPreflightActionPlan {
  action: 'return_preflight_chat' | 'continue_engine';
}

export type ServertoolEngineOrchestrationPreflightDecision =
  {
    returnPreflightChat: boolean;
    continueEngine: boolean;
    chat?: JsonObject;
    stopSignal?: unknown;
  };

export interface ServertoolEngineRuntimeActionPlan {
  action:
    | 'return_servertool_cli_projection_final'
    | 'return_stop_message_terminal_final'
    | 'build_stop_message_cli_projection';
  executed: true;
  flowIdSource: 'engine_execution' | 'current_flow';
  progressStatus: string;
  finalPayloadSource: 'engine_result' | 'stop_message_cli_projection';
  projectedFlowId?: string;
}

export interface ServertoolEngineTriggerObservationPlan {
  shouldLog: boolean;
  logStopEntry?: {
    stage: 'trigger';
    result: string;
  };
  logStopCompare?: {
    stage: 'trigger';
    flowId?: string;
  };
}

export type ServertoolEngineSkipPlan =
  | {
      action: 'return_skipped_passthrough' | 'return_skipped_no_execution';
      skipReason: string;
      triggerResult: string;
      shellResult: {
        chat: JsonObject;
        executed: false;
      };
    }
  | {
      action: 'continue_matched_flow';
    };

export type ServertoolEngineSkipDecision =
  | {
      returnSkipped: true;
      continueMatchedFlow: false;
      skipReason: string;
      triggerResult: string;
      shellResult: {
        chat: JsonObject;
        executed: false;
      };
    }
  | {
      returnSkipped: false;
      continueMatchedFlow: true;
    };

export interface ServertoolExecutionOutcomeRuntimeActionPlan {
  action:
    | 'invalid_mixed_client_tools_outcome'
    | 'return_execution_contract'
    | 'missing_servertool_execution_contract';
  reuseLastExecutionEnvelope?: boolean;
  selectedExecutionEnvelope?: unknown;
  executionFlowId: string;
}

export type ServertoolExecutionOutcomeMaterializationPlan =
  | {
      action: 'throw_dispatch_error';
      errorPlan: ServertoolErrorPlan;
    }
  | {
      action: 'return_tool_flow';
      resultMode: 'tool_flow';
      executionFlowId: string;
    };

export interface ServertoolExecutionLoopRuntimeActionPlan {
  action:
    | 'skip_non_tool_call_handler'
    | 'throw_dispatch_spec_mismatch'
    | 'apply_materialized_result'
    | 'apply_handler_error_tool_output'
    | 'continue_without_effect';
}

export type ServertoolExecutionLoopInitialDecision =
  | {
      action: 'skip_non_tool_call_handler';
    }
  | {
      action: 'throw_dispatch_spec_mismatch';
    }
  | {
      action: 'continue_to_handler';
    };

export type ServertoolExecutionLoopResultDecision =
  | {
      action: 'apply_materialized_result';
    }
  | {
      action: 'apply_handler_error_tool_output';
    }
  | {
      action: 'continue_without_effect';
    };

export type ServertoolExecutionLoopInitialDecisionApplication<T> = {
  skipNonToolCallHandler: () => T;
  throwDispatchSpecMismatch: () => T;
  continueToHandler: () => T;
};

export type ServertoolExecutionLoopResultDecisionApplication<T> = {
  applyMaterializedResult: () => T;
  applyHandlerErrorToolOutput: () => T;
  continueWithoutEffect: () => T;
};

function parseNativeJson(capability: string, raw: unknown): unknown {
  if (typeof raw !== 'string') {
    throw new Error(`native ${capability} returned non-string: ${typeof raw}`);
  }
  return JSON.parse(raw) as unknown;
}

function callNativeJsonCapability(capability: string, input: unknown): unknown {
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error(`native ${capability} is required`);
  }
  try {
    return parseNativeJson(capability, fn(JSON.stringify(input)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${capability} native error: ${message}`);
  }
}

function callNativeJsonCapabilityWithErrorContract(
  capability: string,
  input: unknown,
  formatError: (message: string) => string
): unknown {
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error(`native ${capability} is required`);
  }
  try {
    return parseNativeJson(capability, fn(JSON.stringify(input)));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(formatError(message));
  }
}

function requireNativeJsonObject(capability: string, input: unknown): Record<string, unknown> {
  const parsed = callNativeJsonCapability(capability, input);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} native returned invalid object`);
  }
  return parsed as Record<string, unknown>;
}

export interface ServertoolExecutionLoopEffectBasePlan {
  toolCall: NativeServertoolExecutedRecord['toolCall'];
  execution: NativeServertoolExecutionSummary;
}

export interface ServertoolExecutionLoopHandlerErrorEffectPlan extends ServertoolExecutionLoopEffectBasePlan {
  handlerErrorMessage: string;
}

export type ServertoolExecutionLoopEffectPlan =
  | ServertoolExecutionLoopHandlerErrorEffectPlan
  | ServertoolExecutionLoopEffectBasePlan;

export type ServertoolResponseStageAutoHookResult = ServerSideToolEngineResult;

export type ServertoolResponseStageRuntimeActionPlan =
  | {
      action: 'return_passthrough_bypass' | 'return_passthrough_no_auto_hook_result';
      passthroughResult: {
        mode: 'passthrough';
        finalChatResponse: unknown;
      };
      passResult: {
        action: 'return_passthrough_bypass' | 'continue_without_result';
      };
      prepassResult: {
        action: 'continue_to_execution';
        responseStageGatePlan: NativeServertoolResponseStageGate;
      };
      finalizeResult: ServertoolResponseStageAutoHookResult;
      skipReason?: string;
    }
  | {
      action: 'return_required_response_hook_empty';
      responseHookName: string;
    }
  | {
      action: 'run_auto_hooks';
    }
  | {
      action: 'return_auto_hook_result';
      passResult: {
        action: 'return_auto_hook_result';
        result: ServertoolResponseStageAutoHookResult;
      };
      prepassResult: {
        action: 'return_result';
        responseStageGatePlan: NativeServertoolResponseStageGate;
        result: ServertoolResponseStageAutoHookResult;
      };
      finalizeResult: ServertoolResponseStageAutoHookResult;
    };

export interface ServertoolResponseStageOrchestrationGateApplicationPlan {
  bypass: boolean;
  runOrchestration: boolean;
  skipReason?: string;
}

type ServertoolResponseStageAutoHookPassResult = Extract<
  ServertoolResponseStageRuntimeActionPlan,
  { passResult: unknown }
>['passResult'];

export type ServertoolResponseStagePrepassShellDecision =
  | {
      action: 'run_auto_hooks';
    }
  | {
      action: 'return_prepass_result';
      result: {
        action: 'continue_to_execution';
        responseStageGatePlan: NativeServertoolResponseStageGate;
      };
    };

export type ServertoolResponseStagePrepassInitialApplicationDecision =
  | {
      runAutoHook: true;
    }
  | {
      runAutoHook: false;
      result: {
        action: 'continue_to_execution';
        responseStageGatePlan: NativeServertoolResponseStageGate;
      };
    };

export type ServertoolResponseStagePrepassAfterAutoHookDecision =
  | {
      action: 'return_prepass_result';
      result:
        | {
            action: 'continue_to_execution';
            responseStageGatePlan: NativeServertoolResponseStageGate;
          }
        | {
            action: 'return_result';
            responseStageGatePlan: NativeServertoolResponseStageGate;
            result: ServertoolResponseStageAutoHookResult;
          };
    };

export type ServertoolResponseStageAutoHookPreDecision =
  | {
      action: 'return_pass_result';
      result: ServertoolResponseStageAutoHookPassResult;
    }
  | {
      action: 'run_auto_hooks';
    };

export type ServertoolResponseStageAutoHookPostDecision =
  | {
      action: 'return_pass_result';
      result: ServertoolResponseStageAutoHookPassResult;
    }
  | {
      action: 'throw_required_response_hook_empty';
      errorPlan: ReturnType<typeof planServertoolRequiredResponseHookEmptyErrorWithNative>;
    };

export type ServertoolResponseStageAutoHookPreApplicationDecision =
  | {
      returnPassResult: true;
      runAutoHooks: false;
      result: ServertoolResponseStageAutoHookPassResult;
    }
  | {
      returnPassResult: false;
      runAutoHooks: true;
    };

export type ServertoolResponseStageAutoHookPostApplicationDecision =
  | {
      throwRequiredResponseHookEmpty: true;
      returnPassResult: false;
      errorPlan: ReturnType<typeof planServertoolRequiredResponseHookEmptyErrorWithNative>;
    }
  | {
      throwRequiredResponseHookEmpty: false;
      returnPassResult: true;
      result: ServertoolResponseStageAutoHookPassResult;
    };

export interface ServertoolResponseStageOrchestrationOutputPlan {
  returnAction: 'return_executed_payload' | 'return_original_payload';
  recordExecuted: boolean;
  recordFlowId?: string;
}

export interface ServertoolResponseStageOrchestrationMaterializedOutput {
  payload: JsonObject;
  executed: boolean;
  flowId?: string;
  returnedExecutedPayload: boolean;
  shellResult: {
    payload: JsonObject;
    executed: boolean;
    flowId?: string;
  };
  recordEvent: JsonObject;
}

export type ServertoolResponseStageOrchestrationShellResult =
  ServertoolResponseStageOrchestrationMaterializedOutput['shellResult'];

export type ServertoolEntryPreflightPlan =
  | {
      action: 'return_passthrough_non_object_chat';
      passthroughResult: {
        mode: 'passthrough';
        finalChatResponse: unknown;
      };
    }
  | {
      action: 'throw_client_disconnected' | 'continue_to_tool_flow';
    };

export type ServertoolEntryPreflightDecision =
  | {
      action: 'return_result';
      result: ServerSideToolEngineResult;
    }
  | {
      action: 'throw_error';
      errorPlan: ReturnType<typeof planServertoolClientDisconnectedErrorWithNative>;
    }
  | {
      action: 'continue';
      baseObject: JsonObject;
    };

export type ServertoolEntryPreflightApplicationDecision =
  | {
      throwError: true;
      errorPlan: ReturnType<typeof planServertoolClientDisconnectedErrorWithNative>;
    }
  | {
      throwError: false;
      returnResult: true;
      result: ServerSideToolEngineResult;
    }
  | {
      throwError: false;
      returnResult: false;
      baseObject: JsonObject;
    };

export type ServertoolRunEngineEntryPreflightDecision =
  | {
      action: 'return_result';
      result: ServerSideToolEngineResult;
    }
  | {
      action: 'continue';
      baseObject: JsonObject;
    };

export type ServertoolRunEngineEntryPreflightApplicationDecision =
  | {
      returnResult: true;
      result: ServerSideToolEngineResult;
    }
  | {
      returnResult: false;
      baseObject: JsonObject;
    };

export type ServertoolRunEnginePrepassDecision =
  | {
      action: 'return_result';
      result: ServerSideToolEngineResult;
    }
  | {
      action: 'continue_to_execution';
    };

export type ServertoolRunEnginePrepassApplicationDecision =
  | {
      returnResult: true;
      result: ServerSideToolEngineResult;
    }
  | {
      returnResult: false;
    };

export type ServertoolHandlerMaterializationPlan =
  | {
      action: 'finalize_without_backend';
    }
  | {
      action: 'return_handler_result';
    }
  | {
      action: 'throw_handler_error';
      errorPlan: ServertoolErrorPlan;
    };

export interface StoplessLearnedNoteWritePlanInput {
  adapterContext: Record<string, unknown>;
  requestId: string;
  parsed?: Record<string, unknown>;
  timestampMs?: number;
}

export interface StoplessLearnedNoteWritePlan {
  shouldWrite: boolean;
  workingDirectory?: string;
  requestId: string;
  sessionId?: string;
  timestampMs: number;
  learned?: string;
  reason?: string;
  evidence?: string;
}

export interface StoplessCliProjectionMetadataWritePlan {
  stopless?: JsonObject;
}

export interface StoplessCliProjectionContextPlan {
  reasoningText: string;
  repeatCount: number;
  maxRepeats: number;
  publicTriggerHint?: string;
  schemaFeedback?: JsonObject;
  sessionId?: string;
  requestId?: string;
}

export type StopMessagePersistedLookupPlanOutput = ReturnType<typeof parseStopMessagePersistedLookupPlanPayload> extends infer T
  ? Exclude<T, null>
  : never;

export interface RuntimeStopMessageStateSnapshot {
  text: string;
  providerKey?: string;
  maxRepeats: number;
  used: number;
  source?: string;
  updatedAt?: number;
  lastUsedAt?: number;
  stageMode?: 'on' | 'off' | 'auto';
  aiMode?: 'on' | 'off';
}

export interface StopMessageRoutingStateApplyPlan {
  source: string;
  text: string;
  providerKey?: string;
  maxRepeats: number;
  used: number;
  updatedAt?: number;
  lastUsedAt?: number;
  stageMode?: 'on' | 'off' | 'auto';
  aiMode: 'on' | 'off';
  aiSeedPrompt?: string;
  aiHistory?: Array<Record<string, unknown>>;
}

export interface StopMessageRoutingStateClearPlan {
  timestamp: number;
}

export interface StoplessDecisionContextSignals {
  portStopMessageDisabled: boolean;
  hasResponsesSubmitToolOutputsResume: boolean;
  planModeActive: boolean;
}

export interface StopMessageDefaultConfigPlan {
  enabled: boolean;
  text: string;
  maxRepeats: number;
}

export interface StopMessagePersistSnapshotPlan {
  text: string;
  providerKey?: string;
  maxRepeats: number;
  used: number;
  source: string;
  stageMode: string;
  aiMode: 'off';
}

export interface StopMessagePersistPlan {
  compareMaxRepeats: number;
  compareRemaining: number;
  nextMaxRepeats: number;
  nextUsed: number;
  snapshot: StopMessagePersistSnapshotPlan;
}

export interface RuntimeStopMessageStateFromMetadataCenterInput {
  runtimeMetadata?: unknown;
}

export interface StopMessageDefaultSnapshotInput {
  base: unknown;
  adapterContext?: unknown;
  options?: {
    text?: unknown;
    maxRepeats?: unknown;
  };
}

export interface StopMessageImplicitGeminiSnapshotInput {
  base: unknown;
  adapterContext?: unknown;
  providerProtocol?: string;
  record: Record<string, unknown>;
}

export interface ServertoolRecordRuntimeMetadataInput {
  record: Record<string, unknown>;
  runtimeMetadata?: unknown;
}

export interface ServertoolLoopStateSnapshot {
  flowId?: string;
  payloadHash: string;
  repeatCount?: number;
  startedAtMs?: number;
  stopPairHash?: string;
  stopPairRepeatCount?: number;
  stopPairWarned?: boolean;
}

export interface ServertoolLoopStatePlanInput {
  flowId?: string;
  decision?: {
    flowOnlyLoopLimit?: boolean;
  };
  previousLoopState?: Record<string, unknown> | null;
  payloadHash?: string | null;
  stopPairHash?: string | null;
  nowMs: number;
}

export interface ServertoolTimeoutPolicyInput {
  raw?: unknown;
}

export interface ServertoolTimeoutWatcherPlan {
  armed: boolean;
  timeoutMs: number;
}

export interface ServertoolClientDisconnectWatcherPlan {
  intervalMs: number;
}

export interface ServertoolErrorPlan {
  message: string;
  code: string;
  category: string;
  status: number;
  details: Record<string, unknown>;
}

export interface StopMessageBlockedReport {
  summary: string;
  blocker: string;
  impact?: string;
  nextAction?: string;
  evidence: string[];
}

export type ServertoolHookDirection = 'request' | 'response';

export type ServertoolHookRequiredness = 'required' | 'optional';

export type ServertoolReqHookPhase =
  | 'servertoolReqHook01ResultParsed'
  | 'servertoolReqHook02TextRewritten'
  | 'servertoolReqHook03ToolInjected'
  | 'servertoolReqHook04RequestFinalized';

export type ServertoolRespHookPhase =
  | 'servertoolRespHook01Intercepted'
  | 'servertoolRespHook02SchemaValidated'
  | 'servertoolRespHook03HookResponseInjected'
  | 'servertoolRespHook04FollowupPlanned'
  | 'servertoolRespHook05ReenterDispatched'
  | 'servertoolRespHook06ProjectionFinalized';

export interface ServertoolHookSpec {
  id: string;
  direction: ServertoolHookDirection;
  reqPhase?: ServertoolReqHookPhase;
  respPhase?: ServertoolRespHookPhase;
  requiredness: ServertoolHookRequiredness;
  priority: number;
  order: number;
  ownerFeatureId: string;
  inputNode: string;
  outputNode: string;
  effectKind: string;
  enabled?: boolean;
}

export function planStoplessExecutionWithNative(input: {
  flowId?: string;
  execution: unknown;
  requestTruthSessionId?: string;
  metadataCenterSnapshot?: unknown;
  runtimeControl?: unknown;
}): StoplessExecutionPlanOutput {
  const capability = 'planStoplessExecutionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error(`native ${capability} is required`);
  }
  const raw = fn(JSON.stringify({
    flowId: input.flowId ?? null,
    execution: input.execution,
    requestTruthSessionId: input.requestTruthSessionId ?? null,
    metadataCenterSnapshot: input.metadataCenterSnapshot ?? null,
    runtimeControl: input.runtimeControl ?? null
  }));
  const parsed = parseNativeJson(capability, raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`native ${capability} returned invalid stopless execution plan`);
  }
  const record = parsed as Record<string, unknown>;
  const execution = record.execution;
  const orchestrationPlan = record.orchestrationPlan;
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) {
    throw new Error(`native ${capability} returned invalid stopless execution payload`);
  }
  if (
    !orchestrationPlan ||
    typeof orchestrationPlan !== 'object' ||
    Array.isArray(orchestrationPlan)
  ) {
    throw new Error(`native ${capability} returned invalid stopless orchestration plan`);
  }
  return {
    execution: execution as Record<string, unknown>,
    orchestrationPlan: orchestrationPlan as StoplessExecutionPlanOutput['orchestrationPlan']
  };
}

export function buildStoplessAutoCliProjectionFromEngineWithNative(input: {
  metadataCenterSnapshot?: unknown;
  execution?: unknown;
  metadataWritePlan?: unknown;
  requestId?: string | null;
}): StoplessAutoCliProjectionFromEngineOutput {
  const capability = 'buildStoplessAutoCliProjectionFromEngineJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error(`native ${capability} is required`);
  }
  const parsed = parseNativeJson(capability, fn(JSON.stringify({
    metadataCenterSnapshot: input.metadataCenterSnapshot ?? null,
    execution: input.execution ?? null,
    metadataWritePlan: input.metadataWritePlan ?? null,
    requestId: input.requestId ?? null
  })));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`native ${capability} returned invalid projection output`);
  }
  const chatResponse = (parsed as Record<string, unknown>).chatResponse;
  if (!chatResponse || typeof chatResponse !== 'object' || Array.isArray(chatResponse)) {
    throw new Error(`native ${capability} returned invalid chatResponse`);
  }
  return {
    chatResponse: chatResponse as JsonObject
  };
}

export function resolveServertoolEnginePostflightPayloadWithNative(
  input: ServertoolEnginePostflightPayloadInput
): JsonObject {
  switch (input.runtimeAction.finalPayloadSource) {
    case 'engine_result':
      return input.engineResult.finalChatResponse;
    case 'stop_message_cli_projection': {
      const projection = buildStoplessAutoCliProjectionFromEngineWithNative({
        metadataCenterSnapshot: input.metadataCenterSnapshot ?? null,
        execution: input.engineResult.execution ?? null,
        metadataWritePlan: input.engineResult.metadataWritePlan ?? null,
        requestId: input.requestId ?? null
      });
      return projection.chatResponse;
    }
    default:
      throw Object.assign(new Error('[servertool] unexpected postflight payload source'), {
        code: 'SERVERTOOL_RUNTIME_ACTION_INVALID',
        details: {
          requestId: input.requestId ?? null,
          finalPayloadSource: input.runtimeAction.finalPayloadSource
        }
      });
  }
}

export interface ServertoolHookSchedulerInput {
  direction: ServertoolHookDirection;
  reqPhase?: ServertoolReqHookPhase;
  respPhase?: ServertoolRespHookPhase;
  hooks: ServertoolHookSpec[];
  requireAtLeastOneRequiredHook?: boolean;
}

export interface ServertoolHookEvent {
  hookId: string;
  status: string;
  effectKind: string;
  requiredness: ServertoolHookRequiredness;
  noOp: boolean;
}

export interface ServertoolHookProjection {
  direction: ServertoolHookDirection;
  phase: string;
  inputNode: string;
  outputNode: string;
  hookIds: string[];
  effectKinds: string[];
}

export interface ServertoolHookEffectPlan {
  events: ServertoolHookEvent[];
  projection: ServertoolHookProjection;
}

// ── Stop gateway context ────────────────────────────────────────────────────

function parseStopGatewayContextPayload(resultJson: string, capability: string): StopGatewayContext | null {
  const raw = JSON.parse(resultJson) as unknown;
  if (raw === null) {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${capability} native returned invalid context`);
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.observed !== 'boolean' || typeof record.eligible !== 'boolean') {
    throw new Error(`${capability} native returned invalid observed/eligible`);
  }
  const source = record.source;
  if (source !== 'chat' && source !== 'responses' && source !== 'none') {
    throw new Error(`${capability} native returned invalid source`);
  }
  if (typeof record.reason !== 'string' || !record.reason.trim()) {
    throw new Error(`${capability} native returned invalid reason`);
  }
  const choiceIndex = record.choice_index ?? record.choiceIndex;
  const hasToolCalls = record.has_tool_calls ?? record.hasToolCalls;
  return {
    observed: record.observed,
    eligible: record.eligible,
    source,
    reason: record.reason.trim(),
    ...(Number.isInteger(choiceIndex) ? { choiceIndex: choiceIndex as number } : {}),
    ...(typeof hasToolCalls === 'boolean' ? { hasToolCalls } : {}),
  };
}

function parseStopMessageCompareContextPayload(resultJson: string, capability: string): StopMessageCompareContext | null {
  const raw = JSON.parse(resultJson) as unknown;
  if (raw === null) {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${capability} native returned invalid compare context`);
  }
  const record = raw as Record<string, unknown>;
  const mode = record.mode;
  const decision = record.decision;
  if (mode !== 'off' && mode !== 'on' && mode !== 'auto') {
    throw new Error(`${capability} native returned invalid mode`);
  }
  if (decision !== 'trigger' && decision !== 'skip') {
    throw new Error(`${capability} native returned invalid decision`);
  }
  for (const key of [
    'armed',
    'allowModeOnly',
    'active',
    'stopEligible',
    'compactionRequest',
    'hasSeed',
  ]) {
    if (typeof record[key] !== 'boolean') {
      throw new Error(`${capability} native returned invalid boolean ${key}`);
    }
  }
  for (const key of ['textLength', 'maxRepeats', 'used', 'remaining']) {
    if (!Number.isInteger(record[key]) || (record[key] as number) < 0) {
      throw new Error(`${capability} native returned invalid integer ${key}`);
    }
  }
  if (typeof record.reason !== 'string' || !record.reason.trim()) {
    throw new Error(`${capability} native returned invalid reason`);
  }
  return {
    armed: record.armed as boolean,
    mode,
    allowModeOnly: record.allowModeOnly as boolean,
    textLength: record.textLength as number,
    maxRepeats: record.maxRepeats as number,
    used: record.used as number,
    remaining: record.remaining as number,
    active: record.active as boolean,
    stopEligible: record.stopEligible as boolean,
    compactionRequest: record.compactionRequest as boolean,
    hasSeed: record.hasSeed as boolean,
    decision,
    reason: record.reason.trim(),
    ...(typeof record.stage === 'string' && record.stage.trim() ? { stage: record.stage.trim() } : {}),
    ...(typeof record.bdWorkState === 'string' && record.bdWorkState.trim() ? { bdWorkState: record.bdWorkState.trim() } : {}),
    ...(typeof record.observationHash === 'string' && record.observationHash.trim() ? { observationHash: record.observationHash.trim() } : {}),
    ...(Number.isInteger(record.observationStableCount) ? { observationStableCount: record.observationStableCount as number } : {}),
    ...(typeof record.toolSignatureHash === 'string' && record.toolSignatureHash.trim() ? { toolSignatureHash: record.toolSignatureHash.trim() } : {}),
  };
}

// ── Loop guard ──────────────────────────────────────────────────────────────

// ── Budget counter ──────────────────────────────────────────────────────────

function parseRuntimeStopMessageStateSnapshotPayload(
  resultJson: string,
  capability: string,
): RuntimeStopMessageStateSnapshot | null {
  const parsed = JSON.parse(resultJson) as unknown;
  if (parsed === null) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} native returned invalid payload`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.text !== 'string' || !record.text.trim()) {
    throw new Error(`${capability} native returned invalid text`);
  }
  if (!Number.isInteger(record.maxRepeats) || (record.maxRepeats as number) <= 0) {
    throw new Error(`${capability} native returned invalid maxRepeats`);
  }
  if (!Number.isInteger(record.used) || (record.used as number) < 0) {
    throw new Error(`${capability} native returned invalid used`);
  }
  const stageMode = readStopMessageStageModeField(record.stageMode, `${capability} stageMode`);
  const aiMode = readStopMessageAiModeField(record.aiMode, `${capability} aiMode`);
  return {
    text: record.text.trim(),
    ...(typeof record.providerKey === 'string' && record.providerKey.trim() ? { providerKey: record.providerKey.trim() } : {}),
    maxRepeats: record.maxRepeats as number,
    used: record.used as number,
    ...(typeof record.source === 'string' && record.source.trim() ? { source: record.source.trim() } : {}),
    ...(typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? { updatedAt: record.updatedAt } : {}),
    ...(typeof record.lastUsedAt === 'number' && Number.isFinite(record.lastUsedAt) ? { lastUsedAt: record.lastUsedAt } : {}),
    ...(stageMode ? { stageMode } : {}),
    ...(aiMode ? { aiMode } : {})
  };
}

function readStopMessageStageModeField(value: unknown, source: string): 'on' | 'off' | 'auto' | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === 'on' || value === 'off' || value === 'auto') {
    return value;
  }
  throw new Error(`${source} returned invalid stop-message stage mode`);
}

function readStopMessageAiModeField(value: unknown, source: string): 'on' | 'off' | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === 'on' || value === 'off') {
    return value;
  }
  throw new Error(`${source} returned invalid stop-message ai mode`);
}

function parseStopMessageRoutingStateApplyPayload(
  resultJson: string,
  capability: string,
): StopMessageRoutingStateApplyPlan {
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} native returned invalid payload`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.source !== 'string' || !record.source.trim()) {
    throw new Error(`${capability} native returned invalid source`);
  }
  if (typeof record.text !== 'string' || !record.text.trim()) {
    throw new Error(`${capability} native returned invalid text`);
  }
  if (!Number.isInteger(record.maxRepeats) || (record.maxRepeats as number) <= 0) {
    throw new Error(`${capability} native returned invalid maxRepeats`);
  }
  if (!Number.isInteger(record.used) || (record.used as number) < 0) {
    throw new Error(`${capability} native returned invalid used`);
  }
  const stageMode = readStopMessageStageModeField(record.stageMode, `${capability} stageMode`);
  const aiMode = readStopMessageAiModeField(record.aiMode, `${capability} aiMode`);
  if (!aiMode) {
    throw new Error(`${capability} native returned invalid aiMode`);
  }
  const aiHistory = record.aiHistory;
  if (aiHistory !== undefined && !Array.isArray(aiHistory)) {
    throw new Error(`${capability} native returned invalid aiHistory`);
  }
  return {
    source: record.source.trim(),
    text: record.text.trim(),
    ...(typeof record.providerKey === 'string' && record.providerKey.trim() ? { providerKey: record.providerKey.trim() } : {}),
    maxRepeats: record.maxRepeats as number,
    used: record.used as number,
    ...(typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? { updatedAt: record.updatedAt } : {}),
    ...(typeof record.lastUsedAt === 'number' && Number.isFinite(record.lastUsedAt) ? { lastUsedAt: record.lastUsedAt } : {}),
    ...(stageMode ? { stageMode } : {}),
    aiMode,
    ...(typeof record.aiSeedPrompt === 'string' && record.aiSeedPrompt.trim() ? { aiSeedPrompt: record.aiSeedPrompt.trim() } : {}),
    ...(Array.isArray(aiHistory) ? { aiHistory: aiHistory as Array<Record<string, unknown>> } : {}),
  };
}

export function planStopMessageAutoHandlerWithNative<TPlan extends Record<string, unknown>>(
  input: Record<string, unknown>,
): TPlan {
  const capability = 'planStopMessageAutoHandlerJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planStopMessageAutoHandlerJson native unavailable');
  }
  const raw = fn(JSON.stringify(input));
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as TPlan;
  }
  if (typeof raw !== 'string') {
    throw new Error(`planStopMessageAutoHandlerJson native returned non-string: ${typeof raw}`);
  }
  return JSON.parse(raw) as TPlan;
}

function parseServertoolHookEffectPlanPayload(
  resultJson: string,
  capability: string,
): ServertoolHookEffectPlan {
  const raw = JSON.parse(resultJson) as unknown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${capability} native returned invalid effect plan`);
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.events)) {
    throw new Error(`${capability} native returned invalid events`);
  }
  return {
    events: record.events.map((event) => parseServertoolHookEvent(event, capability)),
    projection: parseServertoolHookProjectionRecord(record.projection, capability),
  };
}

function parseServertoolHookProjectionPayload(
  resultJson: string,
  capability: string,
): ServertoolHookProjection {
  return parseServertoolHookProjectionRecord(JSON.parse(resultJson) as unknown, capability);
}

function parseServertoolHookProjectionRecord(
  raw: unknown,
  capability: string,
): ServertoolHookProjection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${capability} native returned invalid projection`);
  }
  const record = raw as Record<string, unknown>;
  if (
    (record.direction !== 'request' && record.direction !== 'response') ||
    typeof record.phase !== 'string' ||
    typeof record.inputNode !== 'string' ||
    typeof record.outputNode !== 'string' ||
    !Array.isArray(record.hookIds) ||
    !record.hookIds.every((value) => typeof value === 'string') ||
    !Array.isArray(record.effectKinds) ||
    !record.effectKinds.every((value) => typeof value === 'string')
  ) {
    throw new Error(`${capability} native returned invalid projection fields`);
  }
  return record as unknown as ServertoolHookProjection;
}

function parseServertoolHookEvent(raw: unknown, capability: string): ServertoolHookEvent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${capability} native returned invalid hook event`);
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record.hookId !== 'string' ||
    typeof record.status !== 'string' ||
    typeof record.effectKind !== 'string' ||
    (record.requiredness !== 'required' && record.requiredness !== 'optional') ||
    typeof record.noOp !== 'boolean'
  ) {
    throw new Error(`${capability} native returned invalid hook event fields`);
  }
  return record as unknown as ServertoolHookEvent;
}

export function planAutoHookRuntimeAttemptWithNative(input: {
  hookId: string;
  phase: string;
  priority: number;
  queue: string;
  queueIndex: number;
  queueTotal: number;
  hasPlannedResult?: boolean;
  hasMaterializedResult?: boolean;
  error?: unknown;
  materializedFlowId?: string;
}): AutoHookRuntimeAttemptPlan {
  const capability = 'planAutoHookRuntimeAttemptJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planAutoHookRuntimeAttemptJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(encodeAutoHookRuntimeAttemptInput(input)));
  if (typeof resultJson !== 'string') {
    throw new Error(`planAutoHookRuntimeAttemptJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planAutoHookRuntimeAttemptJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  const trace = record.traceEvent;
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) {
    throw new Error('planAutoHookRuntimeAttemptJson native returned invalid traceEvent');
  }
  const traceRecord = trace as Record<string, unknown>;
  if (
    record.action !== 'return_result' &&
    record.action !== 'continue_queue' &&
    record.action !== 'rethrow_error'
  ) {
    throw new Error('planAutoHookRuntimeAttemptJson native returned invalid action');
  }
  if (
    typeof traceRecord.hookId !== 'string' ||
    typeof traceRecord.phase !== 'string' ||
    typeof traceRecord.priority !== 'number' ||
    typeof traceRecord.queue !== 'string' ||
    typeof traceRecord.queueIndex !== 'number' ||
    typeof traceRecord.queueTotal !== 'number' ||
    (traceRecord.result !== 'miss' && traceRecord.result !== 'match' && traceRecord.result !== 'error') ||
    typeof traceRecord.reason !== 'string' ||
    typeof record.returnResult !== 'boolean' ||
    typeof record.continueQueue !== 'boolean' ||
    typeof record.rethrowError !== 'boolean'
  ) {
    throw new Error('planAutoHookRuntimeAttemptJson native returned malformed plan');
  }
  const dispositions = [record.returnResult, record.continueQueue, record.rethrowError].filter(Boolean).length;
  if (dispositions !== 1) {
    throw new Error('planAutoHookRuntimeAttemptJson native returned invalid disposition cardinality');
  }
  if (record.returnResult === true && input.hasMaterializedResult !== true) {
    throw new Error('planAutoHookRuntimeAttemptJson native returned result disposition without materialized result');
  }
  if (record.rethrowError === true && input.error === undefined) {
    throw new Error('planAutoHookRuntimeAttemptJson native returned rethrow disposition without error input');
  }
  if (
    (record.action === 'return_result' && record.returnResult !== true) ||
    (record.action === 'continue_queue' && record.continueQueue !== true) ||
    (record.action === 'rethrow_error' && record.rethrowError !== true)
  ) {
    throw new Error('planAutoHookRuntimeAttemptJson native returned action/disposition mismatch');
  }
  const traceQueue =
    traceRecord.queue === 'A_optional' || traceRecord.queue === 'B_mandatory'
      ? traceRecord.queue
      : (() => {
          throw new Error('planAutoHookRuntimeAttemptJson native returned invalid queue');
        })();
  return {
    action: record.action,
    traceEvent: {
      hookId: traceRecord.hookId,
      phase: traceRecord.phase,
      priority: traceRecord.priority,
      queue: traceQueue,
      queueIndex: traceRecord.queueIndex,
      queueTotal: traceRecord.queueTotal,
      result: traceRecord.result,
      reason: traceRecord.reason,
      ...(typeof traceRecord.flowId === 'string' && traceRecord.flowId.trim()
        ? { flowId: traceRecord.flowId.trim() }
        : {})
    },
    returnResult: record.returnResult,
    continueQueue: record.continueQueue,
    rethrowError: record.rethrowError,
    ...(typeof record.errorMessage === 'string' && record.errorMessage.trim()
      ? { errorMessage: record.errorMessage.trim() }
      : {})
  };
}

export function resolveAutoHookRuntimeAttemptDecisionWithNative(input: {
  hookId: string;
  phase: string;
  priority: number;
  queue: string;
  queueIndex: number;
  queueTotal: number;
  hasPlannedResult?: boolean;
  hasMaterializedResult?: boolean;
  error?: unknown;
  materializedFlowId?: string;
}): AutoHookRuntimeAttemptDecision {
  const plan = planAutoHookRuntimeAttemptWithNative(input);
  switch (plan.action) {
    case 'return_result':
      return {
        traceEvent: plan.traceEvent,
        returnResult: true,
        continueQueue: false,
        rethrowError: false
      };
    case 'continue_queue':
      return {
        traceEvent: plan.traceEvent,
        returnResult: false,
        continueQueue: true,
        rethrowError: false
      };
    case 'rethrow_error':
      return {
        traceEvent: plan.traceEvent,
        returnResult: false,
        continueQueue: false,
        rethrowError: true,
        ...(plan.errorMessage ? { errorMessage: plan.errorMessage } : {})
      };
    default:
      throw new Error('[servertool] invalid auto-hook attempt action');
  }
}

function encodeAutoHookRuntimeAttemptInput(input: {
  hookId: string;
  phase: string;
  priority: number;
  queue: string;
  queueIndex: number;
  queueTotal: number;
  hasPlannedResult?: boolean;
  hasMaterializedResult?: boolean;
  error?: unknown;
  materializedFlowId?: string;
}): Record<string, unknown> {
  return {
    ...input,
    error: encodeServertoolHandlerErrorCarrier(input.error)
  };
}

export function planAutoHookCallerFinalizationWithNative(input: {
  resultPresent: boolean;
  metadataWritePlanPresent?: boolean;
  chatResponse?: JsonObject;
  execution?: NativeServerToolExecution;
  metadataWritePlan?: JsonObject;
  queueIndex: number;
  queueTotal: number;
}): AutoHookCallerFinalizationPlan {
  const capability = 'planAutoHookCallerFinalizationJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planAutoHookCallerFinalizationJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  const parsed = typeof resultJson === 'string'
    ? JSON.parse(resultJson) as unknown
    : resultJson;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planAutoHookCallerFinalizationJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'return_result' &&
    record.action !== 'continue_next_queue' &&
    record.action !== 'return_null'
  ) {
    throw new Error('planAutoHookCallerFinalizationJson native returned invalid action');
  }
  if (
    typeof record.returnResult !== 'boolean' ||
    typeof record.continueNextQueue !== 'boolean' ||
    typeof record.returnNull !== 'boolean'
  ) {
    throw new Error('planAutoHookCallerFinalizationJson native returned malformed plan');
  }
  const dispositions = [record.returnResult, record.continueNextQueue, record.returnNull].filter(Boolean).length;
  if (dispositions !== 1) {
    throw new Error('planAutoHookCallerFinalizationJson native returned invalid disposition cardinality');
  }
  if (record.returnResult === true && input.resultPresent !== true) {
    throw new Error('planAutoHookCallerFinalizationJson native returned result disposition without queue result');
  }
  if (record.action === 'return_result' && record.resultMode !== 'tool_flow') {
    throw new Error('planAutoHookCallerFinalizationJson native returned invalid resultMode');
  }
  if (record.action === 'return_result' && (!record.result || typeof record.result !== 'object' || Array.isArray(record.result))) {
    throw new Error('planAutoHookCallerFinalizationJson native returned missing result');
  }
  if (record.action !== 'return_result' && record.resultMode !== undefined) {
    throw new Error('planAutoHookCallerFinalizationJson native returned resultMode for non-result action');
  }
  if (record.action !== 'return_result' && record.result !== undefined) {
    throw new Error('planAutoHookCallerFinalizationJson native returned result for non-result action');
  }
  if (
    (record.action === 'return_result' && record.returnResult !== true) ||
    (record.action === 'continue_next_queue' && record.continueNextQueue !== true) ||
    (record.action === 'return_null' && record.returnNull !== true)
  ) {
    throw new Error('planAutoHookCallerFinalizationJson native returned action/disposition mismatch');
  }
  if (record.action === 'return_result') {
    const result = record.result as Record<string, unknown>;
    if (result.mode !== 'tool_flow' || !result.finalChatResponse || typeof result.finalChatResponse !== 'object' || Array.isArray(result.finalChatResponse)) {
      throw new Error('planAutoHookCallerFinalizationJson native returned malformed result');
    }
    if (!result.execution || typeof result.execution !== 'object' || Array.isArray(result.execution) || typeof (result.execution as Record<string, unknown>).flowId !== 'string') {
      throw new Error('planAutoHookCallerFinalizationJson native returned malformed execution');
    }
    if (input.metadataWritePlanPresent !== true && 'metadataWritePlan' in result) {
      throw new Error('planAutoHookCallerFinalizationJson native returned unexpected metadataWritePlan');
    }
    if (input.metadataWritePlanPresent === true && (!('metadataWritePlan' in result) || !result.metadataWritePlan || typeof result.metadataWritePlan !== 'object' || Array.isArray(result.metadataWritePlan))) {
      throw new Error('planAutoHookCallerFinalizationJson native omitted requested metadataWritePlan');
    }
    return {
      action: 'return_result',
      returnResult: true,
      continueNextQueue: false,
      returnNull: false,
      resultMode: 'tool_flow',
      result: {
        mode: 'tool_flow',
        finalChatResponse: result.finalChatResponse as JsonObject,
        execution: result.execution as NativeServerToolExecution,
        ...(input.metadataWritePlanPresent === true ? { metadataWritePlan: result.metadataWritePlan as JsonObject } : {})
      }
    };
  }
  if (record.action === 'continue_next_queue') {
    return {
      action: 'continue_next_queue',
      returnResult: false,
      continueNextQueue: true,
      returnNull: false
    };
  }
  return {
    action: 'return_null',
    returnResult: false,
    continueNextQueue: false,
    returnNull: true
  };
}

export function resolveAutoHookCallerFinalizationDecisionWithNative(input: {
  resultPresent: boolean;
  metadataWritePlanPresent?: boolean;
  chatResponse?: JsonObject;
  execution?: NativeServerToolExecution;
  metadataWritePlan?: JsonObject;
  queueIndex: number;
  queueTotal: number;
}): AutoHookCallerFinalizationDecision {
  const plan = planAutoHookCallerFinalizationWithNative(input);
  switch (plan.action) {
    case 'return_result':
      return {
        returnResult: true,
        continueNextQueue: false,
        returnNull: false,
        result: plan.result
      };
    case 'continue_next_queue':
      return {
        returnResult: false,
        continueNextQueue: true,
        returnNull: false
      };
    case 'return_null':
      return {
        returnResult: false,
        continueNextQueue: false,
        returnNull: true
      };
    default:
      throw new Error('[servertool] invalid auto-hook caller finalization action');
  }
}

export function planServertoolExecutionBranchWithNative(input: {
  executableToolCalls: Array<{
    id: string;
    name: string;
    arguments?: string;
    executionMode?: string;
  }>;
  executedToolCallsLen: number;
}): ServertoolExecutionBranchPlan {
  const capability = 'planServertoolExecutionBranchJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolExecutionBranchJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolExecutionBranchJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolExecutionBranchJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'client_exec_cli_projection' &&
    record.action !== 'resolve_execution_outcome' &&
    record.action !== 'continue_response_stage'
  ) {
    throw new Error('planServertoolExecutionBranchJson native returned invalid action');
  }
  if (record.projectedToolCallId !== undefined && typeof record.projectedToolCallId !== 'string') {
    throw new Error('planServertoolExecutionBranchJson native returned invalid projectedToolCallId');
  }
  if (record.projectedToolCall !== undefined) {
    if (!record.projectedToolCall || typeof record.projectedToolCall !== 'object' || Array.isArray(record.projectedToolCall)) {
      throw new Error('planServertoolExecutionBranchJson native returned invalid projectedToolCall');
    }
    const projected = record.projectedToolCall as Record<string, unknown>;
    if (
      typeof projected.id !== 'string' ||
      typeof projected.name !== 'string' ||
      typeof projected.arguments !== 'string'
    ) {
      throw new Error('planServertoolExecutionBranchJson native returned invalid projectedToolCall');
    }
  }
  if (
    record.projectedToolCallIndex !== undefined &&
    (!Number.isInteger(record.projectedToolCallIndex) || Number(record.projectedToolCallIndex) < 0)
  ) {
    throw new Error('planServertoolExecutionBranchJson native returned invalid projectedToolCallIndex');
  }
  if (record.action === 'client_exec_cli_projection' && record.projectedToolCall === undefined) {
    throw new Error('planServertoolExecutionBranchJson native returned missing projectedToolCall');
  }
  if (record.action !== 'client_exec_cli_projection') {
    return { action: record.action };
  }
  const projectedToolCall = record.projectedToolCall as unknown as ServertoolProjectedToolCall;
  return {
    action: record.action,
    projectedToolCall,
    ...(typeof record.projectedToolCallId === 'string' && record.projectedToolCallId.trim()
      ? { projectedToolCallId: record.projectedToolCallId }
      : {}),
    ...(Number.isInteger(record.projectedToolCallIndex) && Number(record.projectedToolCallIndex) >= 0
      ? { projectedToolCallIndex: Number(record.projectedToolCallIndex) }
      : {})
  };
}

function planServertoolExecutionBranchApplicationWithNative(input: {
  branchPlan: ServertoolExecutionBranchPlan;
  phase: 'pre_execution' | 'post_execution';
}): (
  | {
      projectClientExecCli: true;
      resolveExecutionOutcome: false;
      continueResponseStage: false;
      projectedToolCall: ServertoolProjectedToolCall;
    }
  | {
      projectClientExecCli: false;
      resolveExecutionOutcome: true;
      continueResponseStage: false;
      projectedToolCall?: never;
    }
  | {
      projectClientExecCli: false;
      resolveExecutionOutcome: false;
      continueResponseStage: true;
      projectedToolCall?: never;
    }
) {
  const capability = 'planServertoolExecutionBranchApplicationJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolExecutionBranchApplicationJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolExecutionBranchApplicationJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolExecutionBranchApplicationJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.projectClientExecCli !== 'boolean' ||
    typeof record.resolveExecutionOutcome !== 'boolean' ||
    typeof record.continueResponseStage !== 'boolean'
  ) {
    throw new Error('planServertoolExecutionBranchApplicationJson native returned invalid booleans');
  }
  const enabledCount = [
    record.projectClientExecCli,
    record.resolveExecutionOutcome,
    record.continueResponseStage
  ].filter(Boolean).length;
  if (enabledCount !== 1) {
    throw new Error('planServertoolExecutionBranchApplicationJson native returned ambiguous plan');
  }
  if (record.projectClientExecCli) {
    if (!record.projectedToolCall || typeof record.projectedToolCall !== 'object' || Array.isArray(record.projectedToolCall)) {
      throw new Error('planServertoolExecutionBranchApplicationJson native returned invalid projectedToolCall');
    }
    const projected = record.projectedToolCall as Record<string, unknown>;
    if (
      typeof projected.id !== 'string' ||
      typeof projected.name !== 'string' ||
      typeof projected.arguments !== 'string'
    ) {
      throw new Error('planServertoolExecutionBranchApplicationJson native returned invalid projectedToolCall');
    }
    return {
      projectClientExecCli: true,
      resolveExecutionOutcome: false,
      continueResponseStage: false,
      projectedToolCall: projected as unknown as ServertoolProjectedToolCall
    };
  }
  if (record.resolveExecutionOutcome) {
    return {
      projectClientExecCli: false,
      resolveExecutionOutcome: true,
      continueResponseStage: false
    };
  }
  return {
    projectClientExecCli: false,
    resolveExecutionOutcome: false,
    continueResponseStage: true
  };
}

export function resolveServertoolPreExecutionBranchDecisionWithNative(input: {
  executableToolCalls: Array<{
    id: string;
    name: string;
    arguments?: string;
    executionMode?: string;
  }>;
}): ServertoolPreExecutionBranchDecision {
  const branchPlan = planServertoolExecutionBranchWithNative({
    executableToolCalls: input.executableToolCalls,
    executedToolCallsLen: 0
  });
  const application = planServertoolExecutionBranchApplicationWithNative({
    branchPlan,
    phase: 'pre_execution'
  });
  if (application.projectClientExecCli) {
    return {
      projectClientExecCli: true,
      continueResponseStage: false,
      projectedToolCall: application.projectedToolCall
    };
  }
  return {
    projectClientExecCli: false,
    continueResponseStage: true
  };
}

export function resolveServertoolPostExecutionBranchDecisionWithNative(input: {
  executableToolCalls: Array<{
    id: string;
    name: string;
    arguments?: string;
    executionMode?: string;
  }>;
  executedToolCallsLen: number;
}): ServertoolPostExecutionBranchDecision {
  const branchPlan = planServertoolExecutionBranchWithNative(input);
  const application = planServertoolExecutionBranchApplicationWithNative({
    branchPlan,
    phase: 'post_execution'
  });
  if (application.resolveExecutionOutcome) {
    return {
      resolveExecutionOutcome: true,
      continueResponseStage: false
    };
  }
  return {
    resolveExecutionOutcome: false,
    continueResponseStage: true
  };
}

export function planServertoolEnginePreflightWithNative(input: {
  hasSyntheticControlText: boolean;
  stopSignalObserved: boolean;
  chat?: JsonObject;
  stopSignal?: unknown;
  stoplessDisabledOnDirectRoute?: boolean;
  adapterContext?: unknown;
}): ServertoolEnginePreflightPlan {
  const capability = 'planServertoolEnginePreflightJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolEnginePreflightJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolEnginePreflightJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolEnginePreflightJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'return_original_chat' &&
    record.action !== 'return_original_chat_direct_passthrough' &&
    record.action !== 'continue_to_engine'
  ) {
    throw new Error('planServertoolEnginePreflightJson native returned invalid action');
  }
  if (typeof record.attachStopGatewayContext !== 'boolean') {
    throw new Error('planServertoolEnginePreflightJson native returned invalid attachStopGatewayContext');
  }
  if (!record.result || typeof record.result !== 'object' || Array.isArray(record.result)) {
    throw new Error('planServertoolEnginePreflightJson native returned invalid result');
  }
  const result = record.result as Record<string, unknown>;
  if (
    (result.kind === 'return_original_chat' || result.kind === 'return_original_chat_direct_passthrough') &&
    (!result.chat || typeof result.chat !== 'object' || Array.isArray(result.chat))
  ) {
    throw new Error('planServertoolEnginePreflightJson native returned invalid chat result');
  }
  if (result.kind === 'continue' && result.stopSignal == null) {
    throw new Error('planServertoolEnginePreflightJson native returned invalid continue result');
  }
  if (
    result.kind !== 'return_original_chat' &&
    result.kind !== 'return_original_chat_direct_passthrough' &&
    result.kind !== 'continue'
  ) {
    throw new Error('planServertoolEnginePreflightJson native returned invalid result kind');
  }
  const logStopEntry = parseServertoolEnginePreflightLogStopEntry(record.logStopEntry);
  const logStopCompare = parseServertoolEnginePreflightLogStopCompare(record.logStopCompare);
  return {
    action: record.action,
    attachStopGatewayContext: record.attachStopGatewayContext,
    result: result.kind === 'continue'
      ? { kind: 'continue', stopSignal: result.stopSignal }
      : { kind: result.kind, chat: result.chat as JsonObject },
    ...(logStopEntry ? { logStopEntry } : {}),
    ...(logStopCompare ? { logStopCompare } : {})
  };
}

export function resolveServertoolEnginePreflightDecisionWithNative(input: {
  preflightAction: ServertoolEnginePreflightPlan;
}): ServertoolEnginePreflightDecision {
  switch (input.preflightAction.action) {
    case 'return_original_chat':
      return {
        result: input.preflightAction.result,
        shouldRunSideEffects: false
      };
    case 'return_original_chat_direct_passthrough':
    case 'continue_to_engine':
      return {
        result: input.preflightAction.result,
        shouldRunSideEffects: true
      };
    default:
      throw new Error('[servertool] invalid engine preflight action');
  }
}

export function planServertoolEngineOrchestrationPreflightActionWithNative(input: {
  preflightKind: 'return_original_chat' | 'return_original_chat_direct_passthrough' | 'continue';
}): ServertoolEngineOrchestrationPreflightActionPlan {
  const capability = 'planServertoolEngineOrchestrationPreflightActionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolEngineOrchestrationPreflightActionJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolEngineOrchestrationPreflightActionJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolEngineOrchestrationPreflightActionJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (record.action !== 'return_preflight_chat' && record.action !== 'continue_engine') {
    throw new Error('planServertoolEngineOrchestrationPreflightActionJson native returned invalid action');
  }
  return {
    action: record.action
  };
}

export function resolveServertoolEngineOrchestrationPreflightDecisionWithNative(input: {
  preflight: {
    kind: 'return_original_chat' | 'return_original_chat_direct_passthrough' | 'continue';
    chat?: JsonObject;
    stopSignal?: unknown;
  };
}): ServertoolEngineOrchestrationPreflightDecision {
  const actionPlan = planServertoolEngineOrchestrationPreflightActionWithNative({
    preflightKind: input.preflight.kind
  });
  const capability = 'planServertoolEngineOrchestrationPreflightApplicationJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolEngineOrchestrationPreflightApplicationJson native unavailable');
  }
  const resultJson = fn(JSON.stringify({
    actionPlan,
    preflightKind: input.preflight.kind,
    ...(input.preflight.chat !== undefined ? { chat: input.preflight.chat } : {}),
    ...(input.preflight.stopSignal !== undefined ? { stopSignal: input.preflight.stopSignal } : {})
  }));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolEngineOrchestrationPreflightApplicationJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolEngineOrchestrationPreflightApplicationJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.returnPreflightChat !== 'boolean' || typeof record.continueEngine !== 'boolean') {
    throw new Error('planServertoolEngineOrchestrationPreflightApplicationJson native returned invalid booleans');
  }
  if (record.returnPreflightChat === record.continueEngine) {
    throw new Error('planServertoolEngineOrchestrationPreflightApplicationJson native returned ambiguous plan');
  }
  if (record.returnPreflightChat) {
    if (!record.chat || typeof record.chat !== 'object' || Array.isArray(record.chat)) {
      throw new Error('planServertoolEngineOrchestrationPreflightApplicationJson native returned invalid chat');
    }
    return {
      returnPreflightChat: true,
      continueEngine: false,
      chat: record.chat as JsonObject
    };
  }
  return {
    returnPreflightChat: false,
    continueEngine: true,
    ...(record.stopSignal !== undefined ? { stopSignal: record.stopSignal } : {})
  };
}

function parseServertoolEnginePreflightStage(value: unknown, field: string): 'entry' | 'trigger' {
  if (value === 'entry' || value === 'trigger') {
    return value;
  }
  throw new Error(`planServertoolEnginePreflightJson native returned invalid ${field}`);
}

function parseServertoolEnginePreflightLogStopEntry(value: unknown): ServertoolEnginePreflightPlan['logStopEntry'] {
  if (value == null) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('planServertoolEnginePreflightJson native returned invalid logStopEntry');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.result !== 'string') {
    throw new Error('planServertoolEnginePreflightJson native returned invalid logStopEntry.result');
  }
  if (typeof record.includeChoiceFacts !== 'boolean') {
    throw new Error('planServertoolEnginePreflightJson native returned invalid logStopEntry.includeChoiceFacts');
  }
  return {
    stage: parseServertoolEnginePreflightStage(record.stage, 'logStopEntry.stage'),
    result: record.result,
    includeChoiceFacts: record.includeChoiceFacts
  };
}

function parseServertoolEnginePreflightLogStopCompare(value: unknown): ServertoolEnginePreflightPlan['logStopCompare'] {
  if (value == null) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('planServertoolEnginePreflightJson native returned invalid logStopCompare');
  }
  const record = value as Record<string, unknown>;
  return {
    stage: parseServertoolEnginePreflightStage(record.stage, 'logStopCompare.stage')
  };
}

export function planServertoolEngineRuntimeActionWithNative(input: {
  isStopMessageFlow: boolean;
  stoplessExecutionFlowId?: string;
  stoplessAction: string;
  engineExecutionFlowId?: string;
  currentFlowId?: string;
}): ServertoolEngineRuntimeActionPlan {
  const capability = 'planServertoolEngineRuntimeActionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolEngineRuntimeActionJson native unavailable');
  }
  const payload: Record<string, unknown> = {
    isStopMessageFlow: input.isStopMessageFlow,
    ...(typeof input.stoplessExecutionFlowId === 'string'
      ? { stoplessExecutionFlowId: input.stoplessExecutionFlowId }
      : {}),
    stoplessAction: input.stoplessAction,
    ...(typeof input.engineExecutionFlowId === 'string'
      ? { engineExecutionFlowId: input.engineExecutionFlowId }
      : {}),
    ...(typeof input.currentFlowId === 'string'
      ? { currentFlowId: input.currentFlowId }
      : {})
  };
  const raw = fn(JSON.stringify(payload));
  const parsed = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolEngineRuntimeActionJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'return_servertool_cli_projection_final' &&
    record.action !== 'return_stop_message_terminal_final' &&
    record.action !== 'build_stop_message_cli_projection'
  ) {
    throw new Error('planServertoolEngineRuntimeActionJson native returned invalid action');
  }
  if (record.executed !== true) {
    throw new Error('planServertoolEngineRuntimeActionJson native returned invalid executed flag');
  }
  if (record.flowIdSource !== 'engine_execution' && record.flowIdSource !== 'current_flow') {
    throw new Error('planServertoolEngineRuntimeActionJson native returned invalid flowIdSource');
  }
  if (typeof record.progressStatus !== 'string' || record.progressStatus.trim().length === 0) {
    throw new Error('planServertoolEngineRuntimeActionJson native returned invalid progressStatus');
  }
  if (record.finalPayloadSource !== 'engine_result' && record.finalPayloadSource !== 'stop_message_cli_projection') {
    throw new Error('planServertoolEngineRuntimeActionJson native returned invalid finalPayloadSource');
  }
  if (record.projectedFlowId != null && typeof record.projectedFlowId !== 'string') {
    throw new Error('planServertoolEngineRuntimeActionJson native returned invalid projectedFlowId');
  }
  return {
    action: record.action,
    executed: true,
    flowIdSource: record.flowIdSource,
    progressStatus: record.progressStatus,
    finalPayloadSource: record.finalPayloadSource,
    ...(typeof record.projectedFlowId === 'string'
      ? { projectedFlowId: record.projectedFlowId }
      : {})
  };
}

export function runStoplessBuiltinHandlerForRuntimeWithNative(input: {
  name: string;
  base: JsonObject;
  requestId: string;
  runtimeMetadata?: JsonObject | null;
}): unknown {
  const capability = 'runStoplessBuiltinHandlerForRuntimeJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('runStoplessBuiltinHandlerForRuntimeJson native unavailable');
  }
  const raw = fn(JSON.stringify({
    name: input.name,
    base: input.base,
    requestId: input.requestId,
    runtimeMetadata: input.runtimeMetadata ?? null
  }));
  if (typeof raw !== 'string') {
    throw new Error(`runStoplessBuiltinHandlerForRuntimeJson native returned non-string: ${typeof raw}`);
  }
  return JSON.parse(raw) as unknown;
}

export function planServertoolEngineTriggerObservationWithNative(input: {
  stopSignalObserved: boolean;
  result: string;
  flowId?: string;
}): ServertoolEngineTriggerObservationPlan {
  const capability = 'planServertoolEngineTriggerObservationJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolEngineTriggerObservationJson native unavailable');
  }
  const resultJson = fn(JSON.stringify({
    stopSignalObserved: input.stopSignalObserved,
    result: input.result,
    ...(input.flowId !== undefined ? { flowId: input.flowId } : {})
  }));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolEngineTriggerObservationJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolEngineTriggerObservationJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.shouldLog !== 'boolean') {
    throw new Error('planServertoolEngineTriggerObservationJson native returned invalid shouldLog');
  }
  const logStopEntry = parseServertoolEngineTriggerLogStopEntry(record.logStopEntry);
  const logStopCompare = parseServertoolEngineTriggerLogStopCompare(record.logStopCompare);
  return {
    shouldLog: record.shouldLog,
    ...(logStopEntry ? { logStopEntry } : {}),
    ...(logStopCompare ? { logStopCompare } : {})
  };
}

function parseServertoolEngineTriggerLogStopEntry(value: unknown): ServertoolEngineTriggerObservationPlan['logStopEntry'] {
  if (value == null) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('planServertoolEngineTriggerObservationJson native returned invalid logStopEntry');
  }
  const record = value as Record<string, unknown>;
  if (record.stage !== 'trigger') {
    throw new Error('planServertoolEngineTriggerObservationJson native returned invalid logStopEntry.stage');
  }
  if (typeof record.result !== 'string' || !record.result.trim()) {
    throw new Error('planServertoolEngineTriggerObservationJson native returned invalid logStopEntry.result');
  }
  return {
    stage: 'trigger',
    result: record.result
  };
}

function parseServertoolEngineTriggerLogStopCompare(value: unknown): ServertoolEngineTriggerObservationPlan['logStopCompare'] {
  if (value == null) {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('planServertoolEngineTriggerObservationJson native returned invalid logStopCompare');
  }
  const record = value as Record<string, unknown>;
  if (record.stage !== 'trigger') {
    throw new Error('planServertoolEngineTriggerObservationJson native returned invalid logStopCompare.stage');
  }
  if (record.flowId !== undefined && typeof record.flowId !== 'string') {
    throw new Error('planServertoolEngineTriggerObservationJson native returned invalid logStopCompare.flowId');
  }
  return {
    stage: 'trigger',
    ...(typeof record.flowId === 'string' && record.flowId.trim()
      ? { flowId: record.flowId }
      : {})
  };
}

export function planServertoolEngineSkipWithNative(input: {
  engineMode: string;
  hasExecution: boolean;
  finalChatResponse: JsonObject;
}): ServertoolEngineSkipPlan {
  const capability = 'planServertoolEngineSkipJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolEngineSkipJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolEngineSkipJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolEngineSkipJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'return_skipped_passthrough' &&
    record.action !== 'return_skipped_no_execution' &&
    record.action !== 'continue_matched_flow'
  ) {
    throw new Error('planServertoolEngineSkipJson native returned invalid action');
  }
  if (record.skipReason !== undefined && typeof record.skipReason !== 'string') {
    throw new Error('planServertoolEngineSkipJson native returned invalid skipReason');
  }
  if (record.action === 'return_skipped_passthrough' || record.action === 'return_skipped_no_execution') {
    if (typeof record.skipReason !== 'string' || !/\S/.test(record.skipReason)) {
      throw new Error('planServertoolEngineSkipJson native returned skipped action without skipReason');
    }
    if (typeof record.triggerResult !== 'string' || !/\S/.test(record.triggerResult)) {
      throw new Error('planServertoolEngineSkipJson native returned skipped action without triggerResult');
    }
    if (!record.shellResult || typeof record.shellResult !== 'object' || Array.isArray(record.shellResult)) {
      throw new Error('planServertoolEngineSkipJson native returned skipped action without shellResult');
    }
    const shellResult = record.shellResult as Record<string, unknown>;
    if (!shellResult.chat || typeof shellResult.chat !== 'object' || Array.isArray(shellResult.chat)) {
      throw new Error('planServertoolEngineSkipJson native returned invalid shellResult chat');
    }
    if (shellResult.executed !== false) {
      throw new Error('planServertoolEngineSkipJson native returned invalid shellResult executed flag');
    }
    return {
      action: record.action,
      skipReason: record.skipReason,
      triggerResult: record.triggerResult,
      shellResult: {
        chat: shellResult.chat as JsonObject,
        executed: false
      }
    };
  }
  return {
    action: record.action
  };
}

export function resolveServertoolEngineSkipDecisionWithNative(input: {
  engineMode: string;
  hasExecution: boolean;
  finalChatResponse: JsonObject;
}): ServertoolEngineSkipDecision {
  const skipPlan = planServertoolEngineSkipWithNative(input);
  const capability = 'planServertoolEngineSkipApplicationJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolEngineSkipApplicationJson native unavailable');
  }
  const resultJson = fn(JSON.stringify({ skipPlan }));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolEngineSkipApplicationJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolEngineSkipApplicationJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.returnSkipped !== 'boolean' || typeof record.continueMatchedFlow !== 'boolean') {
    throw new Error('planServertoolEngineSkipApplicationJson native returned invalid booleans');
  }
  if (record.returnSkipped === record.continueMatchedFlow) {
    throw new Error('planServertoolEngineSkipApplicationJson native returned ambiguous plan');
  }
  if (record.returnSkipped) {
    if (typeof record.skipReason !== 'string' || !/\S/.test(record.skipReason)) {
      throw new Error('planServertoolEngineSkipApplicationJson native returned invalid skipReason');
    }
    if (typeof record.triggerResult !== 'string' || !record.triggerResult.trim()) {
      throw new Error('planServertoolEngineSkipApplicationJson native returned invalid triggerResult');
    }
    if (!record.shellResult || typeof record.shellResult !== 'object' || Array.isArray(record.shellResult)) {
      throw new Error('planServertoolEngineSkipApplicationJson native returned invalid shellResult');
    }
    const shellResult = record.shellResult as Record<string, unknown>;
    if (!shellResult.chat || typeof shellResult.chat !== 'object' || Array.isArray(shellResult.chat)) {
      throw new Error('planServertoolEngineSkipApplicationJson native returned invalid shellResult.chat');
    }
    if (shellResult.executed !== false) {
      throw new Error('planServertoolEngineSkipApplicationJson native returned invalid shellResult.executed');
    }
    return {
      returnSkipped: true,
      continueMatchedFlow: false,
      skipReason: record.skipReason,
      triggerResult: record.triggerResult,
      shellResult: {
        chat: shellResult.chat as JsonObject,
        executed: false
      }
    };
  }
  return {
    returnSkipped: false,
    continueMatchedFlow: true
  };
}

export function planServertoolExecutionOutcomeMaterializationWithNative(input: {
  requestId: string;
  outcomeMode: string;
  requiresPendingInjection: boolean;
  hasLastExecution: boolean;
  executedToolCallsLen: number;
  lastExecution?: unknown;
  flowId?: string;
}): ServertoolExecutionOutcomeMaterializationPlan {
  const capability = 'planServertoolExecutionOutcomeMaterializationJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolExecutionOutcomeMaterializationJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolExecutionOutcomeMaterializationJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolExecutionOutcomeMaterializationJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (record.action !== 'throw_dispatch_error' && record.action !== 'return_tool_flow') {
    throw new Error('planServertoolExecutionOutcomeMaterializationJson native returned invalid action');
  }
  if (record.action === 'throw_dispatch_error') {
    if (!record.errorPlan || typeof record.errorPlan !== 'object' || Array.isArray(record.errorPlan)) {
      throw new Error('planServertoolExecutionOutcomeMaterializationJson native returned invalid errorPlan');
    }
    return {
      action: 'throw_dispatch_error',
      errorPlan: parseServertoolErrorPlan(JSON.stringify(record.errorPlan), capability)
    };
  }
  if (typeof record.executionFlowId !== 'string') {
    throw new Error('planServertoolExecutionOutcomeMaterializationJson native returned invalid executionFlowId');
  }
  if (record.resultMode !== 'tool_flow') {
    throw new Error('planServertoolExecutionOutcomeMaterializationJson native returned invalid resultMode');
  }
  return {
    action: 'return_tool_flow',
    resultMode: record.resultMode,
    executionFlowId: record.executionFlowId
  };
}

export function createServertoolProviderProtocolErrorFromPlanWithNative(
  plan: ServertoolErrorPlan
): ProviderProtocolError & { status?: number } {
  const err = new ProviderProtocolError(plan.message, {
    code: plan.code as ProviderProtocolErrorCode,
    category: plan.category as ProviderErrorCategory,
    details: plan.details
  }) as ProviderProtocolError & { status?: number };
  err.status = plan.status;
  return err;
}

export function materializeNativeToolCallExecutionOutcomeWithNative(args: {
  baseForExecution: JsonObject;
  options: {
    requestId: string;
    adapterContext?: unknown;
  };
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  executionState: NativeServertoolExecutionLoopState;
}): NativeServertoolMaterializedEngineResult {
  const outcomePlan = planServertoolOutcomeWithNative(
    buildServertoolOutcomePlanInputWithNative({
      toolCalls: args.toolCalls,
      executionState: args.executionState,
      adapterContext: args.options.adapterContext,
      baseForExecution: args.baseForExecution,
    })
  );

  const materializationPlan = planServertoolExecutionOutcomeMaterializationWithNative({
    requestId: args.options.requestId,
    outcomeMode: outcomePlan.outcomeMode,
    requiresPendingInjection: outcomePlan.requiresPendingInjection,
    hasLastExecution: args.executionState.lastExecution != null,
    executedToolCallsLen: args.executionState.executedToolCalls.length,
    lastExecution: args.executionState.lastExecution,
    flowId: outcomePlan.flowId
  });

  switch (materializationPlan.action) {
    case 'throw_dispatch_error':
      throw createServertoolProviderProtocolErrorFromPlanWithNative(materializationPlan.errorPlan);
    case 'return_tool_flow':
      return {
        mode: materializationPlan.resultMode,
        finalChatResponse: args.baseForExecution,
        execution: {
          flowId: materializationPlan.executionFlowId
        }
      };
    default:
      throw new Error('[servertool] invalid execution outcome materialization action');
  }
}

export function planServertoolExecutionLoopRuntimeActionWithNative(input: {
  hasHandlerEntry: boolean;
  triggerMode?: string;
  nativeExecutionMode?: string;
  tsExecutionMode?: string;
  hasMaterializedResult: boolean;
  hasHandlerError: boolean;
}): ServertoolExecutionLoopRuntimeActionPlan {
  const capability = 'planServertoolExecutionLoopRuntimeActionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolExecutionLoopRuntimeActionJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolExecutionLoopRuntimeActionJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolExecutionLoopRuntimeActionJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'skip_non_tool_call_handler' &&
    record.action !== 'throw_dispatch_spec_mismatch' &&
    record.action !== 'apply_materialized_result' &&
    record.action !== 'apply_handler_error_tool_output' &&
    record.action !== 'continue_without_effect'
  ) {
    throw new Error('planServertoolExecutionLoopRuntimeActionJson native returned invalid action');
  }
  return {
    action: record.action
  };
}

export function resolveServertoolExecutionLoopInitialDecisionWithNative(input: {
  hasHandlerEntry: boolean;
  triggerMode?: string;
  nativeExecutionMode?: string;
  tsExecutionMode?: string;
}): ServertoolExecutionLoopInitialDecision {
  const plan = planServertoolExecutionLoopRuntimeActionWithNative({
    ...input,
    hasMaterializedResult: false,
    hasHandlerError: false
  });
  if (plan.action === 'skip_non_tool_call_handler') {
    return { action: 'skip_non_tool_call_handler' };
  }
  if (plan.action === 'throw_dispatch_spec_mismatch') {
    return { action: 'throw_dispatch_spec_mismatch' };
  }
  if (plan.action === 'continue_without_effect') {
    return { action: 'continue_to_handler' };
  }
  throw new Error('[servertool] invalid execution loop initial action');
}

export function resolveServertoolExecutionLoopResultDecisionWithNative(input: {
  triggerMode?: string;
  hasMaterializedResult: boolean;
  hasHandlerError: boolean;
}): ServertoolExecutionLoopResultDecision {
  const plan = planServertoolExecutionLoopRuntimeActionWithNative({
    hasHandlerEntry: true,
    triggerMode: input.triggerMode,
    hasMaterializedResult: input.hasMaterializedResult,
    hasHandlerError: input.hasHandlerError
  });
  if (plan.action === 'apply_materialized_result') {
    return { action: 'apply_materialized_result' };
  }
  if (plan.action === 'apply_handler_error_tool_output') {
    return { action: 'apply_handler_error_tool_output' };
  }
  if (plan.action === 'continue_without_effect') {
    return { action: 'continue_without_effect' };
  }
  throw new Error('[servertool] invalid execution loop result action');
}

export function applyServertoolExecutionLoopInitialDecisionWithNative<T>(
  decision: ServertoolExecutionLoopInitialDecision,
  application: ServertoolExecutionLoopInitialDecisionApplication<T>
): T {
  if (decision.action === 'skip_non_tool_call_handler') {
    return application.skipNonToolCallHandler();
  }
  if (decision.action === 'throw_dispatch_spec_mismatch') {
    return application.throwDispatchSpecMismatch();
  }
  if (decision.action === 'continue_to_handler') {
    return application.continueToHandler();
  }
  throw new Error('[servertool] invalid execution loop initial action');
}

export function applyServertoolExecutionLoopResultDecisionWithNative<T>(
  decision: ServertoolExecutionLoopResultDecision,
  application: ServertoolExecutionLoopResultDecisionApplication<T>
): T {
  if (decision.action === 'apply_materialized_result') {
    return application.applyMaterializedResult();
  }
  if (decision.action === 'apply_handler_error_tool_output') {
    return application.applyHandlerErrorToolOutput();
  }
  if (decision.action === 'continue_without_effect') {
    return application.continueWithoutEffect();
  }
  throw new Error('[servertool] invalid execution loop result action');
}

export function planServertoolExecutionLoopEffectWithNative(input: {
  mode: 'handler_error';
  toolCall: {
    id: string;
    name: string;
    arguments: string;
    executionMode?: string;
    stripAfterExecute?: boolean;
  };
  noopOutcome?: unknown;
  handlerErrorMessage?: unknown;
}): ServertoolExecutionLoopHandlerErrorEffectPlan;
export function planServertoolExecutionLoopEffectWithNative(input: {
  mode: string;
  toolCall: {
    id: string;
    name: string;
    arguments: string;
    executionMode?: string;
    stripAfterExecute?: boolean;
  };
  noopOutcome?: unknown;
  handlerErrorMessage?: unknown;
}): ServertoolExecutionLoopEffectBasePlan;
export function planServertoolExecutionLoopEffectWithNative(input: {
  mode: string;
  toolCall: {
    id: string;
    name: string;
    arguments: string;
    executionMode?: string;
    stripAfterExecute?: boolean;
  };
  noopOutcome?: unknown;
  handlerErrorMessage?: unknown;
}): ServertoolExecutionLoopEffectPlan {
  const capability = 'planServertoolExecutionLoopEffectJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolExecutionLoopEffectJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolExecutionLoopEffectJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolExecutionLoopEffectJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (!record.toolCall || typeof record.toolCall !== 'object' || Array.isArray(record.toolCall)) {
    throw new Error('planServertoolExecutionLoopEffectJson native returned invalid toolCall');
  }
  if (!record.execution || typeof record.execution !== 'object' || Array.isArray(record.execution)) {
    throw new Error('planServertoolExecutionLoopEffectJson native returned invalid execution');
  }
  const toolCall = record.toolCall as Record<string, unknown>;
  const execution = record.execution as Record<string, unknown>;
  if (typeof toolCall.id !== 'string' || typeof toolCall.name !== 'string' || typeof toolCall.arguments !== 'string') {
    throw new Error('planServertoolExecutionLoopEffectJson native returned invalid toolCall shape');
  }
  if (typeof execution.flowId !== 'string') {
    throw new Error('planServertoolExecutionLoopEffectJson native returned invalid execution flowId');
  }
  const basePlan = {
    toolCall: {
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
      executionMode: typeof toolCall.executionMode === 'string' ? toolCall.executionMode : '',
      stripAfterExecute: typeof toolCall.stripAfterExecute === 'boolean' ? toolCall.stripAfterExecute : false
    },
    execution: {
      flowId: execution.flowId
    }
  };
  if (input.mode === 'handler_error') {
    if (typeof record.handlerErrorMessage !== 'string') {
      throw new Error('planServertoolExecutionLoopEffectJson native returned handler_error without handlerErrorMessage');
    }
    return {
      ...basePlan,
      handlerErrorMessage: record.handlerErrorMessage
    };
  }
  return basePlan;
}

export function planServertoolHandlerErrorExecutionLoopEffectWithNative(input: {
  toolCall: {
    id: string;
    name: string;
    arguments: string;
    executionMode?: string;
    stripAfterExecute?: boolean;
  };
  handlerErrorMessage: unknown;
}): ServertoolExecutionLoopHandlerErrorEffectPlan {
  return planServertoolExecutionLoopEffectWithNative({
    mode: 'handler_error',
    toolCall: input.toolCall,
    handlerErrorMessage: input.handlerErrorMessage
  });
}

export function planServertoolNoopExecutionLoopEffectWithNative(input: {
  toolCall: {
    id: string;
    name: string;
    arguments: string;
    executionMode?: string;
    stripAfterExecute?: boolean;
  };
  noopOutcome: unknown;
}): ServertoolExecutionLoopEffectBasePlan {
  return planServertoolExecutionLoopEffectWithNative({
    mode: 'noop',
    toolCall: input.toolCall,
    noopOutcome: input.noopOutcome
  });
}

function encodeServertoolExecutionLoopEffectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { handlerErrorMessage: input };
  }
  const record = input as Record<string, unknown>;
  return {
    ...record,
    handlerErrorMessage: encodeServertoolHandlerErrorCarrier(record.handlerErrorMessage)
  };
}

function encodeServertoolHandlerErrorCarrier(error: unknown): unknown {
  if (error instanceof Error) {
    return { message: error.message };
  }
  return error;
}

function isServertoolResponseStageAutoHookResult(value: unknown): value is ServertoolResponseStageAutoHookResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.mode !== 'passthrough' && record.mode !== 'tool_flow') {
    return false;
  }
  if (!record.finalChatResponse || typeof record.finalChatResponse !== 'object' || Array.isArray(record.finalChatResponse)) {
    return false;
  }
  if (record.execution != null) {
    if (typeof record.execution !== 'object' || Array.isArray(record.execution)) {
      return false;
    }
    const execution = record.execution as Record<string, unknown>;
    if (typeof execution.flowId !== 'string' || !execution.flowId) {
      return false;
    }
  }
  return true;
}

function isNativeServertoolResponseStageGate(value: unknown): value is NativeServertoolResponseStageGate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.shouldBypass === 'boolean' &&
    typeof record.nextAction === 'string' &&
    typeof record.responseHookMatched === 'boolean' &&
    typeof record.responseHookRequired === 'boolean'
  );
}

export function planServertoolResponseStageRuntimeActionWithNative(input: {
  responseStageGatePlan?: unknown;
  responseStageNextAction?: string;
  baseObject?: JsonObject;
  autoHookResult?: ServertoolResponseStageAutoHookResult | null;
  autoHookEvaluated: boolean;
  hasAutoHookResult: boolean;
}): ServertoolResponseStageRuntimeActionPlan {
  const capability = 'planServertoolResponseStageRuntimeActionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolResponseStageRuntimeActionJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolResponseStageRuntimeActionJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolResponseStageRuntimeActionJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'return_passthrough_bypass' &&
    record.action !== 'run_auto_hooks' &&
    record.action !== 'return_auto_hook_result' &&
    record.action !== 'return_required_response_hook_empty' &&
    record.action !== 'return_passthrough_no_auto_hook_result'
  ) {
    throw new Error('planServertoolResponseStageRuntimeActionJson native returned invalid action');
  }
  if (record.action === 'return_auto_hook_result' && input.hasAutoHookResult !== true) {
    throw new Error('planServertoolResponseStageRuntimeActionJson native returned return_auto_hook_result without auto-hook result');
  }
  const isPassthroughAction =
    record.action === 'return_passthrough_bypass' ||
    record.action === 'return_passthrough_no_auto_hook_result';
  if (isPassthroughAction && record.resultMode !== undefined) {
    throw new Error('planServertoolResponseStageRuntimeActionJson native returned deprecated resultMode for passthrough action');
  }
  const skipReason =
    typeof record.skipReason === 'string' && record.skipReason
      ? record.skipReason
      : undefined;
  if (record.action === 'return_passthrough_bypass' && record.skipReason !== undefined && !skipReason) {
    throw new Error('planServertoolResponseStageRuntimeActionJson native returned empty bypass skipReason');
  }
  if (!isPassthroughAction && record.resultMode !== undefined) {
    throw new Error('planServertoolResponseStageRuntimeActionJson native returned resultMode for non-passthrough action');
  }
  if (record.action === 'return_passthrough_bypass' || record.action === 'return_passthrough_no_auto_hook_result') {
    if (!record.passthroughResult || typeof record.passthroughResult !== 'object' || Array.isArray(record.passthroughResult)) {
      throw new Error('planServertoolResponseStageRuntimeActionJson native returned passthrough action without passthroughResult');
    }
    const passthroughResult = record.passthroughResult as Record<string, unknown>;
    if (passthroughResult.mode !== 'passthrough') {
      throw new Error('planServertoolResponseStageRuntimeActionJson native returned invalid passthroughResult mode');
    }
    if (!Object.prototype.hasOwnProperty.call(passthroughResult, 'finalChatResponse')) {
      throw new Error('planServertoolResponseStageRuntimeActionJson native returned passthroughResult without finalChatResponse');
    }
    if (!record.passResult || typeof record.passResult !== 'object' || Array.isArray(record.passResult)) {
      throw new Error('planServertoolResponseStageRuntimeActionJson native returned passthrough action without passResult');
    }
    const passResult = record.passResult as Record<string, unknown>;
    const expectedPassAction = record.action === 'return_passthrough_bypass'
      ? 'return_passthrough_bypass'
      : 'continue_without_result';
    if (passResult.action !== expectedPassAction) {
      throw new Error('planServertoolResponseStageRuntimeActionJson native returned invalid passthrough passResult action');
    }
    let prepassResult: { action: 'continue_to_execution'; responseStageGatePlan: unknown } | undefined;
    if (!record.prepassResult || typeof record.prepassResult !== 'object' || Array.isArray(record.prepassResult)) {
      throw new Error('planServertoolResponseStageRuntimeActionJson native returned passthrough action without prepassResult');
    }
    const prepassPayload = record.prepassResult as Record<string, unknown>;
    if (
      prepassPayload.action !== 'continue_to_execution' ||
      !isNativeServertoolResponseStageGate(prepassPayload.responseStageGatePlan)
    ) {
      throw new Error('planServertoolResponseStageRuntimeActionJson native returned invalid passthrough prepassResult');
    }
    if (!isServertoolResponseStageAutoHookResult(record.finalizeResult)) {
      throw new Error('planServertoolResponseStageRuntimeActionJson native returned invalid passthrough finalizeResult');
    }
    return {
      action: record.action,
      passthroughResult: {
        mode: 'passthrough',
        finalChatResponse: passthroughResult.finalChatResponse
      },
      passResult: {
        action: expectedPassAction
      },
      prepassResult: {
        action: 'continue_to_execution',
        responseStageGatePlan: prepassPayload.responseStageGatePlan
      },
      finalizeResult: record.finalizeResult,
      ...(skipReason ? { skipReason } : {})
    };
  }
  if (record.action === 'return_required_response_hook_empty') {
    if (typeof record.responseHookName !== 'string' || !record.responseHookName) {
      throw new Error('planServertoolResponseStageRuntimeActionJson native returned required hook empty without responseHookName');
    }
    return {
      action: 'return_required_response_hook_empty',
      responseHookName: record.responseHookName
    };
  }
  if (record.action === 'run_auto_hooks') {
    return {
      action: record.action
    };
  }
  if (record.action === 'return_auto_hook_result') {
    if (!record.passResult || typeof record.passResult !== 'object' || Array.isArray(record.passResult)) {
      throw new Error('planServertoolResponseStageRuntimeActionJson native returned auto-hook result without passResult');
    }
    const passResult = record.passResult as Record<string, unknown>;
    if (passResult.action !== 'return_auto_hook_result' || !passResult.result || typeof passResult.result !== 'object' || Array.isArray(passResult.result)) {
      throw new Error('planServertoolResponseStageRuntimeActionJson native returned invalid auto-hook passResult');
    }
    if (!isServertoolResponseStageAutoHookResult(passResult.result)) {
      throw new Error('planServertoolResponseStageRuntimeActionJson native returned invalid auto-hook result shape');
    }
    if (!record.prepassResult || typeof record.prepassResult !== 'object' || Array.isArray(record.prepassResult)) {
      throw new Error('planServertoolResponseStageRuntimeActionJson native returned auto-hook result without prepassResult');
    }
    const prepassResult = record.prepassResult as Record<string, unknown>;
    if (
      prepassResult.action !== 'return_result' ||
      !isNativeServertoolResponseStageGate(prepassResult.responseStageGatePlan) ||
      !isServertoolResponseStageAutoHookResult(prepassResult.result)
    ) {
      throw new Error('planServertoolResponseStageRuntimeActionJson native returned invalid auto-hook prepassResult');
    }
    if (!isServertoolResponseStageAutoHookResult(record.finalizeResult)) {
      throw new Error('planServertoolResponseStageRuntimeActionJson native returned invalid auto-hook finalizeResult');
    }
    return {
      action: 'return_auto_hook_result',
      passResult: {
        action: 'return_auto_hook_result',
        result: passResult.result
      },
      prepassResult: {
        action: 'return_result',
        responseStageGatePlan: prepassResult.responseStageGatePlan,
        result: prepassResult.result
      },
      finalizeResult: record.finalizeResult
    };
  }
  throw new Error('planServertoolResponseStageRuntimeActionJson native returned unhandled action');
}

export function resolveServertoolResponseStagePrepassInitialDecisionWithNative(input: {
  responseStageGatePlan: NativeServertoolResponseStageGate;
  baseObject: JsonObject;
}): ServertoolResponseStagePrepassShellDecision {
  const action = planServertoolResponseStageRuntimeActionWithNative({
    responseStageGatePlan: input.responseStageGatePlan,
    baseObject: input.baseObject,
    autoHookEvaluated: false,
    hasAutoHookResult: false
  });
  switch (action.action) {
    case 'run_auto_hooks':
      return { action: 'run_auto_hooks' };
    case 'return_passthrough_no_auto_hook_result':
      return {
        action: 'return_prepass_result',
        result: action.prepassResult
      };
    default:
      throw new Error('[servertool] invalid response-stage prepass action');
  }
}

export function resolveServertoolResponseStagePrepassInitialApplicationWithNative(input: {
  decision: ServertoolResponseStagePrepassShellDecision;
}): ServertoolResponseStagePrepassInitialApplicationDecision {
  const capability = 'planServertoolResponseStagePrepassInitialApplicationJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolResponseStagePrepassInitialApplicationJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolResponseStagePrepassInitialApplicationJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolResponseStagePrepassInitialApplicationJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (record.runAutoHook === true) {
    return { runAutoHook: true };
  }
  if (record.runAutoHook === false) {
    if (!record.result || typeof record.result !== 'object' || Array.isArray(record.result)) {
      throw new Error('planServertoolResponseStagePrepassInitialApplicationJson native returned result-less no-auto-hook plan');
    }
    const result = record.result as Record<string, unknown>;
    if (
      result.action !== 'continue_to_execution' ||
      !isNativeServertoolResponseStageGate(result.responseStageGatePlan)
    ) {
      throw new Error('planServertoolResponseStagePrepassInitialApplicationJson native returned invalid prepass result');
    }
    return {
      runAutoHook: false,
      result: {
        action: 'continue_to_execution',
        responseStageGatePlan: result.responseStageGatePlan
      }
    };
  }
  throw new Error('planServertoolResponseStagePrepassInitialApplicationJson native returned invalid runAutoHook');
}

export function resolveServertoolResponseStageOrchestrationGateApplicationWithNative(input: {
  responseStageGatePlan: NativeServertoolResponseStageGate;
  baseObject: JsonObject;
}): ServertoolResponseStageOrchestrationGateApplicationPlan {
  const runtimeAction = planServertoolResponseStageRuntimeActionWithNative({
    responseStageGatePlan: input.responseStageGatePlan,
    baseObject: input.baseObject,
    autoHookEvaluated: false,
    hasAutoHookResult: false
  });
  const capability = 'planServertoolResponseStageOrchestrationGateApplicationJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolResponseStageOrchestrationGateApplicationJson native unavailable');
  }
  const resultJson = fn(JSON.stringify({ runtimeAction }));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolResponseStageOrchestrationGateApplicationJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolResponseStageOrchestrationGateApplicationJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.bypass !== 'boolean' || typeof record.runOrchestration !== 'boolean') {
    throw new Error('planServertoolResponseStageOrchestrationGateApplicationJson native returned invalid booleans');
  }
  if (record.bypass === record.runOrchestration) {
    throw new Error('planServertoolResponseStageOrchestrationGateApplicationJson native returned ambiguous plan');
  }
  if (record.skipReason !== undefined && typeof record.skipReason !== 'string') {
    throw new Error('planServertoolResponseStageOrchestrationGateApplicationJson native returned invalid skipReason');
  }
  return {
    bypass: record.bypass,
    runOrchestration: record.runOrchestration,
    ...(typeof record.skipReason === 'string' ? { skipReason: record.skipReason } : {})
  };
}

export function resolveServertoolResponseStagePrepassAfterAutoHookWithNative(input: {
  responseStageGatePlan: NativeServertoolResponseStageGate;
  baseObject: JsonObject;
  responseStageAutoHookResult:
    | { action: 'return_auto_hook_result'; result: ServertoolResponseStageAutoHookResult }
    | { action: 'continue_without_result' | 'return_passthrough_bypass' };
}): ServertoolResponseStagePrepassAfterAutoHookDecision {
  switch (input.responseStageAutoHookResult.action) {
    case 'return_auto_hook_result': {
      const action = planServertoolResponseStageRuntimeActionWithNative({
        responseStageGatePlan: input.responseStageGatePlan,
        baseObject: input.baseObject,
        autoHookEvaluated: true,
        hasAutoHookResult: true,
        autoHookResult: input.responseStageAutoHookResult.result
      });
      if (action.action !== 'return_auto_hook_result') {
        throw new Error('[servertool] invalid response-stage prepass auto-hook post action');
      }
      return {
        action: 'return_prepass_result',
        result: action.prepassResult
      };
    }
    case 'continue_without_result':
    case 'return_passthrough_bypass': {
      const action = planServertoolResponseStageRuntimeActionWithNative({
        responseStageGatePlan: input.responseStageGatePlan,
        baseObject: input.baseObject,
        autoHookEvaluated: true,
        hasAutoHookResult: false
      });
      if (
        action.action !== 'return_passthrough_bypass' &&
        action.action !== 'return_passthrough_no_auto_hook_result'
      ) {
        throw new Error('[servertool] invalid response-stage prepass post action');
      }
      return {
        action: 'return_prepass_result',
        result: action.prepassResult
      };
    }
    default:
      throw new Error('[servertool] invalid response-stage prepass auto-hook action');
  }
}

export function finalizeServertoolResponseStageWithNative(input: {
  responseStageGatePlan: NativeServertoolResponseStageGate;
  baseObject: JsonObject;
  responseStageAutoHookResult:
    | { action: 'return_auto_hook_result'; result: ServertoolResponseStageAutoHookResult }
    | { action: 'continue_without_result' | 'return_passthrough_bypass' };
}): ServerSideToolEngineResult {
  const action = planServertoolResponseStageRuntimeActionWithNative({
    responseStageGatePlan: input.responseStageGatePlan,
    baseObject: input.baseObject,
    autoHookEvaluated: true,
    hasAutoHookResult: input.responseStageAutoHookResult.action === 'return_auto_hook_result',
    autoHookResult: input.responseStageAutoHookResult.action === 'return_auto_hook_result'
      ? input.responseStageAutoHookResult.result
      : null
  });
  switch (action.action) {
    case 'return_auto_hook_result':
    case 'return_passthrough_bypass':
    case 'return_passthrough_no_auto_hook_result':
      return action.finalizeResult;
    default:
      throw new Error('[servertool] invalid response-stage finalize action');
  }
}

export function resolveServertoolResponseStageAutoHookPreDecisionWithNative(input: {
  responseStageGatePlan: NativeServertoolResponseStageGate;
  baseObject: JsonObject;
}): ServertoolResponseStageAutoHookPreDecision {
  const action = planServertoolResponseStageRuntimeActionWithNative({
    responseStageGatePlan: input.responseStageGatePlan,
    baseObject: input.baseObject,
    autoHookEvaluated: false,
    hasAutoHookResult: false
  });
  switch (action.action) {
    case 'return_passthrough_bypass':
      return {
        action: 'return_pass_result',
        result: action.passResult
      };
    case 'run_auto_hooks':
      return { action: 'run_auto_hooks' };
    default:
      throw new Error('[servertool] invalid response-stage pre auto-hook action');
  }
}

export function resolveServertoolResponseStageAutoHookPreApplicationWithNative(input: {
  decision: ServertoolResponseStageAutoHookPreDecision;
}): ServertoolResponseStageAutoHookPreApplicationDecision {
  const capability = 'planServertoolResponseStageAutoHookPreApplicationJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolResponseStageAutoHookPreApplicationJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolResponseStageAutoHookPreApplicationJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolResponseStageAutoHookPreApplicationJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.returnPassResult !== 'boolean' || typeof record.runAutoHooks !== 'boolean') {
    throw new Error('planServertoolResponseStageAutoHookPreApplicationJson native returned invalid booleans');
  }
  if (record.returnPassResult === record.runAutoHooks) {
    throw new Error('planServertoolResponseStageAutoHookPreApplicationJson native returned ambiguous plan');
  }
  if (record.returnPassResult) {
    if (!record.result || typeof record.result !== 'object' || Array.isArray(record.result)) {
      throw new Error('planServertoolResponseStageAutoHookPreApplicationJson native returned missing result');
    }
    return {
      returnPassResult: true,
      runAutoHooks: false,
      result: record.result as ServertoolResponseStageAutoHookPassResult
    };
  }
  return {
    returnPassResult: false,
    runAutoHooks: true
  };
}

export function resolveServertoolResponseStageAutoHookPostDecisionWithNative(input: {
  requestId: string;
  responseStageGatePlan: NativeServertoolResponseStageGate;
  baseObject: JsonObject;
  autoHookResult: ServertoolResponseStageAutoHookResult | null;
}): ServertoolResponseStageAutoHookPostDecision {
  const action = planServertoolResponseStageRuntimeActionWithNative({
    responseStageGatePlan: input.responseStageGatePlan,
    baseObject: input.baseObject,
    autoHookEvaluated: true,
    hasAutoHookResult: input.autoHookResult != null,
    autoHookResult: input.autoHookResult
  });
  switch (action.action) {
    case 'return_required_response_hook_empty':
      return {
        action: 'throw_required_response_hook_empty',
        errorPlan: planServertoolRequiredResponseHookEmptyErrorWithNative({
          requestId: input.requestId,
          responseHookName: action.responseHookName
        })
      };
    case 'return_auto_hook_result':
    case 'return_passthrough_no_auto_hook_result':
      return {
        action: 'return_pass_result',
        result: action.passResult
      };
    default:
      throw new Error('[servertool] invalid response-stage post auto-hook action');
  }
}

export function resolveServertoolResponseStageAutoHookPostApplicationWithNative(input: {
  decision: ServertoolResponseStageAutoHookPostDecision;
}): ServertoolResponseStageAutoHookPostApplicationDecision {
  const capability = 'planServertoolResponseStageAutoHookPostApplicationJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolResponseStageAutoHookPostApplicationJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolResponseStageAutoHookPostApplicationJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolResponseStageAutoHookPostApplicationJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.throwRequiredResponseHookEmpty !== 'boolean' ||
    typeof record.returnPassResult !== 'boolean'
  ) {
    throw new Error('planServertoolResponseStageAutoHookPostApplicationJson native returned invalid booleans');
  }
  if (record.throwRequiredResponseHookEmpty === record.returnPassResult) {
    throw new Error('planServertoolResponseStageAutoHookPostApplicationJson native returned ambiguous plan');
  }
  if (record.throwRequiredResponseHookEmpty) {
    if (!record.errorPlan || typeof record.errorPlan !== 'object' || Array.isArray(record.errorPlan)) {
      throw new Error('planServertoolResponseStageAutoHookPostApplicationJson native returned missing errorPlan');
    }
    return {
      throwRequiredResponseHookEmpty: true,
      returnPassResult: false,
      errorPlan: record.errorPlan as ReturnType<typeof planServertoolRequiredResponseHookEmptyErrorWithNative>
    };
  }
  if (!record.result || typeof record.result !== 'object' || Array.isArray(record.result)) {
    throw new Error('planServertoolResponseStageAutoHookPostApplicationJson native returned missing result');
  }
  return {
    throwRequiredResponseHookEmpty: false,
    returnPassResult: true,
    result: record.result as ServertoolResponseStageAutoHookPassResult
  };
}

export function materializeServertoolResponseStageOrchestrationOutputWithNative(input: {
  originalPayload: JsonObject;
  executedPayload: JsonObject;
  orchestrationExecuted: boolean;
  orchestrationFlowId?: string;
  inputShape?: string;
  outputShape?: string;
}): ServertoolResponseStageOrchestrationMaterializedOutput {
  const capability = 'materializeServertoolResponseStageOrchestrationOutputJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('materializeServertoolResponseStageOrchestrationOutputJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`materializeServertoolResponseStageOrchestrationOutputJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('materializeServertoolResponseStageOrchestrationOutputJson native returned invalid output');
  }
  const record = parsed as Record<string, unknown>;
  if (!record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) {
    throw new Error('materializeServertoolResponseStageOrchestrationOutputJson native returned invalid payload');
  }
  if (typeof record.executed !== 'boolean') {
    throw new Error('materializeServertoolResponseStageOrchestrationOutputJson native returned invalid executed flag');
  }
  if (record.flowId !== undefined && typeof record.flowId !== 'string') {
    throw new Error('materializeServertoolResponseStageOrchestrationOutputJson native returned invalid flowId');
  }
  if (typeof record.returnedExecutedPayload !== 'boolean') {
    throw new Error('materializeServertoolResponseStageOrchestrationOutputJson native returned invalid returnedExecutedPayload flag');
  }
  if (record.returnedExecutedPayload && record.executed !== true) {
    throw new Error('materializeServertoolResponseStageOrchestrationOutputJson native returned executed payload without executed record');
  }
  if (!record.shellResult || typeof record.shellResult !== 'object' || Array.isArray(record.shellResult)) {
    throw new Error('materializeServertoolResponseStageOrchestrationOutputJson native returned invalid shellResult');
  }
  const shellResult = record.shellResult as Record<string, unknown>;
  if (!shellResult.payload || typeof shellResult.payload !== 'object' || Array.isArray(shellResult.payload)) {
    throw new Error('materializeServertoolResponseStageOrchestrationOutputJson native returned invalid shellResult payload');
  }
  if (typeof shellResult.executed !== 'boolean') {
    throw new Error('materializeServertoolResponseStageOrchestrationOutputJson native returned invalid shellResult executed flag');
  }
  if (shellResult.flowId !== undefined && typeof shellResult.flowId !== 'string') {
    throw new Error('materializeServertoolResponseStageOrchestrationOutputJson native returned invalid shellResult flowId');
  }
  if (!record.recordEvent || typeof record.recordEvent !== 'object' || Array.isArray(record.recordEvent)) {
    throw new Error('materializeServertoolResponseStageOrchestrationOutputJson native returned invalid recordEvent');
  }
  return {
    payload: record.payload as JsonObject,
    executed: record.executed,
    returnedExecutedPayload: record.returnedExecutedPayload,
    shellResult: {
      payload: shellResult.payload as JsonObject,
      executed: shellResult.executed,
      ...(typeof shellResult.flowId === 'string' && shellResult.flowId.trim()
        ? { flowId: shellResult.flowId.trim() }
        : {})
    },
    recordEvent: record.recordEvent as JsonObject,
    ...(typeof record.flowId === 'string' && record.flowId.trim()
      ? { flowId: record.flowId.trim() }
      : {})
  };
}

export function extractServertoolResponseStageOrchestrationShellResultWithNative(
  output: ServertoolResponseStageOrchestrationMaterializedOutput
): ServertoolResponseStageOrchestrationShellResult {
  return output.shellResult;
}

export function planServertoolEntryPreflightWithNative(input: {
  hasBaseObject: boolean;
  adapterClientDisconnected: boolean;
  chatResponse: unknown;
}): ServertoolEntryPreflightPlan {
  const capability = 'planServertoolEntryPreflightJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolEntryPreflightJson native unavailable');
  }
  const resultJson = fn(JSON.stringify({
    hasBaseObject: input.hasBaseObject,
    adapterClientDisconnected: input.adapterClientDisconnected,
    chatResponse: input.chatResponse
  }));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolEntryPreflightJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolEntryPreflightJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'return_passthrough_non_object_chat' &&
    record.action !== 'throw_client_disconnected' &&
    record.action !== 'continue_to_tool_flow'
  ) {
    throw new Error('planServertoolEntryPreflightJson native returned invalid action');
  }
  if (record.action === 'return_passthrough_non_object_chat') {
    if (record.resultMode !== 'passthrough') {
      throw new Error('planServertoolEntryPreflightJson native returned passthrough action without passthrough resultMode');
    }
    if (!record.passthroughResult || typeof record.passthroughResult !== 'object' || Array.isArray(record.passthroughResult)) {
      throw new Error('planServertoolEntryPreflightJson native returned invalid passthroughResult');
    }
    const passthroughResult = record.passthroughResult as Record<string, unknown>;
    if (passthroughResult.mode !== 'passthrough') {
      throw new Error('planServertoolEntryPreflightJson native returned invalid passthroughResult.mode');
    }
    return {
      action: 'return_passthrough_non_object_chat',
      passthroughResult: {
        mode: 'passthrough',
        finalChatResponse: passthroughResult.finalChatResponse
      }
    };
  }
  if (record.resultMode !== undefined) {
    throw new Error('planServertoolEntryPreflightJson native returned resultMode for non-passthrough action');
  }
  if (record.passthroughResult !== undefined) {
    throw new Error('planServertoolEntryPreflightJson native returned passthroughResult for non-passthrough action');
  }
  return {
    action: record.action
  };
}

export function readServertoolEntryBaseObjectWithNative(chatResponse: unknown): JsonObject | null {
  if (chatResponse == null || typeof chatResponse !== 'object' || Array.isArray(chatResponse)) {
    return null;
  }
  return chatResponse as JsonObject;
}

export function resolveServertoolEntryPreflightWithNative(input: {
  requestId: string;
  baseObject: JsonObject | null;
  adapterClientDisconnected: boolean;
  chatResponse: unknown;
}): ServertoolEntryPreflightDecision {
  const plan = planServertoolEntryPreflightWithNative({
    hasBaseObject: input.baseObject != null,
    adapterClientDisconnected: input.adapterClientDisconnected,
    chatResponse: input.chatResponse
  });
  switch (plan.action) {
    case 'return_passthrough_non_object_chat':
      return {
        action: 'return_result',
        result: plan.passthroughResult as ServerSideToolEngineResult
      };
    case 'throw_client_disconnected':
      return {
        action: 'throw_error',
        errorPlan: planServertoolClientDisconnectedErrorWithNative({
          requestId: input.requestId
        })
      };
    case 'continue_to_tool_flow':
      if (input.baseObject == null) {
        throw new Error('[servertool] invalid entry preflight continue without base object');
      }
      return {
        action: 'continue',
        baseObject: input.baseObject
      };
    default:
      throw new Error('[servertool] invalid entry preflight action');
  }
}

export function resolveServertoolEntryPreflightApplicationWithNative(input: {
  entryPreflight: ServertoolEntryPreflightDecision;
}): ServertoolEntryPreflightApplicationDecision {
  const capability = 'planServertoolEntryPreflightApplicationJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolEntryPreflightApplicationJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolEntryPreflightApplicationJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolEntryPreflightApplicationJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (record.throwError === true) {
    if (!record.errorPlan || typeof record.errorPlan !== 'object' || Array.isArray(record.errorPlan)) {
      throw new Error('planServertoolEntryPreflightApplicationJson native returned invalid errorPlan');
    }
    return {
      throwError: true,
      errorPlan: record.errorPlan as ReturnType<typeof planServertoolClientDisconnectedErrorWithNative>
    };
  }
  if (record.throwError !== false) {
    throw new Error('planServertoolEntryPreflightApplicationJson native returned invalid throwError');
  }
  if (record.returnResult === true) {
    if (!record.result || typeof record.result !== 'object' || Array.isArray(record.result)) {
      throw new Error('planServertoolEntryPreflightApplicationJson native returned invalid result');
    }
    return {
      throwError: false,
      returnResult: true,
      result: record.result as ServerSideToolEngineResult
    };
  }
  if (record.returnResult === false) {
    if (!record.baseObject || typeof record.baseObject !== 'object' || Array.isArray(record.baseObject)) {
      throw new Error('planServertoolEntryPreflightApplicationJson native returned invalid baseObject');
    }
    return {
      throwError: false,
      returnResult: false,
      baseObject: record.baseObject as JsonObject
    };
  }
  throw new Error('planServertoolEntryPreflightApplicationJson native returned invalid returnResult');
}

export function resolveServertoolRunEngineEntryPreflightDecisionWithNative(input: {
  entryPreflight: ServertoolEntryPreflightDecision;
}): ServertoolRunEngineEntryPreflightDecision {
  switch (input.entryPreflight.action) {
    case 'return_result':
      return {
        action: 'return_result',
        result: input.entryPreflight.result
      };
    case 'continue':
      return {
        action: 'continue',
        baseObject: input.entryPreflight.baseObject
      };
    default:
      throw new Error('[servertool] invalid entry preflight result action');
  }
}

export function resolveServertoolRunEngineEntryPreflightApplicationWithNative(input: {
  entryPreflight: ServertoolRunEngineEntryPreflightDecision;
}): ServertoolRunEngineEntryPreflightApplicationDecision {
  const capability = 'planServertoolRunEngineEntryPreflightApplicationJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolRunEngineEntryPreflightApplicationJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolRunEngineEntryPreflightApplicationJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolRunEngineEntryPreflightApplicationJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (record.returnResult === true) {
    if (!record.result || typeof record.result !== 'object' || Array.isArray(record.result)) {
      throw new Error('planServertoolRunEngineEntryPreflightApplicationJson native returned invalid result');
    }
    return {
      returnResult: true,
      result: record.result as ServerSideToolEngineResult
    };
  }
  if (record.returnResult === false) {
    if (!record.baseObject || typeof record.baseObject !== 'object' || Array.isArray(record.baseObject)) {
      throw new Error('planServertoolRunEngineEntryPreflightApplicationJson native returned invalid baseObject');
    }
    return {
      returnResult: false,
      baseObject: record.baseObject as JsonObject
    };
  }
  throw new Error('planServertoolRunEngineEntryPreflightApplicationJson native returned invalid returnResult');
}

export interface ServertoolEntryContextPlan {
  includeToolCallNames?: string[];
  excludeToolCallNames?: string[];
  includeAutoHookIds?: string[];
  excludeAutoHookIds?: string[];
}

export interface ServertoolEnginePrepassActionPlan {
  action: 'return_prepass_result' | 'continue_to_execution';
  result?: ServerSideToolEngineResult;
}

export function planServertoolEntryContextWithNative(input: {
  includeToolCallHandlerNames?: string[];
  excludeToolCallHandlerNames?: string[];
  includeAutoHookIds?: string[];
  excludeAutoHookIds?: string[];
}): ServertoolEntryContextPlan {
  const capability = 'planServertoolEntryContextJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolEntryContextJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolEntryContextJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolEntryContextJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  for (const key of [
    'includeToolCallNames',
    'excludeToolCallNames',
    'includeAutoHookIds',
    'excludeAutoHookIds'
  ]) {
    const value = record[key];
    if (value != null && (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))) {
      throw new Error(`planServertoolEntryContextJson native returned invalid ${key}`);
    }
  }
  return {
    includeToolCallNames: record.includeToolCallNames == null ? undefined : record.includeToolCallNames as string[],
    excludeToolCallNames: record.excludeToolCallNames == null ? undefined : record.excludeToolCallNames as string[],
    includeAutoHookIds: record.includeAutoHookIds == null ? undefined : record.includeAutoHookIds as string[],
    excludeAutoHookIds: record.excludeAutoHookIds == null ? undefined : record.excludeAutoHookIds as string[]
  };
}

export function planServertoolEnginePrepassActionWithNative(input: {
  hasPrepassResult: boolean;
  prepassResult?: ServerSideToolEngineResult | null;
}): ServertoolEnginePrepassActionPlan {
  const capability = 'planServertoolEnginePrepassActionJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolEnginePrepassActionJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolEnginePrepassActionJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolEnginePrepassActionJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'return_prepass_result' &&
    record.action !== 'continue_to_execution'
  ) {
    throw new Error('planServertoolEnginePrepassActionJson native returned invalid action');
  }
  if (record.action === 'return_prepass_result') {
    const result = record.result;
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('planServertoolEnginePrepassActionJson native returned invalid result');
    }
    const resultRecord = result as Record<string, unknown>;
    if (resultRecord.mode !== 'passthrough' && resultRecord.mode !== 'tool_flow') {
      throw new Error('planServertoolEnginePrepassActionJson native returned invalid result mode');
    }
    if (!resultRecord.finalChatResponse || typeof resultRecord.finalChatResponse !== 'object' || Array.isArray(resultRecord.finalChatResponse)) {
      throw new Error('planServertoolEnginePrepassActionJson native returned invalid result finalChatResponse');
    }
    if (resultRecord.execution !== undefined && (!resultRecord.execution || typeof resultRecord.execution !== 'object' || Array.isArray(resultRecord.execution))) {
      throw new Error('planServertoolEnginePrepassActionJson native returned invalid result execution');
    }
    if (resultRecord.metadataWritePlan !== undefined && (!resultRecord.metadataWritePlan || typeof resultRecord.metadataWritePlan !== 'object' || Array.isArray(resultRecord.metadataWritePlan))) {
      throw new Error('planServertoolEnginePrepassActionJson native returned invalid result metadataWritePlan');
    }
    return {
      action: record.action,
      result: resultRecord as unknown as ServerSideToolEngineResult
    };
  }
  return {
    action: record.action
  };
}

export function resolveServertoolRunEnginePrepassDecisionWithNative(input: {
  hasPrepassResult: boolean;
  prepassResult?: ServerSideToolEngineResult | null;
}): ServertoolRunEnginePrepassDecision {
  const action = planServertoolEnginePrepassActionWithNative({
    hasPrepassResult: input.hasPrepassResult,
    prepassResult: input.prepassResult ?? null
  });
  switch (action.action) {
    case 'return_prepass_result':
      if (!action.result) {
        throw new Error('[servertool] invalid engine prepass action');
      }
      return {
        action: 'return_result',
        result: action.result
      };
    case 'continue_to_execution':
      return { action: 'continue_to_execution' };
    default:
      throw new Error('[servertool] invalid engine prepass action');
  }
}

export function resolveServertoolRunEnginePrepassApplicationWithNative(input: {
  decision: ServertoolRunEnginePrepassDecision;
}): ServertoolRunEnginePrepassApplicationDecision {
  const capability = 'planServertoolRunEnginePrepassApplicationJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolRunEnginePrepassApplicationJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolRunEnginePrepassApplicationJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolRunEnginePrepassApplicationJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (record.returnResult === true) {
    if (!record.result || typeof record.result !== 'object' || Array.isArray(record.result)) {
      throw new Error('planServertoolRunEnginePrepassApplicationJson native returned invalid result');
    }
    return {
      returnResult: true,
      result: record.result as ServerSideToolEngineResult
    };
  }
  if (record.returnResult === false) {
    return { returnResult: false };
  }
  throw new Error('planServertoolRunEnginePrepassApplicationJson native returned invalid returnResult');
}

export type ServertoolRegistryLookupActionPlan = {
  action: 'return_builtin' | 'return_none';
  canonicalName?: string;
};

export type ServertoolRegistryAutoHookDescriptorPlan = {
  id: string;
  phase: 'pre' | 'default' | 'post';
  priority: number;
  order: number;
  sourceIndex: number;
};

export type ServertoolRegistryBuiltinAutoHookEntryPlan = {
  id: string;
  phase: 'pre' | 'default' | 'post';
  priority: number;
  order: number;
  registration: Record<string, unknown>;
  execution: Record<string, unknown>;
};

export function planServertoolRegistryAutoHookDescriptorsWithNative(input: {
  hooks: Array<{
    id: string;
    phase?: string;
    priority?: number;
    order?: number;
  }>;
}): ServertoolRegistryAutoHookDescriptorPlan[] {
  const capability = 'planServertoolRegistryAutoHookDescriptorsJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolRegistryAutoHookDescriptorsJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input.hooks));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolRegistryAutoHookDescriptorsJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('planServertoolRegistryAutoHookDescriptorsJson native returned invalid plan');
  }
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('planServertoolRegistryAutoHookDescriptorsJson native returned invalid descriptor');
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id.trim()) {
      throw new Error('planServertoolRegistryAutoHookDescriptorsJson native returned invalid id');
    }
    if (record.phase !== 'pre' && record.phase !== 'default' && record.phase !== 'post') {
      throw new Error('planServertoolRegistryAutoHookDescriptorsJson native returned invalid phase');
    }
    if (typeof record.priority !== 'number' || !Number.isFinite(record.priority)) {
      throw new Error('planServertoolRegistryAutoHookDescriptorsJson native returned invalid priority');
    }
    if (typeof record.order !== 'number' || !Number.isFinite(record.order)) {
      throw new Error('planServertoolRegistryAutoHookDescriptorsJson native returned invalid order');
    }
    if (
      typeof record.sourceIndex !== 'number' ||
      !Number.isInteger(record.sourceIndex) ||
      record.sourceIndex < 0
    ) {
      throw new Error('planServertoolRegistryAutoHookDescriptorsJson native returned invalid sourceIndex');
    }
    return {
      id: record.id,
      phase: record.phase,
      priority: record.priority,
      order: record.order,
      sourceIndex: record.sourceIndex
    };
  });
}

export function planServertoolRegistryBuiltinAutoHookEntriesWithNative(input: {
  hooks: Array<{
    id: string;
    phase?: string;
    priority?: number;
    order?: number;
    registration: unknown;
    execution: unknown;
  }>;
}): ServertoolRegistryBuiltinAutoHookEntryPlan[] {
  const descriptors = planServertoolRegistryAutoHookDescriptorsWithNative({
    hooks: input.hooks.map((hook) => ({
      id: hook.id,
      phase: hook.phase,
      priority: hook.priority,
      order: hook.order,
    })),
  });
  return descriptors.map((descriptor) => {
    const source = input.hooks[descriptor.sourceIndex];
    if (!source || typeof source !== 'object') {
      throw new Error(
        `planServertoolRegistryAutoHookDescriptorsJson native returned descriptor without builtin hook sourceIndex: ${descriptor.sourceIndex}`
      );
    }
    if (!source.registration || typeof source.registration !== 'object' || Array.isArray(source.registration)) {
      throw new Error('planServertoolRegistryAutoHookDescriptorsJson native returned invalid builtin hook registration');
    }
    if (!source.execution || typeof source.execution !== 'object' || Array.isArray(source.execution)) {
      throw new Error('planServertoolRegistryAutoHookDescriptorsJson native returned invalid builtin hook execution');
    }
    return {
      id: descriptor.id,
      phase: descriptor.phase,
      priority: descriptor.priority,
      order: descriptor.order,
      registration: source.registration as Record<string, unknown>,
      execution: source.execution as Record<string, unknown>,
    };
  });
}

export type ServertoolRegistryProjectionRecordPlan = {
  name: string;
  trigger: 'tool_call' | 'auto';
  sourceIndex: number;
};

export type ServertoolRegistryProjectionPlan = {
  registeredNames: string[];
  registeredRecords: ServertoolRegistryProjectionRecordPlan[];
  autoHandlerNames: string[];
};

export type ServertoolRegistrySourceKind = 'builtin';

export type ServertoolRegistrySourceRefPlan = {
  name: string;
  source: ServertoolRegistrySourceKind;
  sourceIndex: number;
};

export type ServertoolRegistrySourceRecordRefPlan = ServertoolRegistrySourceRefPlan & {
  trigger: 'tool_call' | 'auto';
};

export type ServertoolRegistrySourceProjectionPlan = {
  registeredNames: string[];
  autoHandlerRefs: ServertoolRegistrySourceRefPlan[];
  registeredRecordRefs: ServertoolRegistrySourceRecordRefPlan[];
};

function parseServertoolRegistrySource(value: unknown, capability: string): ServertoolRegistrySourceKind {
  if (value !== 'builtin') {
    throw new Error(`${capability} native returned invalid source`);
  }
  return value;
}

function parseServertoolRegistrySourceIndex(value: unknown, capability: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new Error(`${capability} native returned invalid sourceIndex`);
  }
  return value;
}

export function planServertoolHandlerMaterializationWithNative(input: {
  requestId: string;
  hasFinalizeFunction: boolean;
  hasChatResponseObject: boolean;
  hasExecutionObject: boolean;
  hasExecutionFlowId: boolean;
  hasPlanMarkers: boolean;
}): ServertoolHandlerMaterializationPlan {
  const capability = 'planServertoolHandlerMaterializationJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planServertoolHandlerMaterializationJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planServertoolHandlerMaterializationJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planServertoolHandlerMaterializationJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.action !== 'finalize_without_backend' &&
    record.action !== 'return_handler_result' &&
    record.action !== 'throw_handler_error'
  ) {
    throw new Error('planServertoolHandlerMaterializationJson native returned invalid action');
  }
  if (record.action === 'throw_handler_error') {
    if (!record.errorPlan || typeof record.errorPlan !== 'object' || Array.isArray(record.errorPlan)) {
      throw new Error('planServertoolHandlerMaterializationJson native returned invalid errorPlan');
    }
    return {
      action: 'throw_handler_error',
      errorPlan: parseServertoolErrorPlan(JSON.stringify(record.errorPlan), capability)
    };
  }
  return { action: record.action };
}

export function planServertoolHandlerMaterializationForPlannedWithNative(
  planned: unknown,
  requestId: string
): ServertoolHandlerMaterializationPlan {
  const record =
    planned && typeof planned === 'object' && !Array.isArray(planned)
      ? (planned as Record<string, unknown>)
      : {};
  const execution =
    record.execution && typeof record.execution === 'object' && !Array.isArray(record.execution)
      ? (record.execution as Record<string, unknown>)
      : undefined;
  return planServertoolHandlerMaterializationWithNative({
    requestId,
    hasFinalizeFunction: typeof record.finalize === 'function',
    hasChatResponseObject: Boolean(record.chatResponse && typeof record.chatResponse === 'object' && !Array.isArray(record.chatResponse)),
    hasExecutionObject: Boolean(record.execution && typeof record.execution === 'object' && !Array.isArray(record.execution)),
    hasExecutionFlowId: typeof execution?.flowId === 'string',
    hasPlanMarkers: typeof record.flowId === 'string' || record.finalize !== undefined
  });
}

export function materializeServertoolHandlerResultWithNative(
  planned: unknown,
  requestId: string
): NativeServerToolHandlerResult {
  const plan = planServertoolHandlerMaterializationForPlannedWithNative(planned, requestId);
  if (plan.action === 'throw_handler_error') {
    throw new Error(plan.errorPlan.message);
  }
  if (plan.action !== 'return_handler_result') {
    throw new Error('[servertool] invalid handler materialization plan result');
  }
  const record = planned as Record<string, unknown>;
  return {
    chatResponse: record.chatResponse as JsonObject,
    execution: record.execution as NativeServerToolExecution,
    ...(record.metadataWritePlan != null
      ? { metadataWritePlan: record.metadataWritePlan as JsonObject }
      : {})
  };
}

export async function finalizeServertoolHandlerPlanWithNative(
  planned: unknown,
  requestId: string
): Promise<NativeServerToolHandlerResult | null> {
  const plan = planServertoolHandlerMaterializationForPlannedWithNative(planned, requestId);
  if (plan.action === 'throw_handler_error') {
    throw new Error(plan.errorPlan.message);
  }
  if (plan.action !== 'finalize_without_backend') {
    throw new Error('[servertool] invalid handler materialization plan without finalize');
  }
  return await (planned as { finalize: () => Promise<NativeServerToolHandlerResult | null> }).finalize();
}

export const materializeServertoolPlannedResultWithNative = async (
  planned: unknown,
  options: { requestId: string }
): Promise<NativeServerToolHandlerResult | null> => {
  const actionPlan = planServertoolHandlerMaterializationForPlannedWithNative(
    planned,
    options.requestId
  );
  switch (actionPlan.action) {
    case 'finalize_without_backend': {
      return await finalizeServertoolHandlerPlanWithNative(planned, options.requestId);
    }
    case 'throw_handler_error':
      throw createServertoolProviderProtocolErrorFromPlanWithNative(actionPlan.errorPlan);
    case 'return_handler_result':
      return materializeServertoolHandlerResultWithNative(planned, options.requestId);
    default:
      throw new Error('[servertool] invalid handler materialization action');
  }
};

export function planEngineSelectionStartWithNative(input: {
  primaryAutoHookIds: string[];
}): EngineSelectionStartPlan {
  const capability = 'planEngineSelectionStartJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planEngineSelectionStartJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planEngineSelectionStartJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planEngineSelectionStartJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (record.action !== 'run_default' && record.action !== 'run_primary_hooks') {
    throw new Error('planEngineSelectionStartJson native returned invalid action');
  }
  if (!Array.isArray(record.primaryAutoHookIds)) {
    throw new Error('planEngineSelectionStartJson native returned invalid primaryAutoHookIds');
  }
  return {
    action: record.action,
    overrides: parseEngineSelectionOverridesPlan(record.overrides, capability),
    primaryAutoHookIds: record.primaryAutoHookIds.map((item) => {
      if (typeof item !== 'string' || !item.trim()) {
        throw new Error('planEngineSelectionStartJson native returned invalid primaryAutoHookIds item');
      }
      return item.trim();
    })
  };
}

export function planEngineSelectionAfterRunWithNative(input: {
  primaryAutoHookIds: string[];
  engineResult: unknown;
}): EngineSelectionAfterRunPlan {
  const capability = 'planEngineSelectionAfterRunJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('planEngineSelectionAfterRunJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`planEngineSelectionAfterRunJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('planEngineSelectionAfterRunJson native returned invalid plan');
  }
  const record = parsed as Record<string, unknown>;
  if (record.action !== 'rerun_excluding_primary_hooks' && record.action !== 'return_current') {
    throw new Error('planEngineSelectionAfterRunJson native returned invalid action');
  }
  if (record.action === 'rerun_excluding_primary_hooks') {
    return {
      action: record.action,
      overrides: parseEngineSelectionOverridesPlan(record.overrides, capability)
    };
  }
  if (record.overrides !== undefined && record.overrides !== null) {
    throw new Error('planEngineSelectionAfterRunJson native returned overrides for return_current action');
  }
  return { action: record.action };
}

export function resolveEngineSelectionAfterRunWithNative(input: {
  primaryAutoHookIds: string[];
  engineResult: unknown;
}): EngineSelectionAfterRunDecision {
  const plan = planEngineSelectionAfterRunWithNative(input);
  switch (plan.action) {
    case 'rerun_excluding_primary_hooks':
      return { rerunOverrides: plan.overrides };
    case 'return_current':
      return {};
    default:
      throw new Error('[servertool] invalid engine selection action');
  }
}

function parseEngineSelectionOverridesPlan(value: unknown, capability: string): EngineSelectionOverridesPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${capability} native returned invalid overrides`);
  }
  const record = value as Record<string, unknown>;
  const includeAutoHookIds = parseOptionalStringArray(record.includeAutoHookIds, capability, 'includeAutoHookIds');
  const excludeAutoHookIds = parseOptionalStringArray(record.excludeAutoHookIds, capability, 'excludeAutoHookIds');
  if (record.disableToolCallHandlers !== undefined && typeof record.disableToolCallHandlers !== 'boolean') {
    throw new Error(`${capability} native returned invalid disableToolCallHandlers`);
  }
  return {
    ...(typeof record.disableToolCallHandlers === 'boolean'
      ? { disableToolCallHandlers: record.disableToolCallHandlers }
      : {}),
    ...(includeAutoHookIds ? { includeAutoHookIds } : {}),
    ...(excludeAutoHookIds ? { excludeAutoHookIds } : {})
  };
}

function parseOptionalStringArray(value: unknown, capability: string, field: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${capability} native returned invalid ${field}`);
  }
  const output = value.map((item) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`${capability} native returned invalid ${field} item`);
    }
    return item.trim();
  });
  return output.length > 0 ? output : undefined;
}

function parseAutoHookTraceEventPlan(value: unknown, capability: string): AutoHookTraceEventPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${capability} native returned invalid traceEvent`);
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.hookId !== 'string' ||
    typeof record.phase !== 'string' ||
    typeof record.priority !== 'number' ||
    typeof record.queue !== 'string' ||
    typeof record.queueIndex !== 'number' ||
    typeof record.queueTotal !== 'number' ||
    (record.result !== 'miss' && record.result !== 'match' && record.result !== 'error') ||
    typeof record.reason !== 'string'
  ) {
    throw new Error(`${capability} native returned malformed traceEvent`);
  }
  const traceQueue =
    record.queue === 'A_optional' || record.queue === 'B_mandatory'
      ? record.queue
      : (() => {
          throw new Error(`${capability} native returned invalid queue`);
        })();
  return {
    hookId: record.hookId,
    phase: record.phase,
    priority: record.priority,
    queue: traceQueue,
    queueIndex: record.queueIndex,
    queueTotal: record.queueTotal,
    result: record.result,
    reason: record.reason,
    ...(typeof record.flowId === 'string' && record.flowId.trim()
      ? { flowId: record.flowId.trim() }
      : {})
  };
}

function parseServertoolLoopStatePayload(resultJson: string, capability: string): ServertoolLoopStateSnapshot | null {
  const parsed = JSON.parse(resultJson) as unknown;
  if (parsed === null) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} native returned invalid payload`);
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.payloadHash !== 'string' || !record.payloadHash.trim()) {
    throw new Error(`${capability} native returned invalid payloadHash`);
  }
  return {
    ...(typeof record.flowId === 'string' && record.flowId.trim() ? { flowId: record.flowId.trim() } : {}),
    payloadHash: record.payloadHash.trim(),
    ...(Number.isInteger(record.repeatCount) ? { repeatCount: record.repeatCount as number } : {}),
    ...(Number.isInteger(record.startedAtMs) ? { startedAtMs: record.startedAtMs as number } : {}),
    ...(typeof record.stopPairHash === 'string' && record.stopPairHash.trim() ? { stopPairHash: record.stopPairHash.trim() } : {}),
    ...(Number.isInteger(record.stopPairRepeatCount) ? { stopPairRepeatCount: record.stopPairRepeatCount as number } : {}),
    ...(typeof record.stopPairWarned === 'boolean' ? { stopPairWarned: record.stopPairWarned } : {})
  };
}

export function resolveServertoolTimeoutMsFromEnvCandidatesWithNative(input: {
  candidates: Array<{ key: string; value?: unknown }>;
}): number {
  const capability = 'resolveServertoolTimeoutMsFromEnvCandidatesJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('resolveServertoolTimeoutMsFromEnvCandidatesJson native unavailable');
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`resolveServertoolTimeoutMsFromEnvCandidatesJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error('resolveServertoolTimeoutMsFromEnvCandidatesJson native returned invalid timeout');
  }
  return parsed;
}

export function planServertoolClientDisconnectedErrorWithNative(input: {
  requestId: string;
  flowId?: string;
}): ServertoolErrorPlan {
  return parseServertoolErrorPlan(
    callServertoolErrorPlanNative('planServertoolClientDisconnectedErrorJson', input),
    'planServertoolClientDisconnectedErrorJson'
  );
}

export function planServertoolTimeoutErrorWithNative(input: {
  requestId: string;
  phase: 'engine' | 'followup';
  timeoutMs: unknown;
  flowId?: string;
  attempt?: unknown;
  maxAttempts?: unknown;
}): ServertoolErrorPlan {
  return parseServertoolErrorPlan(
    callServertoolErrorPlanNative('planServertoolTimeoutErrorJson', input),
    'planServertoolTimeoutErrorJson'
  );
}

export function planServertoolRequiredResponseHookEmptyErrorWithNative(input: {
  requestId: string;
  responseHookName: string;
}): ServertoolErrorPlan {
  return parseServertoolErrorPlan(
    callServertoolErrorPlanNative('planServertoolRequiredResponseHookEmptyErrorJson', input),
    'planServertoolRequiredResponseHookEmptyErrorJson'
  );
}

export function planServertoolExecutionDispatchErrorWithNative(input:
  | {
      kind: 'dispatch_spec_mismatch';
      requestId: string;
      toolName: string;
      nativeExecutionMode: string;
      tsExecutionMode: string;
    }
  | {
      kind: 'invalid_mixed_client_tools_outcome';
      requestId: string;
      outcomeMode: string;
      requiresPendingInjection: boolean;
    }
  | {
      kind: 'missing_servertool_execution_contract';
      requestId: string;
      outcomeMode: string;
    }
): ServertoolErrorPlan {
  return parseServertoolErrorPlan(
    callServertoolErrorPlanNative('planServertoolExecutionDispatchErrorJson', input),
    'planServertoolExecutionDispatchErrorJson'
  );
}

export function buildServertoolPostflightObservationSummaryWithNative(input: {
  engineResult: unknown;
}): Record<string, unknown> {
  const capability = 'buildServertoolPostflightObservationSummaryJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('buildServertoolPostflightObservationSummaryJson native unavailable');
  }
  const raw = fn(JSON.stringify(input));
  if (typeof raw !== 'string') {
    throw new Error(`buildServertoolPostflightObservationSummaryJson native returned non-string: ${typeof raw}`);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('buildServertoolPostflightObservationSummaryJson native returned invalid summary');
  }
  return parsed as Record<string, unknown>;
}

export function resolveServertoolEngineMatchHitWithNative(input: {
  execution: unknown;
}): { flowId: string } {
  const capability = 'resolveServertoolEngineMatchHitJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error(`${capability} native unavailable`);
  }
  const raw = fn(JSON.stringify(input));
  if (typeof raw !== 'string') {
    if (raw && typeof raw === 'object' && typeof (raw as { message?: unknown }).message === 'string') {
      throw new Error((raw as { message: string }).message);
    }
    throw new Error(`${capability} native returned non-string: ${typeof raw}`);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} native returned invalid match hit output`);
  }
  const flowId = (parsed as Record<string, unknown>).flowId;
  if (typeof flowId !== 'string' || flowId.length === 0) {
    throw new Error(`${capability} native returned invalid flowId`);
  }
  return { flowId };
}

export function appendServertoolExecutedRecordWithNative(input: {
  state?: NativeServertoolExecutionLoopState;
  toolCall: NativeServertoolExecutedToolCall;
  execution?: NativeServertoolExecutionSummary;
}): NativeServertoolExecutionLoopState {
  const capability = 'appendServertoolExecutedRecordJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error(`${capability} native unavailable`);
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`${capability} native returned non-string: ${typeof resultJson}`);
  }
  return parseServertoolExecutionLoopState(resultJson, capability);
}

function callServertoolErrorPlanNative(capability: string, input: unknown): string {
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error(`${capability} native unavailable`);
  }
  const resultJson = fn(JSON.stringify(input));
  if (typeof resultJson !== 'string') {
    throw new Error(`${capability} native returned non-string: ${typeof resultJson}`);
  }
  return resultJson;
}

function parseServertoolErrorPlan(resultJson: string, capability: string): ServertoolErrorPlan {
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} native returned invalid error plan`);
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.message !== 'string' ||
    typeof record.code !== 'string' ||
    typeof record.category !== 'string' ||
    !Number.isInteger(record.status) ||
    !record.details ||
    typeof record.details !== 'object' ||
    Array.isArray(record.details)
  ) {
    throw new Error(`${capability} native returned invalid error plan`);
  }
  return {
    message: record.message,
    code: record.code,
    category: record.category,
    status: record.status as number,
    details: record.details as Record<string, unknown>
  };
}

function parseServertoolExecutionLoopState(
  resultJson: string,
  capability: string
): NativeServertoolExecutionLoopState {
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${capability} native returned invalid execution state`);
  }
  const record = parsed as Record<string, unknown>;
  if (
    !Array.isArray(record.executedToolCalls) ||
    !Array.isArray(record.executedIds) ||
    !Array.isArray(record.executedFlowIds)
  ) {
    throw new Error(`${capability} native returned malformed execution state`);
  }
  return {
    executedToolCalls: record.executedToolCalls as NativeServertoolExecutedRecord[],
    executedIds: record.executedIds.map((value) => String(value)),
    executedFlowIds: record.executedFlowIds.map((value) => String(value)),
    ...(record.lastExecution && typeof record.lastExecution === 'object' && !Array.isArray(record.lastExecution)
      ? { lastExecution: record.lastExecution as NativeServertoolExecutionSummary }
      : {})
  };
}

export function buildStopMessageTerminalVisiblePayloadWithNative<TPayload extends Record<string, unknown>>(input: {
  payload: TPayload;
  mode: 'strip' | 'prefix' | 'replace';
  prefix?: string | null;
}): TPayload {
  const capability = 'buildStopMessageTerminalVisiblePayloadJson';
  const fn = readNativeFunction(capability);
  if (!fn) {
    throw new Error('buildStopMessageTerminalVisiblePayloadJson native unavailable');
  }
  const resultJson = fn(JSON.stringify({
    payload: input.payload,
    mode: input.mode,
    prefix: input.prefix ?? null
  }));
  if (typeof resultJson !== 'string') {
    throw new Error(`buildStopMessageTerminalVisiblePayloadJson native returned non-string: ${typeof resultJson}`);
  }
  const parsed = JSON.parse(resultJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`buildStopMessageTerminalVisiblePayloadJson native returned invalid payload: ${typeof parsed}`);
  }
  const payload = (parsed as Record<string, unknown>).payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('buildStopMessageTerminalVisiblePayloadJson native returned invalid terminal payload');
  }
  return payload as TPayload;
}
