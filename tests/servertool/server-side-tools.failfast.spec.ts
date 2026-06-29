import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

const TOOL_NAME = 'failfast_test_tool';
let failfastInvocationCount = 0;
const loadRoutingInstructionStateSyncMock = jest.fn();
const applyPreCommandHooksToToolCallsMock = jest.fn(() => {});
const planServertoolResponseStageGateWithNativeMock = jest.fn(() => ({
  shouldBypass: false,
  nextAction: 'run_auto_hooks'
}));
const planServertoolResponseStageRuntimeActionWithNativeMock = jest.fn((input: any) => {
  const nextAction = String(input?.responseStageGatePlan?.nextAction ?? input?.responseStageNextAction ?? '').trim();
  if (nextAction === 'bypass') {
    return { action: 'return_passthrough_bypass' };
  }
  if (input?.autoHookEvaluated !== true) {
    return { action: 'run_auto_hooks' };
  }
  if (input?.hasAutoHookResult === true) {
    return { action: 'return_auto_hook_result' };
  }
  if (input?.responseHookRequired === true) {
    return { action: 'return_required_response_hook_empty' };
  }
  return { action: 'return_passthrough_no_auto_hook_result' };
});
const planServertoolRequiredResponseHookEmptyErrorWithNativeMock = jest.fn((input: any) => ({
  code: 'SERVERTOOL_REQUIRED_RESPONSE_HOOK_EMPTY',
  category: 'INTERNAL_ERROR',
  status: 500,
  message: `[servertool] required response hook produced no result: ${String(input?.responseHookName ?? '')}`,
  details: {
    requestId: String(input?.requestId ?? ''),
    responseHookName: String(input?.responseHookName ?? '')
  }
}));
const planServertoolExecutionBranchWithNativeMock = jest.fn((input: any) => {
  const executableToolCalls = Array.isArray(input?.executableToolCalls) ? input.executableToolCalls : [];
  const cliProjected = executableToolCalls.find((toolCall: any) => {
    const executionMode = typeof toolCall?.executionMode === 'string' ? toolCall.executionMode.trim() : '';
    return executionMode === 'client_exec_cli_projection';
  });
  if (cliProjected) {
    return {
      action: 'client_exec_cli_projection',
      projectedToolCallId: String(cliProjected.id ?? ''),
      projectedToolCallIndex: executableToolCalls.indexOf(cliProjected)
    };
  }
  return Number(input?.executedToolCallsLen ?? 0) > 0
    ? { action: 'resolve_execution_outcome' }
    : { action: 'continue_response_stage' };
});
const planServertoolEntryPreflightWithNativeMock = jest.fn((input: any) => {
  if (input?.hasBaseObject !== true) {
    return { action: 'return_passthrough_non_object_chat' };
  }
  if (input?.adapterClientDisconnected === true) {
    return { action: 'throw_client_disconnected' };
  }
  return { action: 'continue_to_tool_flow' };
});
const planRuntimePreCommandStateRuntimeActionWithNativeMock = jest.fn((input: any) => {
  const runtimeControl = input?.runtimeControlPreCommandState;
  if (runtimeControl && typeof runtimeControl === 'object' && !Array.isArray(runtimeControl)) {
    return {
      action: 'use_selected',
      source: 'runtime_control',
      state: runtimeControl
    };
  }
  return {
    action: 'use_selected',
    source: 'none',
    state: undefined
  };
});

