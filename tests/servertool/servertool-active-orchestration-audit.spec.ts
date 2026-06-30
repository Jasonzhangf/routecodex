import fs from 'node:fs';
import path from 'node:path';

const DELETED_FILES = [
  'sharedmodule/llmswitch-core/src/servertool/execution-shell.ts',
  'sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts',
  'sharedmodule/llmswitch-core/src/servertool/registry.ts',
  'sharedmodule/llmswitch-core/src/servertool/registry-impl.ts',
  'sharedmodule/llmswitch-core/src/servertool/adhoc-handler-test-support.ts',
  'sharedmodule/llmswitch-core/src/servertool/registry-registration-shell.ts',
  'sharedmodule/llmswitch-core/src/servertool/registry-projection-shell.ts',
  'sharedmodule/llmswitch-core/src/servertool/builtin-handler-catalog.ts',
  'sharedmodule/llmswitch-core/src/servertool/pre-command-hooks.ts',
  'sharedmodule/llmswitch-core/src/servertool/pre-command-runtime-state-shell.ts',
  'sharedmodule/llmswitch-core/src/servertool/pending-session.ts',
  'sharedmodule/llmswitch-core/src/servertool/pending-injection-block.ts',
  'sharedmodule/llmswitch-core/src/servertool/skeleton-config.ts',
  'sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/pre_command_hook_contract.rs',
  'sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/pending_session_contract.rs',
] as const;

