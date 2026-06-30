import fs from 'node:fs';
import path from 'node:path';

const DELETED_FILES = [
  'sharedmodule/llmswitch-core/src/servertool/execution-shell.ts',
  'sharedmodule/llmswitch-core/src/servertool/execution-dispatch-outcome-shell.ts',
  'sharedmodule/llmswitch-core/src/servertool/registry.ts',
  'sharedmodule/llmswitch-core/src/servertool/registry-impl.ts',
  'sharedmodule/llmswitch-core/src/servertool/adhoc-handler-test-support.ts',
  'sharedmodule/llmswitch-core/src/servertool/pre-command-hooks.ts',
  'sharedmodule/llmswitch-core/src/servertool/pre-command-runtime-state-shell.ts',
  'sharedmodule/llmswitch-core/src/servertool/pending-session.ts',
  'sharedmodule/llmswitch-core/src/servertool/pending-injection-block.ts',
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
      'const executeBackendPlanViaThinShell',
      'const runServertoolHandlerThinShell',
      'function materializeServertoolPlannedResult(',
      'export async function runServertoolHandler(',
      '[servertool] invalid handler plan contract: missing finalize',
      '[servertool] invalid handler plan/result contract',
      '[servertool] handler failed:',
      'buildHandlerRuntimeActionInput',
      'buildProviderProtocolError',
      "import { ProviderProtocolError }",
      'planServertoolHandlerRuntimeActionWithNative(',
      '[servertool] vision_analysis backend requires reenterPipeline',
      '[servertool] unsupported backend plan kind:',
      "if (planHandlerMaterializationAction(planned, options) === 'handler_plan')",
      'structuredClone(args.base)',
    ],
    required: [
      'function throwServertoolExecutionDispatchError(args: ServertoolExecutionDispatchErrorInput): never',
      'planServertoolExecutionDispatchErrorWithNative(args)',
      'const outcomePlanInput = buildServertoolOutcomePlanInput({',
      'const outcomePlan = planServertoolOutcomeWithNative(outcomePlanInput);',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.ts',
    forbidden: [],
    required: [
      'runServertoolIoExecutionQueue',
      'buildServertoolDispatchPlanInput',
      'planServertoolExecutionLoopRuntimeActionWithNative',
      'createServertoolProviderProtocolErrorFromPlan',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/orchestration-blocks.ts',
    forbidden: [
      'export function appendToolOutput(',
      "nativeRecord({ op: 'append_tool_output'",
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
      'if (!planned) {',
      'if (result) {',
      'if (optionalResult) {',
      'result.execution.flowId.trim()',
      'if (mandatoryResult) {',
    ],
    required: [
      'const finalQueueName = queueOrder[queueOrder.length - 1]?.queueName;',
      'const finalQueue = queue.queueName === finalQueueName;',
      'finalQueue',
      'const toolFlowResult: ServerSideToolEngineResult = {',
      'return toolFlowResult;',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/execution-branch-runtime-shell.ts',
    forbidden: [],
    required: [
      'planServertoolExecutionBranchWithNative',
      'const executableToolCallInputs = args.executableToolCalls.map(',
      'executableToolCalls.map(',
      'executableToolCalls: executableToolCallInputs',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/response-stage-finalize-shell.ts',
    forbidden: [],
    required: [
      'planServertoolResponseStageGateWithNative',
      'runServertoolResponseStageAutoHookPass',
      "const passthroughResult = { mode: 'passthrough', finalChatResponse: args.baseObject } as const;",
      'return passthroughResult;',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/response-stage-prepass-shell.ts',
    forbidden: [],
    required: [
      'planServertoolResponseStageGateWithNative',
      'runServertoolResponseStageAutoHookPass',
      "const continueToExecution = {",
      'responseHookMatched !== true',
      'return continueToExecution;',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/extract-tool-calls-shell.ts',
    forbidden: [],
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
    ],
    required: [
      'readRuntimeMetadataSnapshotFromAnyBoundMetadataCenter',
      'planServertoolToolCallDispatchWithNative',
      'const dispatchPlanInput = buildServertoolDispatchPlanInput({',
      'dispatchPlan: planServertoolToolCallDispatchWithNative(dispatchPlanInput)',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/entry-preflight-shell.ts',
    forbidden: [],
    required: [
      'planServertoolEntryPreflightWithNative',
      'createServerToolClientDisconnectedError',
      "const passthroughResult = { mode: 'passthrough', finalChatResponse: args.options.chatResponse } as const;",
      'result: passthroughResult',
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
    forbidden: [],
    required: [
      'resolveServertoolEntryContext',
      'asServertoolJsonObject',
      'planServertoolEntryContextWithNative',
      'const includeToolCallNames = tokenSetFromNativePlan(entryContextPlan.includeToolCallNames);',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/run-server-side-tool-engine-shell.ts',
    forbidden: [],
    required: [
      'orchestrateServertoolEngine',
      "const passthroughResult = { mode: 'passthrough', finalChatResponse: options.chatResponse } as const;",
      'return passthroughResult;',
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
      'isStopMessageAutoPreProjection',
    ],
    required: [
      'prepareServertoolDispatchStage',
      'planServertoolExecutionBranchRuntimeAction',
      'const preExecutionBranchInput = {',
      'const preExecutionBranchPlan = planServertoolExecutionBranchRuntimeAction(preExecutionBranchInput);',
      'const postExecutionBranchInput = {',
      'const postExecutionBranchPlan = planServertoolExecutionBranchRuntimeAction(postExecutionBranchInput);',
      'runServertoolIoExecutionQueue',
      'materializeNativeToolCallExecutionOutcome',
      'finalizeServertoolResponseStage',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts',
    forbidden: [
      'runServertoolResponseStageWithNative',
      'const responseStage =',
      'readFollowupClientInjectSourceWithNative',
    ],
    required: [
      'planServertoolResponseStageGateWithNative',
      'const responseStageGateInput = {',
      'const gatePlan = planServertoolResponseStageGateWithNative(responseStageGateInput);',
      'detectProviderResponseShapeWithNative',
      'const orchestrationInput = {',
      'const orchestration = await runServerToolOrchestration(orchestrationInput);',
      'runServerToolOrchestration',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.ts',
    forbidden: [
      "import './handlers/stop-message-auto.js';",
      "import './handlers/vision.js';",
      'if (!base) {',
      'if (isAdapterClientDisconnected(options.adapterContext)) {',
      "responseStagePlan?.nextAction === 'bypass'",
      'responseStageNextAction:',
      "(responseStagePlan as Record<string, unknown>).nextAction",
      'if (autoHookResult) {',
      "postAutoHookRuntimeAction.action === 'return_auto_hook_result' && autoHookResult",
      "const preAutoHookRuntimeAction = planServertoolResponseStageRuntimeActionWithNative(",
      "const postAutoHookRuntimeAction = planServertoolResponseStageRuntimeActionWithNative(",
      "await runServertoolAutoHookCaller({",
      'planServertoolResponseStageGateWithNative(',
      'runServertoolResponseStageAutoHookPass(',
      'toolCall.id === preExecutionBranchPlan.projectedToolCallId',
      '[servertool] native execution-branch projected missing tool call id:',
      '[servertool] native execution-branch projected missing tool call index:',
      'planServertoolExecutionBranchWithNative(',
      'buildServertoolCliProjectionForToolCall(',
      'buildServertoolCliProjectionExecutionContextWithNative(',
      'capabilities: runtimeCapabilities',
      'deriveServertoolRuntimeCapabilities(',
      "typeof options.providerInvoker === 'function' || typeof options.reenterPipeline === 'function'",
        "'SERVERTOOL_CLIENT_DISCONNECTED'",
        "'[servertool] client disconnected before servertool execution'",
        '.find(isClientExecCliProjectionToolCall)',
      'executionState.executedToolCalls.length > 0',
        "executionMode === 'client_exec_cli_projection'",
        "flowId: 'servertool_cli_projection'",
        'servertoolCliProjection: {',
      'readRuntimeControlFromAnyBoundMetadataCenter(',
      'const responseStagePlan = responseHookStagePlan.responseHookMatched ? responseHookStagePlan : planServertoolResponseStageGateWithNative(',
      "if (responseStageAutoHook.action === 'return_passthrough_bypass') {",
      'const stage = runServertoolResponseStageWithNative(chatResponse, requestId);',
      'replaceJsonObjectInPlace(chatResponse, normalizedPayload);',
      'readRuntimeMetadata(options.adapterContext as unknown as Record<string, unknown>);',
      'planServertoolToolCallDispatchWithNative(',
      'prepareServertoolDispatchStage(',
      'planServertoolExecutionBranchRuntimeAction(',
      'buildServertoolCliProjectionBranchResult(',
      'runServertoolIoExecutionQueue(',
      'materializeNativeToolCallExecutionOutcome(',
      'finalizeServertoolResponseStage(',
      'const baseForExecution = structuredClone(baseObject);',
      'function normalizeFilterTokenSet(',
      'function asObject(',
      'const contextBase: Omit<ServerToolHandlerContext, \'toolCall\'> = {',
      'runServertoolEntryPreflight(',
      'runServertoolResponseStagePrePass(',
      'runServertoolExecutionStage(',
      'resolveServertoolEntryContext(',
      'asServertoolJsonObject(',
      'const entryPreflightPlan = planServertoolEntryPreflightWithNative({',
      "if (entryPreflightPlan.action === 'return_passthrough_non_object_chat') {",
      "if (entryPreflightPlan.action === 'throw_client_disconnected') {",
      "import type { AdapterContext } from '../conversion/hub/types/chat-envelope.js';",
      'function getArray(value: unknown): JsonValue[] {',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/cli-projection-runtime-shell.ts',
    forbidden: [
      'toolCall.id === preExecutionBranchPlan.projectedToolCallId',
      '.find(isClientExecCliProjectionToolCall)',
      'function parseToolArguments(',
      'JSON.parse(value)',
    ],
    required: [
      'const projectionInput = parseServertoolCliProjectionToolArgumentsWithNative({',
      'input: projectionInput',
      'const projectionShellInput = {',
      'const chatResponse = buildClientVisibleProjectionShellWithNative(projectionShellInput) as JsonObject;',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/engine-postflight-shell.ts',
    forbidden: [
      'const followupSummary: Record<string, unknown> = {',
      "if ('payload' in followup)",
      'payloadRecord.messages',
      'payloadRecord.input',
      "if ('injection' in followup)",
      'followup.injection?.ops',
    ],
    required: [
      'buildServertoolPostflightObservationSummaryWithNative({',
      "args.stageRecorder.record('servertool.execution', summary);",
      'const engineFinalResult = {',
      'return engineFinalResult;',
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
    file: 'sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts',
    forbidden: [
      'providerInvoker?:',
      'reenterPipeline?:',
      'clientInjectDispatch?:',
      'capabilities: {',
      'providerInvoker: options.providerInvoker',
      'reenterPipeline: options.reenterPipeline',
      'clientInjectDispatch: options.clientInjectDispatch'
    ],
    required: [
      'const bypassResult: ServertoolResponseStageShellResult = {',
      'return bypassResult;',
      'const passthroughResult: ServertoolResponseStageShellResult = {',
      'return passthroughResult;',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/registry-registration-shell.ts',
    forbidden: [
      'planServertoolRegistryRegistrationActionWithNative',
      'planServertoolRegistryLookupActionWithNative',
      'builtinNameMatched',
      'builtinEntryPresent',
      'registrationAllowedByConfig',
      'isServertoolEnabledByConfig',
      'getServertoolToolSpec(name)?.enabled',
      'registerServerToolHandlerViaNativePlan',
      'handler: ServerToolHandler',
      'hasHandler:',
      'function resolveBuiltinEntry(',
      '.trim().toLowerCase()',
    ],
    required: [
      'const registryLookupInput = {',
      'const actionPlan = planServertoolRegistryLookupFromSkeleton(registryLookupInput);',
      'planServertoolRegistryLookupFromSkeleton(',
      'isServertoolRegisteredNameByConfig(',
      'getServerToolHandlerViaNativePlan',
    ],
  },
  {
    file: 'sharedmodule/llmswitch-core/src/servertool/registry-projection-shell.ts',
    forbidden: [
      'function canonicalName(',
      '.trim().toLowerCase()',
      'native registry source projection mismatch',
    ],
    required: [
      'planServertoolRegistryAutoHookDescriptorsWithNative',
      'projectAutoServerToolHookDescriptors',
      'planServertoolRegistrySourceProjectionWithNative',
      'projectRegistrySources',
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

// ── stop-message-auto native-catalog audit ───────────────────────────────────

describe('stop-message-auto native-catalog audit', () => {
  test('builtin-handler-catalog delegates stop-message-auto execution to Rust-owned native runtime', () => {
    const source = fs.readFileSync(repoPath('sharedmodule/llmswitch-core/src/servertool/builtin-handler-catalog.ts'), 'utf8');

    expect(source).toContain('runStoplessBuiltinHandlerForRuntimeWithNative');
    expect(source).toContain('runBuiltinHandlerForRuntimeNapi');
    expect(source).toContain('function runBuiltinHandler(');
    expect(source).toContain('resolveServertoolBuiltinHandlerEntry');

    const forbidden = [
      'runStoplessAutoHandlerRuntimeJson',
      'readNativeFunction',
      'JSON.parse(raw)',
      'runtime.action',
      "runtime.action === 'return_null'",
      "runtime.action === 'throw_error'",
      "runtime.action !== 'return_handler_result'",
      "case 'stop_message_auto'",
      "name === 'stop_message_auto'",
      "plan.action === 'return_none'",
      "plan.action !== 'return_entry'",
      '.map((name) => getBuiltinHandlerEntry(name))',
      '.filter((entry): entry is ServerToolHandlerEntry => Boolean(entry?.autoHook))',
      '.filter((entry): entry is ServerToolHandlerEntry => Boolean(entry))',
      'readPersistedStopMessageSnapshotFromCandidateKeys',
      'readPersistedStopMessageStageModeFromCandidateKeys',
      'readPersistedStopMessageTombstoneFromCandidateKeys',
      'isDefaultStopMessageExhausted',
      'isStopMessageClearedTombstone',
      'function hasResponsesSubmitToolOutputsResume',
      'function isStopMessageDisabledByPort',
      'function isPlanModeActiveFromCapturedRequest',
      'toolOutputsDetailed.length',
      'routecodexPortStopMessageEnabled',
      'collaboration mode: plan',
      'function resolveStopMessageDefaultEnabledLive',
      'function resolveStopMessageDefaultTextLive',
      'function resolveStopMessageDefaultMaxRepeatsLive',
      'const gateMaxRepeats',
      'const resolvedMaxRepeats',
      'const schemaBudgetMaxRepeats',
      'const nextMaxRepeats',
      'const nextUsed',
      'Math.max(0, Math.floor(persistedSnap.maxRepeats))',
      'Math.max(0, Math.floor(persistedSnap.used))',
      'Math.max(0, Math.floor(runtimeSnap.maxRepeats))',
      'Math.max(0, Math.floor(runtimeSnap.used))',
      "String(persistedSnap.text ?? '')",
      "String(runtimeSnap.text ?? '')",
      'const STOP_MESSAGE_EXECUTION_APPEND',
      'resolveStopMessageSnapshot(loadRoutingInstructionStateSync',
      'normalizeStopMessageStageMode(state?.stopMessageStageMode',
      'stopMessageSource ===',
    ];
    const hits = forbidden.filter((marker) => source.includes(marker));
    expect(hits).toEqual([]);
    expect(source).toContain('planServertoolBuiltinAutoHandlerEntries');
    expect(source).toContain('planServertoolBuiltinHandlerRecordEntries');
  });
});