function readDisconnectedFlag(adapterContext: any): boolean {
  const direct = adapterContext?.clientDisconnected;
  const nested = adapterContext?.clientConnectionState?.disconnected;
  const raw = nested ?? direct;
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (typeof raw === 'string') {
    return raw.trim().toLowerCase() === 'true';
  }
  return false;
}

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js',
  () => ({
    planServertoolRegistryRegistrationActionWithNative: jest.fn((input: any) => ({
      action:
        typeof input?.name === 'string' && input.name.trim()
          ? input?.builtinEntryPresent
            ? 'ignore_builtin_override'
            : input?.builtinNameMatched && input?.registrationAllowedByConfig === false
              ? 'ignore_disabled'
              : input?.hasHandler
                ? 'ignore_disabled'
                : 'ignore_invalid'
          : 'ignore_invalid'
    })),
    planServertoolRegistryLookupActionWithNative: jest.fn((input: any) => ({
      action: input?.builtinEntryPresent
        ? 'return_builtin'
        : 'return_none'
    })),
    planServertoolRegistryAutoHookDescriptorsWithNative: jest.fn((input: any) =>
      Array.isArray(input?.hooks)
        ? input.hooks.map((hook: any) => ({
            id: String(hook?.id ?? '').trim().toLowerCase(),
            phase:
              hook?.phase === 'pre' || hook?.phase === 'post'
                ? hook.phase
                : 'default',
            priority: Number.isFinite(hook?.priority) ? Number(hook.priority) : 100,
            order: Number.isFinite(hook?.order) ? Number(hook.order) : 0
          }))
        : []
    ),
    planServertoolRegistryProjectionWithNative: jest.fn((input: any) => {
      const registeredNames = [...new Set(
        Array.isArray(input?.registeredNames)
          ? input.registeredNames.map((name: any) => String(name ?? '').trim().toLowerCase()).filter(Boolean)
          : []
      )].sort();
      const autoHandlerNames = Array.isArray(input?.autoHandlerNames)
        ? input.autoHandlerNames.map((name: any) => String(name ?? '').trim().toLowerCase()).filter(Boolean)
        : [];
      const registeredRecords = Array.isArray(input?.registeredRecords)
        ? input.registeredRecords
            .map((record: any) => ({
              name: String(record?.name ?? '').trim().toLowerCase(),
              trigger: String(record?.trigger ?? '').trim(),
              sourceIndex: Number(record?.sourceIndex)
            }))
            .filter((record: any) =>
              record.name &&
              (record.trigger === 'tool_call' || record.trigger === 'auto') &&
              Number.isInteger(record.sourceIndex) &&
              record.sourceIndex >= 0
            )
            .sort((left: any, right: any) => {
              const rank = (value: string) => (value === 'tool_call' ? 0 : 1);
              return rank(left.trigger) - rank(right.trigger) || left.sourceIndex - right.sourceIndex;
            })
        : [];
      return {
        registeredNames,
        registeredRecords,
        autoHandlerNames
      };
    }),
    planServertoolRegistrySourceProjectionWithNative: jest.fn((input: any) => ({
      registeredNames: [
        ...(Array.isArray(input?.builtinNames) ? input.builtinNames : [])
      ].map((name: any) => String(name ?? '').trim().toLowerCase()).filter(Boolean).sort(),
      autoHandlerRefs: [
        ...(Array.isArray(input?.builtinAutoHandlerNames)
          ? input.builtinAutoHandlerNames.map((name: any, sourceIndex: number) => ({
              name: String(name ?? '').trim().toLowerCase(),
              source: 'builtin',
              sourceIndex
            }))
          : [])
      ],
      registeredRecordRefs: [
        ...(Array.isArray(input?.builtinRecords)
          ? input.builtinRecords.map((record: any, sourceIndex: number) => ({
              name: String(record?.name ?? '').trim().toLowerCase(),
              trigger: String(record?.trigger ?? '').trim().toLowerCase(),
              source: 'builtin',
              sourceIndex
            }))
          : [])
      ]
    })),
    formatStopMessageCompareContextWithNative: jest.fn(() => ''),
    inspectStopGatewaySignalWithNative: jest.fn(() => ({
      isStop: false,
      finishReason: null,
      gatewayFlowId: null,
      hasChoices: true,
    })),
    normalizeStopGatewayContextWithNative: jest.fn((value: any) => value),
    normalizeStopMessageCompareContextWithNative: jest.fn((value: any) => value),
    planServertoolEntryContextWithNative: jest.fn((input: any) => ({
      includeToolCallNames: input?.includeToolCallHandlerNames,
      excludeToolCallNames: input?.excludeToolCallHandlerNames,
      includeAutoHookIds: input?.includeAutoHookIds,
      excludeAutoHookIds: input?.excludeAutoHookIds,
    })),
    planServertoolEntryPreflightWithNative: planServertoolEntryPreflightWithNativeMock,
    isServertoolClientExecCliProjectionToolCallWithNative: jest.fn((input: any) => {
      const executionMode = typeof input?.executionMode === 'string' ? input.executionMode.trim() : '';
      return executionMode === 'client_exec_cli_projection';
    }),
    isAdapterClientDisconnectedWithNative: jest.fn((adapterContext: unknown) =>
      readDisconnectedFlag(adapterContext as any)
    ),
    planClientDisconnectWatcherWithNative: jest.fn((pollIntervalMs?: number) => ({
      intervalMs: Math.max(1, Math.floor(Number.isFinite(pollIntervalMs) ? Number(pollIntervalMs) : 25))
    })),
    planServertoolClientDisconnectedErrorWithNative: jest.fn((options: any) => {
      const requestId = String(options?.requestId ?? '').trim();
      const flowId = String(options?.flowId ?? '').trim();
      return {
        message: flowId
          ? `[servertool] client disconnected during followup flow=${flowId}`
          : '[servertool] client disconnected during followup',
        details: {
          requestId,
          ...(flowId ? { flowId } : {})
        }
      };
    }),
    planServertoolExecutionDispatchErrorWithNative: jest.fn((input: any) => ({
      code: 'SERVERTOOL_HANDLER_FAILED',
      category: 'INTERNAL_ERROR',
      status: 500,
      message: `[native-dispatch-contract] ${String(input?.kind ?? 'unknown')}`,
      details: input ?? {}
    })),
    planServertoolTimeoutWatcherWithNative: jest.fn((timeoutMs?: number) => {
      const normalized = Math.max(0, Math.floor(Number.isFinite(timeoutMs) ? Number(timeoutMs) : 0));
      return {
        armed: normalized > 0,
        timeoutMs: normalized
      };
    }),
    planServertoolTimeoutErrorWithNative: jest.fn(() => ({
      code: 'SERVERTOOL_TIMEOUT',
      category: 'INTERNAL_ERROR',
      status: 504,
      message: '[servertool] timeout',
      details: {}
    })),
    planServertoolStateLoadFailedErrorWithNative: jest.fn((input: any) => ({
      code: 'SERVERTOOL_STATE_LOAD_FAILED',
      category: 'INTERNAL_ERROR',
      status: 500,
      message: `[servertool] sticky routing state load failed: ${String(input?.stickyKey ?? '')}: ${String(input?.error ?? '')}`,
      details: {
        stickyKey: String(input?.stickyKey ?? ''),
        requestId: String(input?.requestId ?? ''),
        entryEndpoint: String(input?.entryEndpoint ?? ''),
        providerProtocol: String(input?.providerProtocol ?? ''),
        error: String(input?.error ?? '')
      }
    })),
    planServertoolRequiredResponseHookEmptyErrorWithNative:
      planServertoolRequiredResponseHookEmptyErrorWithNativeMock,
    planStopMessageFetchFailedErrorWithNative: jest.fn(() => ({
      code: 'SERVERTOOL_HANDLER_FAILED',
      category: 'INTERNAL_ERROR',
      status: 502,
      message: 'fetch failed: network error',
      details: {}
    })),
    planPreCommandHooksConfigWithNative: jest.fn(() => ({
      enabled: false,
      hooks: []
    })),
    planRuntimePreCommandRuleWithNative: jest.fn(() => null),
    planRuntimePreCommandStateRuntimeActionWithNative: planRuntimePreCommandStateRuntimeActionWithNativeMock,
    planServertoolMaterializationProgressWithNative: jest.fn((input: any) => {
      if (input?.hasFinalizeFunction && input?.hasBackendPlan) {
        return { action: 'unsupported_backend_plan_kind' };
      }
      if (input?.hasFinalizeFunction) {
        return { action: 'finalize_without_backend' };
      }
      if (input?.hasChatResponseObject && input?.hasExecutionObject && input?.hasExecutionFlowId) {
        return { action: 'return_handler_result' };
      }
      if (input?.hasPlanMarkers) {
        return { action: 'invalid_plan_missing_finalize' };
      }
      return { action: 'invalid_plan_result' };
    }),
    planServertoolHandlerRuntimeActionWithNative: jest.fn((input: any) => {
      if (input?.hasFinalizeFunction && input?.hasBackendPlan) {
        const backendKind = String(input?.backendKind ?? '');
        return { action: 'unsupported_backend_plan_kind', backendKind };
      }
      if (input?.hasFinalizeFunction) {
        return { action: 'finalize_without_backend' };
      }
      if (input?.hasChatResponseObject && input?.hasExecutionObject && input?.hasExecutionFlowId) {
        return { action: 'return_handler_result' };
      }
      if (input?.hasPlanMarkers) {
        return { action: 'invalid_plan_missing_finalize' };
      }
      return { action: 'invalid_plan_result' };
    }),
    planServertoolHandlerContractErrorWithNative: jest.fn((input: any) => {
      const kind = String(input?.kind ?? 'unknown_handler_contract_error');
      const toolName = String(input?.toolName ?? 'auto');
      const requestId = String(input?.requestId ?? '');
      const entryEndpoint = String(input?.entryEndpoint ?? '');
      const providerProtocol = String(input?.providerProtocol ?? '');
      const backendKind = String(input?.backendKind ?? '');
      const error = String(input?.error ?? '');
      if (kind === 'handler_failed') {
        return {
          code: 'SERVERTOOL_HANDLER_FAILED',
          category: 'INTERNAL_ERROR',
          status: 502,
          message: `[servertool] ${toolName} failed: ${error}`,
          details: {
            requestId,
            entryEndpoint,
            providerProtocol,
            toolName,
            error
          }
        };
      }
      if (kind === 'unsupported_backend_plan_kind') {
        return {
          code: 'SERVERTOOL_HANDLER_CONTRACT_ERROR',
          category: 'INTERNAL_ERROR',
          status: 500,
          message: `[servertool] unsupported backend plan kind: ${backendKind}`,
          details: {
            requestId,
            backendKind
          }
        };
      }
      return {
        code: 'SERVERTOOL_HANDLER_CONTRACT_ERROR',
        category: 'INTERNAL_ERROR',
        status: 500,
        message: `[servertool] ${kind}`,
        details: {
          requestId,
          entryEndpoint,
          providerProtocol,
          toolName,
          backendKind,
          error
        }
      };
    }),
    planAutoHookRuntimeAttemptWithNative: jest.fn((input: any) => ({
      returnResult: !input?.message && input?.hasMaterializedResult === true,
      continueQueue: !input?.message && input?.hasMaterializedResult !== true,
      rethrowError: Boolean(input?.message),
      traceEvent: {
        hookId: String(input?.hookId ?? ''),
        phase: String(input?.phase ?? ''),
        priority: Number(input?.priority ?? 0),
        queue: String(input?.queue ?? ''),
        queueIndex: Number(input?.queueIndex ?? 0),
        queueTotal: Number(input?.queueTotal ?? 0),
        result: input?.message ? 'error' : input?.hasMaterializedResult === true ? 'match' : 'miss',
        reason: input?.message ? String(input?.message ?? 'unknown') : input?.hasPlannedResult === true ? 'matched' : 'predicate_false',
        ...(typeof input?.materializedFlowId === 'string' ? { flowId: input.materializedFlowId } : {})
      }
    })),
    planAutoHookCallerFinalizationWithNative: jest.fn((input: any) => {
      if (input?.resultPresent) {
        return { returnResult: true, continueNextQueue: false, returnNull: false };
      }
      if (input?.finalQueue) {
        return { returnResult: false, continueNextQueue: false, returnNull: true };
      }
      return { returnResult: false, continueNextQueue: true, returnNull: false };
    }),
    extractTextFromChatLikeWithNative: jest.fn(() => ''),
    buildClientExecCliProjectionOutputWithNative: jest.fn(() => ({})),
    buildClientVisibleProjectionShellWithNative: jest.fn((input: any) => input?.base ?? {}),
    buildServertoolCliProjectionExecutionContextWithNative: jest.fn((input: any) => ({
      flowId: 'servertool_cli_projection'
    })),
    planServertoolExecutionBranchWithNative: planServertoolExecutionBranchWithNativeMock,
    planServertoolResponseStageRuntimeActionWithNative: planServertoolResponseStageRuntimeActionWithNativeMock,
    planServertoolHookScheduleWithNative: jest.fn((input: any) => ({
      events: (input?.hooks ?? []).map((hook: any) => ({
        hookId: hook.id,
        status: 'scheduled',
        effectKind: hook.effectKind,
        requiredness: hook.requiredness,
        noOp: false
      })),
      projection: {
        direction: 'response',
        phase: 'ServertoolRespHook01Intercepted',
        inputNode: 'HubRespChatProcess03Governed',
        outputNode: 'ServertoolRespHook01Intercepted',
        hookIds: (input?.hooks ?? []).map((hook: any) => hook.id),
        effectKinds: (input?.hooks ?? []).map((hook: any) => hook.effectKind)
      }
    })),
    runServertoolOrchestrationMutationWithNative: jest.fn((input: any) => {
      const op = String(input?.op ?? '').trim();
      if (op === 'append_tool_output') {
        const base = JSON.parse(JSON.stringify(input?.base ?? {}));
        const outputs = Array.isArray((base as any).tool_outputs) ? (base as any).tool_outputs : [];
        outputs.push({
          tool_call_id: input?.toolCallId,
          name: input?.name,
          content: input?.content
        });
        (base as any).tool_outputs = outputs;
        return base;
      }
      if (op === 'build_assistant_tool_call_message') {
        return {
          role: 'assistant',
          tool_calls: Array.isArray(input?.toolCalls) ? input.toolCalls : []
        };
      }
      return input?.base ?? {};
    })
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js',
  () => ({
    bindServertoolContractWithNative: jest.fn(() => null),
    planServertoolResponseStageGateWithNative: planServertoolResponseStageGateWithNativeMock,
    runServertoolResponseStageWithNative: jest.fn((chatResponse: any) => {
      const toolCalls = Array.isArray(chatResponse?.choices?.[0]?.message?.tool_calls)
        ? chatResponse.choices[0].message.tool_calls.map((toolCall: any) => ({
            id: String(toolCall?.id ?? ''),
            name: String(toolCall?.function?.name ?? ''),
            arguments: String(toolCall?.function?.arguments ?? '{}')
          }))
        : [];
      return {
        normalizedPayload: chatResponse,
        toolCalls
      };
    }),
    buildServertoolDispatchPlanInputWithNative: jest.fn((input: any) => input),
    planServertoolToolCallDispatchWithNative: jest.fn((input: any) => ({
      executableToolCalls: (input?.toolCalls ?? []).map((toolCall: any) => ({
        id: toolCall.id,
        name: toolCall.name,
        arguments: toolCall.arguments,
        executionMode: 'guarded',
        stripAfterExecute: true
      })),
      skippedToolCalls: [],
      noopToolCalls: []
    })),
    buildServertoolHandlerErrorToolOutputPayloadWithNative: jest.fn((input: any) => ({
      choices: [
        {
          message: {
            tool_calls: [],
            tool_outputs: [
              {
                tool_call_id: String(input?.toolCallId ?? ''),
                output: String(input?.message ?? '')
              }
            ]
          }
        }
      ]
    })),
    buildServertoolOutcomePlanInputWithNative: jest.fn((input: any) => input),
    planServertoolOutcomeWithNative: jest.fn((input: any) => {
      const executed = Array.isArray(input?.executionState?.executedToolCalls)
        ? input.executionState.executedToolCalls[0]
        : null;
      const toolName = String(executed?.toolCall?.name ?? 'tool');
      return {
        outcomeMode: 'servertool_only',
        flowId: `${toolName}_error`,
        followupStrategy: 'generic_tool_outputs',
        useGenericFollowup: true,
        useLastExecutionFollowup: false,
        requiresPendingInjection: false,
        pendingInjectionMessagesResolved: [],
        pendingInjectionMessageKinds: [],
        remainingToolCallIds: [],
        aliasSessionIds: [],
        resolvedFollowup: {
          requestIdSuffix: ':servertool_followup',
          injection: {
            ops: [
              { op: 'append_assistant_message', required: true },
              { op: 'append_tool_messages_from_tool_outputs', required: true }
            ]
          }
        }
      };
    }),
    planServertoolHandlerContractErrorWithNative: jest.fn((input: any) => {
      const kind = String(input?.kind ?? '').trim();
      if (kind === 'handler_failed') {
        return {
          code: 'SERVERTOOL_HANDLER_FAILED',
          category: 'INTERNAL_ERROR',
          status: 500,
          message: `[servertool] handler failed: ${String(input?.toolName ?? '')}: ${String(input?.error ?? '')}`,
          details: {
            toolName: String(input?.toolName ?? ''),
            requestId: String(input?.requestId ?? ''),
            entryEndpoint: String(input?.entryEndpoint ?? ''),
            providerProtocol: String(input?.providerProtocol ?? ''),
            error: String(input?.error ?? '')
          }
        };
      }
      if (kind === 'unsupported_backend_plan_kind') {
        return {
          code: 'SERVERTOOL_HANDLER_FAILED',
          category: 'INTERNAL_ERROR',
          status: 500,
          message: `[servertool] unsupported backend plan kind: ${String(input?.backendKind ?? '')}`,
          details: {
            requestId: String(input?.requestId ?? ''),
            backendKind: String(input?.backendKind ?? '')
          }
        };
      }
      if (kind === 'invalid_handler_plan_missing_finalize') {
        return {
          code: 'SERVERTOOL_HANDLER_FAILED',
          category: 'INTERNAL_ERROR',
          status: 500,
          message: '[servertool] invalid handler plan contract: missing finalize',
          details: {
            requestId: String(input?.requestId ?? '')
          }
        };
      }
      return {
        code: 'SERVERTOOL_HANDLER_FAILED',
        category: 'INTERNAL_ERROR',
        status: 500,
        message: '[servertool] invalid handler plan/result contract',
        details: {
          requestId: String(input?.requestId ?? '')
        }
      };
    }),
    planServertoolNoopOutcomeWithNative: jest.fn((input: any) => ({
      flowId: `${String(input?.toolName ?? 'noop')}_noop`,
      followup: {
        requestIdSuffix: ':servertool_followup',
        injection: { ops: [] }
      },
      chatResponse: input?.base ?? {}
    })),
    planServertoolHandlerContractWithNative: jest.fn((input: any) => {
      if (input?.hasPlanMarkers || input?.hasFinalizeFunction) {
        return { action: 'handler_plan' };
      }
      if (input?.hasChatResponseObject && input?.hasExecutionObject && input?.hasExecutionFlowId) {
        return { action: 'handler_result' };
      }
      return { action: 'invalid_plan_missing_finalize' };
    }),
    planServertoolAutoHookQueuesWithNative: jest.fn((input: any) => ({
      optionalQueue: Array.isArray(input?.hooks) ? [...input.hooks] : [],
      mandatoryQueue: []
    })),
    runServertoolOrchestrationMutationWithNative: jest.fn((input: any) => {
      const op = String(input?.op ?? '').trim();
      if (op === 'append_tool_output') {
        const base = JSON.parse(JSON.stringify(input?.base ?? {}));
        const outputs = Array.isArray((base as any).tool_outputs) ? (base as any).tool_outputs : [];
        outputs.push({
          tool_call_id: input?.toolCallId,
          name: input?.name,
          content: input?.content
        });
        (base as any).tool_outputs = outputs;
        return base;
      }
      if (op === 'build_assistant_tool_call_message') {
        return {
          role: 'assistant',
          tool_calls: Array.isArray(input?.toolCalls) ? input.toolCalls : []
        };
      }
      return input?.base ?? {};
    }),
    getDefaultServertoolSkeletonDocumentWithNative: jest.fn(() => ({
      servertool: {
        skeleton: {
          autoHooks: {
            optionalPrimaryOrder: ['vision_auto', 'stop_message_auto'],
            mandatoryOrder: []
          },
          pendingInjection: { messageKinds: ['assistant_tool_calls', 'tool_outputs'] },
          followup: {
            genericInjectionOps: ['append_assistant_message', 'append_tool_messages_from_tool_outputs'],
            nativeSupportedOps: [],
            flowPolicy: { profilesByFlowId: {} }
          }
        },
        state: {
          scopePriority: [],
          pendingInjection: { enabled: true, strictContract: true }
        },
        internalTools: {}
      }
    })),
    planServertoolSkeletonDerivedConfigWithNative: jest.fn(() => ({
      document: {
        servertool: {
          skeleton: {
            autoHooks: {
              optionalPrimaryOrder: ['vision_auto', 'stop_message_auto'],
              mandatoryOrder: []
            }
          }
        }
      },
      toolSpecs: {},
      toolSpecList: [],
      autoHookQueueConfig: {
        optionalPrimaryOrder: ['vision_auto', 'stop_message_auto'],
        mandatoryOrder: []
      },
      pendingInjectionConfig: {
        messageKinds: ['assistant_tool_calls', 'tool_outputs']
      },
      followupConfig: {
        genericInjectionOps: ['append_assistant_message', 'append_tool_messages_from_tool_outputs'],
        nativeSupportedOps: [],
        flowPolicy: {
          profilesByFlowId: {},
          noFollowupFlowIds: [],
          autoLimitFlowIds: [],
          flowOnlyLoopLimitFlowIds: [],
          clientInjectOnlyFlowIds: [],
          seedLoopPayloadFlowIds: [],
          clientInjectSourceByFlowId: {},
          transparentReplayRequestSuffixByFlowId: {},
          ignoreRequiresActionFollowupFlowIds: []
        }
      },
      stateConfig: {
        scopePriority: [],
        pendingInjection: { enabled: true, strictContract: true }
      }
    })),
    extractCapturedChatSeedWithNative: jest.fn(() => null),
    normalizeFollowupParametersWithNative: jest.fn((value: any) => value ?? undefined),
    resolveFollowupModelWithNative: jest.fn((seedModel: any) => String(seedModel ?? 'gpt-test')),
    buildServertoolToolOutputPayloadWithNative: jest.fn((payload: any) => payload),
    collectServertoolAdditionalClientToolCallsWithNative: jest.fn((input: any) => {
      const choices = Array.isArray(input?.base?.choices) ? input.base.choices : [];
      const first = choices[0] ?? {};
      const message = first?.message ?? {};
      const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
      return toolCalls.filter((toolCall: any) => {
        const id = typeof toolCall?.id === 'string' ? toolCall.id : '';
        const name = typeof toolCall?.function?.name === 'string' ? toolCall.function.name.trim() : '';
        return Boolean(id) && id !== input?.projectedToolCallId && name !== 'stop_message_auto';
      });
    }),
    isServertoolClientExecCliProjectionToolCallWithNative: jest.fn((input: any) => {
      const executionMode = typeof input?.executionMode === 'string' ? input.executionMode.trim() : '';
      return executionMode === 'client_exec_cli_projection';
    }),
    webSearchIsGeminiEngineWithNative: jest.fn(() => false),
    webSearchIsGlmEngineWithNative: jest.fn(() => false),
    webSearchExtractAssistantMessageWithNative: jest.fn(() => 'null'),
    webSearchBuildToolMessagesWithNative: jest.fn(() => '[]'),
    webSearchCollectHitsWithNative: jest.fn(() => '[]'),
    webSearchLimitHitsWithNative: jest.fn(() => '[]'),
    webSearchFormatHitsSummaryWithNative: jest.fn(() => ''),
    webSearchNormalizeResultCountWithNative: jest.fn(() => 5),
    webSearchSanitizeBackendErrorWithNative: jest.fn((message: string) => message),
    webSearchBuildSystemPromptWithNative: jest.fn(() => ''),
    visionBuildAnalysisPayloadWithNative: jest.fn(() => 'null'),
    visionBuildPinnedMetadataWithNative: jest.fn(() => 'null'),
    visionExtractOriginalUserPromptWithNative: jest.fn(() => ''),
    resolveServertoolToolSpecWithNative: jest.fn(() => null),
    planServertoolBuiltinHandlerEntryWithNative: jest.fn((input: any) => {
      const name = String(input?.name ?? '').trim().toLowerCase();
      return name === 'stop_message_auto'
        ? {
            action: 'return_entry',
            entry: {
              name,
              trigger: 'auto',
              execution: {
                kind: 'builtin',
                builtinName: name
              },
              autoHook: {
                flowId: 'stop_message_flow',
                trigger: { type: 'auto', phase: 'default', priority: 40 },
                execution: { mode: 'auto_hook', stripAfterExecute: true }
              },
              registration: {
                name,
                enabled: true,
                trigger: 'auto',
                executionMode: 'auto_hook',
                stripAfterExecute: true
              }
            }
          }
        : { action: 'return_none' };
    }),
    planServertoolBuiltinHandlerNamesWithNative: jest.fn(() => ({ names: ['stop_message_auto'] })),
    resolveServertoolBuiltinHandlerEntryWithNative: jest.fn((input: any) => {
      const name = String(input?.name ?? '').trim().toLowerCase();
      return name === 'stop_message_auto'
        ? {
            name,
            trigger: 'auto',
            execution: {
              kind: 'builtin',
              builtinName: name
            },
            autoHook: {
              flowId: 'stop_message_flow',
              trigger: { type: 'auto', phase: 'default', priority: 40 },
              execution: { mode: 'auto_hook', stripAfterExecute: true }
            },
            registration: {
              name,
              enabled: true,
              trigger: 'auto',
              executionMode: 'auto_hook',
              stripAfterExecute: true
            }
          }
        : null;
    }),
    planServertoolBuiltinAutoHandlerEntriesWithNative: jest.fn(() => ({
      entries: [{
        name: 'stop_message_auto',
        trigger: 'auto',
        execution: {
          kind: 'builtin',
          builtinName: 'stop_message_auto'
        },
        autoHook: {
          flowId: 'stop_message_flow',
          trigger: { type: 'auto', phase: 'default', priority: 40 },
          execution: { mode: 'auto_hook', stripAfterExecute: true }
        },
        registration: {
          name: 'stop_message_auto',
          enabled: true,
          trigger: 'auto',
          executionMode: 'auto_hook',
          stripAfterExecute: true
        }
      }]
    })),
    planServertoolBuiltinHandlerRecordEntriesWithNative: jest.fn(() => ({
      entries: [{
        name: 'stop_message_auto',
        trigger: 'auto',
        execution: {
          kind: 'builtin',
          builtinName: 'stop_message_auto'
        },
        autoHook: {
          flowId: 'stop_message_flow',
          trigger: { type: 'auto', phase: 'default', priority: 40 },
          execution: { mode: 'auto_hook', stripAfterExecute: true }
        },
        registration: {
          name: 'stop_message_auto',
          enabled: true,
          trigger: 'auto',
          executionMode: 'auto_hook',
          stripAfterExecute: true
        }
      }]
    })),
    planServertoolRegistryRegistrationFromSkeletonWithNative: jest.fn((input: any) => {
      const name = String(input?.name ?? '').trim().toLowerCase();
      return name && input?.hasHandler === true
        ? { action: 'ignore_disabled', canonicalName: name }
        : { action: 'ignore_invalid' };
    }),
    planServertoolRegistryLookupFromSkeletonWithNative: jest.fn((input: any) => {
      const name = String(input?.name ?? '').trim().toLowerCase();
      return { action: 'return_none', canonicalName: name };
    }),
    resolveServertoolRegisteredNameWithNative: jest.fn(() => false),
    normalizeServertoolRegistrationSpecWithNative: jest.fn((input: any) => {
      const name = String(input?.name ?? '').trim().toLowerCase();
      if (!name) {
        return null;
      }
      const trigger = input?.options?.trigger === 'auto' ? 'auto' : 'tool_call';
      return {
        name,
        enabled: true,
        trigger,
        executionMode: trigger === 'auto' ? 'auto_hook' : 'guarded',
        stripAfterExecute: true,
        ...(trigger === 'auto'
          ? {
              autoHook: {
                id: name,
                phase: 'default',
                priority: 100
              }
            }
          : {})
      };
    })
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/pre-command-hooks.js',
  () => ({
    applyPreCommandHooksToToolCalls: applyPreCommandHooksToToolCallsMock,
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-queue-shell.js',
  () => ({
    buildServertoolDispatchPlanInput: jest.fn((input: any) => input),
    runServertoolIoExecutionQueue: jest.fn(async (args: any) => {
      const state = {
        executedToolCalls: [],
        executedIds: new Set<string>(),
        executedFlowIds: [],
        lastExecution: undefined as any
      };
      for (const toolCall of args.dispatchPlan?.executableToolCalls ?? []) {
        try {
          failfastInvocationCount += 1;
          throw new Error('boom-from-test-handler');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error ?? 'unknown');
          (args.baseForExecution as Record<string, unknown>).tool_outputs = [
            {
              tool_call_id: toolCall.id,
              name: toolCall.name,
              content: JSON.stringify({
                ok: false,
                tool: toolCall.name,
                message,
                retryable: true
              })
            }
          ];
          const execution = { flowId: `${toolCall.name}_error` };
          state.executedToolCalls.push({ toolCall, execution });
          state.executedIds.add(toolCall.id);
          state.executedFlowIds.push(execution.flowId);
          state.lastExecution = execution;
        }
      }
      return state;
    }),
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.js',
  () => ({
    buildServertoolOutcomePlanInput: jest.fn((input: any) => input),
    materializeServertoolPlannedResult: jest.fn(async (planned: any) => planned),
    materializeNativeToolCallExecutionOutcome: jest.fn((args: any) => ({
      mode: 'tool_flow',
      finalChatResponse: args.baseForExecution,
      execution: {
        flowId:
          args.executionState?.lastExecution?.flowId ??
          args.executionState?.executedToolCalls?.[0]?.execution?.flowId ??
          'servertool_unknown',
        followup: {
          requestIdSuffix: ':servertool_followup',
          injection: {
            ops: [
              { op: 'append_assistant_message', required: true },
              { op: 'append_tool_messages_from_tool_outputs', required: true }
            ]
          }
        }
      }
    })),
    executeBuiltinServerToolHandler: jest.fn(async () => null),
    createServertoolExecutionLoopStateFromNative: jest.fn(() => ({
      executedToolCalls: [],
      executedIds: new Set<string>(),
      executedFlowIds: []
    })),
    appendExecutedToolRecordFromNative: jest.fn((state: any, toolCall: any, execution?: any) => {
      state.executedToolCalls.push({ toolCall, ...(execution ? { execution } : {}) });
      state.executedIds.add(toolCall.id);
      if (execution?.flowId) {
        state.executedFlowIds.push(execution.flowId);
        state.lastExecution = execution;
      }
    })
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js',
  () => ({
    loadRoutingInstructionStateSync: loadRoutingInstructionStateSyncMock
  })
);

jest.unstable_mockModule(
  '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-shared-conversion-semantics.js',
  () => ({
    buildProviderProtocolErrorWithNative: jest.fn((input: any) => ({
      protocol: input?.protocol,
      providerType: input?.providerType,
      category: input?.category ?? 'INTERNAL_ERROR',
      details: input?.details
    }))
  })
);

let runServerSideToolEngine: any;
const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');

function bindTestMetadataCenter<T extends Record<string, unknown>>(
  adapterContext: T,
  providerProtocol = 'openai-responses'
): T {
  const explicitRuntimeControl =
    adapterContext.runtimeControl && typeof adapterContext.runtimeControl === 'object' && !Array.isArray(adapterContext.runtimeControl)
      ? adapterContext.runtimeControl as Record<string, unknown>
      : {};
  Reflect.set(adapterContext, METADATA_CENTER_SYMBOL, {
    readRuntimeControl: () => ({ providerProtocol, ...explicitRuntimeControl }),
    readRequestTruth: () => ({
      requestId: typeof adapterContext.requestId === 'string' ? adapterContext.requestId : undefined
    })
  });
  return adapterContext;
}

beforeAll(async () => {
  const serverSideTools = await import('../../sharedmodule/llmswitch-core/src/servertool/server-side-tools-impl.js');
  runServerSideToolEngine = serverSideTools.runServerSideToolEngine;
});

function makeToolCallResponse(): JsonObject {
  return {
    id: 'chatcmpl-servertool-failfast',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_failfast_1',
              type: 'function',
              function: {
                name: TOOL_NAME,
                arguments: '{}'
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ]
  } as JsonObject;
}

function makeUnknownToolCallResponse(): JsonObject {
  return {
    id: 'chatcmpl-servertool-gate',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_unknown_1',
              type: 'function',
              function: {
                name: 'unregistered_tool_for_gate',
                arguments: '{}'
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ]
  } as JsonObject;
}

describe('server-side-tools tool-error closed loop', () => {
  beforeEach(() => {
    failfastInvocationCount = 0;
    loadRoutingInstructionStateSyncMock.mockReset();
    applyPreCommandHooksToToolCallsMock.mockReset();
    planServertoolResponseStageGateWithNativeMock.mockReset();
    planServertoolResponseStageGateWithNativeMock.mockReturnValue({
      shouldBypass: false,
      nextAction: 'run_auto_hooks'
    });
    planServertoolResponseStageRuntimeActionWithNativeMock.mockReset();
    planServertoolRequiredResponseHookEmptyErrorWithNativeMock.mockReset();
    planServertoolRequiredResponseHookEmptyErrorWithNativeMock.mockImplementation((input: any) => ({
      code: 'SERVERTOOL_REQUIRED_RESPONSE_HOOK_EMPTY',
      category: 'INTERNAL_ERROR',
      status: 500,
      message: `[servertool] required response hook produced no result: ${String(input?.responseHookName ?? '')}`,
      details: {
        requestId: String(input?.requestId ?? ''),
        responseHookName: String(input?.responseHookName ?? '')
      }
    }));
    planServertoolResponseStageRuntimeActionWithNativeMock.mockImplementation((input: any) => {
      const nextAction = String(input?.responseStageGatePlan?.nextAction ?? input?.responseStageNextAction ?? '').trim();
      if (nextAction === 'bypass') {
        return { action: 'return_passthrough_bypass' };
      }
      if (input?.autoHookEvaluated !== true) {
        return { action: 'run_auto_hooks' };
      }
      if (input?.hasAutoHookResult === true) {
        return { action: 'return_auto_hook_result' };
      }
      if (input?.responseHookRequired === true) {
        return { action: 'return_required_response_hook_empty' };
      }
      return { action: 'return_passthrough_no_auto_hook_result' };
    });
    planServertoolExecutionBranchWithNativeMock.mockClear();
    planServertoolEntryPreflightWithNativeMock.mockClear();
    planRuntimePreCommandStateRuntimeActionWithNativeMock.mockClear();
  });

  test('fails fast through native client-disconnect policy before servertool execution', async () => {
    const adapterContext: AdapterContext = bindTestMetadataCenter({
      requestId: 'req-servertool-disconnected-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      clientDisconnected: ' true '
    } as any);

    await expect(
      runServerSideToolEngine({
        chatResponse: makeToolCallResponse(),
        adapterContext,
        entryEndpoint: '/v1/responses',
        requestId: 'req-servertool-disconnected-1',
        providerProtocol: 'openai-responses'
      })
    ).rejects.toMatchObject({
      code: 'SERVERTOOL_CLIENT_DISCONNECTED',
      details: { requestId: 'req-servertool-disconnected-1' }
    });
    expect(planServertoolEntryPreflightWithNativeMock).toHaveBeenCalledWith({
      hasBaseObject: true,
      adapterClientDisconnected: true
    });
  });

  test('returns passthrough through native entry preflight when chat response is not an object', async () => {
    const adapterContext: AdapterContext = bindTestMetadataCenter({
      requestId: 'req-servertool-non-object-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    } as any);

    const result = await runServerSideToolEngine({
      chatResponse: 'not-an-object' as any,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-servertool-non-object-1',
      providerProtocol: 'openai-responses'
    });

    expect(result).toEqual({
      mode: 'passthrough',
      finalChatResponse: 'not-an-object'
    });
    expect(planServertoolEntryPreflightWithNativeMock).toHaveBeenCalledWith({
      hasBaseObject: false,
      adapterClientDisconnected: false
    });
  });

  test('returns retryable tool error output on servertool handler failure instead of aborting the whole request', async () => {
    const adapterContext: AdapterContext = bindTestMetadataCenter({
      requestId: 'req-servertool-failfast-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    } as any);

    const result = await runServerSideToolEngine({
      chatResponse: makeToolCallResponse(),
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-servertool-failfast-1',
      providerProtocol: 'openai-responses'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.followup).toBeTruthy();
    expect(result.execution?.flowId).toBe(`${TOOL_NAME}_error`);
    const outputs = Array.isArray((result.finalChatResponse as any).tool_outputs)
      ? ((result.finalChatResponse as any).tool_outputs as any[])
      : [];
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({
      tool_call_id: 'call_failfast_1',
      name: TOOL_NAME
    });
    const parsed = JSON.parse(String(outputs[0].content));
    expect(parsed).toMatchObject({
      ok: false,
      tool: TOOL_NAME,
      retryable: true
    });
    expect(String(parsed.message || '')).toContain('boom-from-test-handler');
    expect(failfastInvocationCount).toBe(1);
    expect(planServertoolExecutionBranchWithNativeMock).toHaveBeenNthCalledWith(1, {
      executableToolCalls: [
        {
          id: 'call_failfast_1',
          name: TOOL_NAME,
          executionMode: 'guarded'
        }
      ],
      executedToolCallsLen: 0
    });
    expect(planServertoolExecutionBranchWithNativeMock).toHaveBeenNthCalledWith(2, {
      executableToolCalls: [
        {
          id: 'call_failfast_1',
          name: TOOL_NAME,
          executionMode: 'guarded'
        }
      ],
      executedToolCallsLen: 1
    });
  });

  test('uses metadata center runtime_control preCommandState without loading persisted routing state', async () => {
    const adapterContext: AdapterContext = bindTestMetadataCenter({
      requestId: 'req-servertool-precommand-direct-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      runtimeControl: {
        preCommandState: {
          preCommandScriptPath: '/tmp/control-pre-command.sh'
        }
      }
    } as any);

    await runServerSideToolEngine({
      chatResponse: makeToolCallResponse(),
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-servertool-precommand-direct-1',
      providerProtocol: 'openai-responses'
    });

    expect(loadRoutingInstructionStateSyncMock).not.toHaveBeenCalled();
    expect(planRuntimePreCommandStateRuntimeActionWithNativeMock).toHaveBeenCalledWith({
      runtimeControlPreCommandState: {
        preCommandScriptPath: '/tmp/control-pre-command.sh'
      }
    });
    expect(applyPreCommandHooksToToolCallsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePreCommandState: {
          preCommandScriptPath: '/tmp/control-pre-command.sh'
        }
      })
    );
  });

  test('does not load persisted routing state when native pre-command selection sees no scope key', async () => {
    const adapterContext: AdapterContext = bindTestMetadataCenter({
      requestId: 'req-servertool-precommand-no-scope-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    } as any);

    await runServerSideToolEngine({
      chatResponse: makeToolCallResponse(),
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-servertool-precommand-no-scope-1',
      providerProtocol: 'openai-responses'
    });

    expect(loadRoutingInstructionStateSyncMock).not.toHaveBeenCalled();
    expect(planRuntimePreCommandStateRuntimeActionWithNativeMock).toHaveBeenCalledWith({
      runtimeControlPreCommandState: undefined
    });
    expect(applyPreCommandHooksToToolCallsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimePreCommandState: undefined
      })
    );
  });

  test('does not pass legacy servertool support capability details into the native response-stage gate', async () => {
    const adapterContext: AdapterContext = bindTestMetadataCenter({
      requestId: 'req-servertool-response-stage-capabilities-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses'
    } as any);

    await runServerSideToolEngine({
      chatResponse: makeUnknownToolCallResponse(),
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-servertool-response-stage-capabilities-1',
      providerProtocol: 'openai-responses'
    });

    const gateInput = planServertoolResponseStageGateWithNativeMock.mock.calls[0]?.[0];
    expect(gateInput).toEqual(
      expect.objectContaining({
        payload: expect.any(Object),
        adapterContext
      })
    );
    expect(Object.prototype.hasOwnProperty.call(gateInput, 'hasServertoolSupport')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(gateInput, 'capabilities')).toBe(false);
    for (const [runtimeInput] of planServertoolResponseStageRuntimeActionWithNativeMock.mock.calls) {
      expect(Object.prototype.hasOwnProperty.call(runtimeInput, 'hasServertoolSupport')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(runtimeInput, 'capabilities')).toBe(false);
    }
  });

  test('projects required response hook empty through native orchestration-policy error plan', async () => {
    planServertoolResponseStageGateWithNativeMock.mockReturnValue({
      shouldBypass: false,
      nextAction: 'run_auto_hooks',
      responseHookMatched: true,
      responseHookRequired: true,
      responseHookName: 'stop_message_auto'
    });
    const plan = planServertoolResponseStageRuntimeActionWithNativeMock({
      responseStageGatePlan: {
        shouldBypass: false,
        nextAction: 'run_auto_hooks',
        responseHookMatched: true,
        responseHookRequired: true,
        responseHookName: 'stop_message_auto'
      },
      autoHookEvaluated: true,
      hasAutoHookResult: false,
      responseHookRequired: true
    });
    expect(plan).toEqual({
      action: 'return_required_response_hook_empty'
    });
    const errorPlan = planServertoolRequiredResponseHookEmptyErrorWithNativeMock({
      requestId: 'req-servertool-required-response-hook-empty-1',
      responseHookName: 'stop_message_auto'
    });
    expect(errorPlan).toEqual(
      expect.objectContaining({
        code: 'SERVERTOOL_REQUIRED_RESPONSE_HOOK_EMPTY',
        details: {
          requestId: 'req-servertool-required-response-hook-empty-1',
          responseHookName: 'stop_message_auto'
        }
      })
    );
  });

});