const TARGETS = [
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.ts',
    forbidden: [
      'const SERVERTOOL_BACKEND_EXECUTORS',
      'const servertoolBackendExecutors',
      'const materializePlannedServertoolResult',
      'function dehydrateExecutionLoopState(',
      'function hydrateExecutionLoopState(',
      'createServertoolExecutionLoopStateFromNative',
      'appendExecutedToolRecordFromNative',
      'new Set(state.executedIds)',
      'const executeBackendPlanViaThinShell',
      'const runServertoolHandlerThinShell',
      'export async function executeBuiltinServerToolHandler(',
      'function materializeServertoolPlannedResult(',
      'export async function runServertoolHandler(',
      '[servertool] invalid handler plan contract: missing finalize',
      '[servertool] invalid handler plan/result contract',
      '[servertool] handler failed:',
      'buildHandlerRuntimeActionInput',
      'buildProviderProtocolError',
      'function throwServertoolExecutionDispatchError(',
      'planServertoolExecutionDispatchErrorWithNative(args)',
      "import { ProviderProtocolError }",
      'planServertoolHandlerRuntimeActionWithNative(',
      '[servertool] vision_analysis backend requires reenterPipeline',
      '[servertool] unsupported backend plan kind:',
      "if (planHandlerMaterializationAction(planned, options) === 'handler_plan')",
      'structuredClone(args.base)',
    ],
    required: [
      'throw createServertoolProviderProtocolErrorFromPlan(',
      'planServertoolExecutionDispatchErrorWithNative({',
      'const outcomePlan = planServertoolOutcomeWithNative(',
      'buildServertoolOutcomePlanInputWithNative({',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.ts',
    forbidden: [
      '  ToolCall\n} from \'./types.js\';',
    ],
    required: [
      'runServertoolIoExecutionQueue',
      'planServertoolExecutionLoopRuntimeActionWithNative',
      'createServertoolExecutionLoopStateWithNative',
      'appendServertoolExecutedRecordWithNative',
      'createServertoolProviderProtocolErrorFromPlan',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/orchestration-blocks.ts',
    forbidden: [
      'export function appendToolOutput(',
      "nativeRecord({ op: 'append_tool_output'",
      'export function buildAssistantToolCallMessage(',
      'export function buildToolMessagesFromOutputs(',
      'export function stripToolOutputs(',
      'export function patchToolCallArgumentsById(',
      'export function filterOutExecutedToolCalls(',
      'function nativeArray(',
      'function nativeRecord(',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/orchestration-policy-block.ts',
    forbidden: [
      'export function resolveServerToolFollowupTimeoutMs(',
      'export function readClientInjectOnly(',
      'export function normalizeClientInjectText(',
      'export function compactFollowupErrorReason(',
      'export function resolveAdapterContextProviderKey(',
      'readClientInjectOnlyWithNative',
      'normalizeClientInjectTextWithNative',
      'compactFollowupErrorReasonWithNative',
      'resolveAdapterContextProviderKeyWithNative',
    ],
    required: [
      'function resolveServerToolTimeoutMsFromEnv(',
      'parseServertoolTimeoutMsWithNative({ raw: raw || undefined })',
      'export function resolveServerToolTimeoutMs()',
      'export function containsSyntheticRouteCodexControlText(',
      'containsSyntheticRouteCodexControlTextWithNative(value)',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts',
    forbidden: [
      "outcome: 'error'",
      "outcome: 'planned_null'",
      "outcome: 'materialized_match'",
      "outcome: 'materialized_empty'",
      "result: 'error'",
      "reason: 'predicate_false'",
      "reason: 'matched_without_flow'",
      "reason: 'empty_materialized_result'",
      'errorAttemptInput',
      'runtimeAttemptInput',
      'callerFinalizationInput',
      'if (!planned) {',
      'if (result) {',
      'if (optionalResult) {',
      'result.execution.flowId.trim()',
      'if (mandatoryResult) {',
      'const toolFlowResult: ServerSideToolEngineResult = {',
      'return toolFlowResult;',
      'export async function runAutoHookExecutionQueue(',
      'ServerToolHandlerPlan',
      'function planAutoHookRuntimeAttempt(',
      'const attemptPlan = planAutoHookRuntimeAttempt({',
      'function planAutoHookCallerFinalization(',
      'const finalizationPlan = planAutoHookCallerFinalization({',
    ],
    required: [
      'const attemptPlan = planAutoHookRuntimeAttemptWithNative({',
      'const finalQueueName = queueOrder[queueOrder.length - 1]?.queueName;',
      'const finalQueue = queue.queueName === finalQueueName;',
      'const finalizationPlan = planAutoHookCallerFinalizationWithNative({',
      'finalQueue',
      "mode: 'tool_flow'",
      'finalChatResponse: queueResult.chatResponse',
      'execution: queueResult.execution',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/response-stage-finalize-shell.ts',
    forbidden: [
      "const passthroughResult = { mode: 'passthrough', finalChatResponse: args.baseObject } as const;",
      'return passthroughResult;',
    ],
    required: [
      'planServertoolResponseStageGateWithNative',
      'runServertoolResponseStageAutoHookPass',
      "return { mode: 'passthrough', finalChatResponse: args.baseObject };",
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/response-stage-prepass-shell.ts',
    forbidden: [],
    required: [
      'planServertoolResponseStageGateWithNative',
      'runServertoolResponseStageAutoHookPass',
      'responseHookMatched !== true',
      "action: 'continue_to_execution' as const",
      'responseStageGatePlan',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/extract-tool-calls-shell.ts',
    forbidden: [
      'function asObject(',
    ],
    required: [
      'runServertoolResponseStageWithNative',
      'replaceJsonObjectInPlace',
      'stage.toolCalls.map(',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/dispatch-preparation-shell.ts',
    forbidden: [
      "from '../conversion/runtime-metadata.js'",
      'readRuntimeMetadata(',
      'resolveServertoolRuntimePreCommandState',
      'applyPreCommandHooksToToolCalls',
      'buildServertoolDispatchPlanInput(',
    ],
    required: [
      'readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter',
      'planServertoolToolCallDispatchWithNative',
      'buildServertoolDispatchPlanInputWithNative',
      'dispatchPlan: planServertoolToolCallDispatchWithNative(',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/entry-preflight-shell.ts',
    forbidden: [],
    required: [
      'planServertoolEntryPreflightWithNative',
      'createServerToolClientDisconnectedError',
      "result: { mode: 'passthrough', finalChatResponse: args.options.chatResponse }",
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/engine-preflight-shell.ts',
    forbidden: [],
    required: [
      'runEnginePreflight',
      'planServertoolEnginePreflightWithNative',
      'inspectStopGatewaySignal(',
      'attachStopGatewayContext(',
      'containsSyntheticRouteCodexControlText(',
      'return_original_chat_direct_passthrough',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/entry-context-shell.ts',
    forbidden: [
      'export function asServertoolJsonObject(',
    ],
    required: [
      'resolveServertoolEntryContext',
      'planServertoolEntryContextWithNative',
      'const includeToolCallNames =',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/run-server-side-tool-engine-shell.ts',
    forbidden: [
      "const passthroughResult = { mode: 'passthrough', finalChatResponse: options.chatResponse } as const;",
      "import type { JsonObject } from '../conversion/hub/types/json.js';",
    ],
    required: [
      'orchestrateServertoolEngine',
      'runServertoolEntryPreflight',
      'extractToolCallsFromResponseStage',
      'resolveServertoolEntryContext',
      'runServertoolResponseStagePrePass',
      'runServertoolExecutionStage',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/execution-stage-shell.ts',
    forbidden: [
      'structuredClone(args.baseObject)',
      'const baseForExecution = structuredClone',
      'const baseForExecution = args.baseObject;',
      'isStopMessageAutoPreProjection',
      'filterOutExecutedToolCalls',
      'stripToolOutputs',
      'function planExecutionBranchRuntimeAction(',
      'const preExecutionBranchPlan = planExecutionBranchRuntimeAction({',
      'const postExecutionBranchPlan = planExecutionBranchRuntimeAction({',
    ],
    required: [
      'prepareServertoolDispatchStage',
      'planServertoolExecutionBranchWithNative',
      'const preExecutionBranchPlan = planServertoolExecutionBranchWithNative({',
      'const postExecutionBranchPlan = planServertoolExecutionBranchWithNative({',
      'runServertoolIoExecutionQueue',
      'materializeNativeToolCallExecutionOutcome',
      'finalizeServertoolResponseStage',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts',
    forbidden: [
      "from './server-side-tools-impl.js'",
      'runServertoolResponseStageWithNative',
      'const responseStage =',
      'readFollowupClientInjectSourceWithNative',
      'writeRuntimeControlToBoundMetadataCenter(',
      'servertoolResponseOrchestration',
      'providerProtocol: ProviderProtocol;',
      'function planServertoolResponseStageGate(',
      'const gatePlan = planServertoolResponseStageGate({',
    ],
    required: [
      'const gatePlan = planServertoolResponseStageGateWithNative({',
      'detectProviderResponseShapeWithNative',
      'const orchestration = await runServerToolOrchestrationShell(',
      'runServerToolOrchestrationShell',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/cli-projection-runtime-shell.ts',
    forbidden: [
      'toolCall.id === preExecutionBranchPlan.projectedToolCallId',
      '.find(isClientExecCliProjectionToolCall)',
      'export function isClientExecCliProjectionToolCall(',
      'export const collectAdditionalClientToolCalls',
      'function parseToolArguments(',
      'JSON.parse(value)',
      'const projectionShellInput = {',
      'buildClientVisibleProjectionShellWithNative(projectionShellInput)',
      'function buildClientVisibleProjectionShellForRuntime(',
      'const projectionInput = parseServertoolCliProjectionToolArgumentsWithNative({',
      'input: projectionInput',
      'const nativeProjection = buildClientExecCliProjectionOutputWithNative({',
      'const chatResponse = buildClientVisibleProjectionShellWithNative({',
      'const execution = buildServertoolCliProjectionExecutionContextWithNative({',
    ],
    required: [
      'input: parseServertoolCliProjectionToolArgumentsWithNative({',
      'const additionalToolCalls = collectServertoolAdditionalClientToolCallsWithNative({',
      'finalChatResponse: buildClientVisibleProjectionShellWithNative({',
      'execution: buildServertoolCliProjectionExecutionContextWithNative({',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/engine-postflight-shell.ts',
    forbidden: [
      'function applyServertoolPostflightMetadataWritePlan(',
      'function buildStoplessProjectionMetadataCenterSnapshot(',
      'function printServertoolLine(',
      "symbol: 'applyServertoolPostflightMetadataWritePlan'",
      'const followupSummary: Record<string, unknown> = {',
      "if ('payload' in followup)",
      'payloadRecord.messages',
      'payloadRecord.input',
      "if ('injection' in followup)",
      'followup.injection?.ops',
      'const engineFinalResult = {',
      'return engineFinalResult;',
    ],
    required: [
      'buildServertoolPostflightObservationSummaryWithNative({',
      "args.stageRecorder.record('servertool.execution', summary);",
      'chat: engineResult.finalChatResponse',
      'executed: true',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/progress-log-block.ts',
    forbidden: [
      'function resolveStage(',
      'function normalizeResult(',
      'event.reason.trim().toLowerCase().replace',
      'compareContext.reason.toLowerCase().replace',
      'extra.flowId.trim()',
      'flowId.trim()',
    ],
    required: [
      'normalizeServertoolProgressFlowIdWithNative({ value: extra?.flowId })',
      'normalizeServertoolProgressFlowIdWithNative({ value: flowId })',
      'resolveServertoolProgressStageWithNative({ step, message })',
      'normalizeServertoolProgressResultWithNative({ message })',
      'normalizeServertoolProgressTokenWithNative({ value: event.reason })',
      'normalizeServertoolProgressTokenWithNative({ value: compareContext.reason })',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/engine.ts',
    forbidden: [
      'function extractStoplessReasoningText(',
      'function extractStoplessLoopState(',
      'function readStoplessRouteName(',
      'function isDirectStoplessDisabled(',
      'const loopState = extractStoplessLoopState(',
      'reasoningText: extractStoplessReasoningText(',
      'const triggerHint = [',
      'const schemaFeedbackCandidate = [',
      'const repeatCount =',
      'const maxRepeats =',
      'const hasServertoolCliProjectionContext =',
      '.servertoolCliProjection',
      'extractCurrentAssistantStopTextWithNative(chatResponse ?? null) ||',
      'if (\n    containsSyntheticRouteCodexControlText(options.chat)\n  )',
      'if (stoplessIsDisabledOnDirectRoute(options.adapterContext))',
      "if (engineResult.mode === 'passthrough' || !engineResult.execution)",
      "!stoplessPlan.isStopMessageFlow &&",
      "if (stoplessPlan.action === 'terminal_final')",
      "if (stoplessPlan.action === 'cli_projection' && stoplessPlan.isStopMessageFlow)",
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
    forbidden: [
      'const stoplessExecutionInput = {',
      'const hasServertoolCliProjectionContext =',
      'function planStoplessEngineRuntime(',
      'const { stoplessExecution, runtimeAction } = planStoplessEngineRuntime({',
      'planStoplessExecutionWithNative(stoplessExecutionInput)',
      'const postflightEngineResult = {',
      'engineResult: postflightEngineResult,',
      'function createServerToolEngineRunner(',
      'type ServerToolEngineRunner =',
    ],
    required: [
      'const stoplessExecutionPlan = planStoplessExecutionWithNative({',
      'const runtimeAction = planServertoolEngineRuntimeActionWithNative({',
      'engineResult: {',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts',
    forbidden: [
      'providerInvoker?:',
      'reenterPipeline?:',
      'clientInjectDispatch?:',
      'capabilities: {',
      'providerInvoker: options.providerInvoker',
      'reenterPipeline: options.reenterPipeline',
      'clientInjectDispatch: options.clientInjectDispatch',
      'const bypassResult: ServertoolResponseStageShellResult = {',
      'return bypassResult;',
      'const passthroughResult: ServertoolResponseStageShellResult = {',
      'return passthroughResult;',
    ],
    required: [
      "return {",
      'payload: options.payload',
      'executed: false',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/registry-orchestration-shell.ts',
    forbidden: [
      'isRegisteredServerToolNameViaNativeConfig',
      'isServertoolRegisteredNameByConfig',
      'type ServerToolHandlerRegistrationSpec',
      'export const listAutoServerToolHandlers',
      'getServerToolHandlerViaNativePlan',
      'export function listRegisteredServerToolHandlerNames(',
      'export function listRegisteredServerToolHandlerRecords(',
      'projectCurrentRegistrySources',
      'projectRegistrySources',
      'listBuiltinHandlerNames',
      'listBuiltinHandlerRecordEntries',
      "from './registry-projection-shell.js'",
      'projectAutoServerToolHookDescriptors',
    ],
    required: [
      'const actionPlan = planServertoolRegistryLookupFromSkeletonWithNative({',
      'planServertoolRegistryAutoHookDescriptorsWithNative({',
      'resolveServertoolRegisteredNameWithNative',
      'return resolveServertoolRegisteredNameWithNative({ name });',
    ],
  },
] as const;

function repoPath(relativePath: string): string {
  return path.join(process.cwd(), relativePath);
}

describe('servertool active orchestration audit', () => {
  for (const file of DELETED_FILES) {
    test(`${file} must stay physically deleted`, () => {
      expect(fs.existsSync(repoPath(file))).toBe(false);
    });
  }

  for (const target of TARGETS) {
    test(`${target.file} must not retain active orchestration owner markers`, () => {
      const source = fs.readFileSync(repoPath(target.file), 'utf8');
      const hits = target.forbidden.filter((marker) => source.includes(marker));
      expect(hits).toEqual([]);
      if (Array.isArray((target as { required?: string[] }).required)) {
        const misses = ((target as { required?: string[] }).required ?? []).filter(
          (marker) => !source.includes(marker)
        );
        expect(misses).toEqual([]);
      }
    });
  }
});
