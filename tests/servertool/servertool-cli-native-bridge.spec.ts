import {
  buildClientExecCliProjectionOutputWithNative,
  buildServertoolCliProjectionExecutionContextWithNative,
  buildClientVisibleProjectionShellWithNative,
  buildServertoolCliProjectionRuntimeBranchWithNative,
  parseServertoolCliProjectionToolArgumentsWithNative,
  planServertoolEnginePreflightWithNative,
  planServertoolEngineOrchestrationPreflightActionWithNative,
  planServertoolEngineSkipWithNative,
  planServertoolEnginePrepassActionWithNative,
  planServertoolEngineRuntimeActionWithNative,
  planServertoolEngineTriggerObservationWithNative,
  planEngineSelectionAfterRunWithNative,
  planAutoHookCallerFinalizationWithNative,
  planAutoHookCallerResultProjectionWithNative,
  planAutoHookRuntimeAttemptWithNative,
  planStoplessCliProjectionContextWithNative,
  planServertoolExecutionBranchWithNative,
  planServertoolExecutionLoopEffectWithNative,
  planServertoolExecutionLoopRuntimeActionWithNative,
  planServertoolExecutionOutcomeMaterializationWithNative,
  planServertoolExecutionOutcomeRuntimeActionWithNative,
  planServertoolEntryPreflightWithNative,
  resolveServertoolEntryPreflightApplicationWithNative,
  resolveServertoolRunEngineEntryPreflightApplicationWithNative,
  resolveServertoolRunEnginePrepassApplicationWithNative,
  planServertoolResponseStageRuntimeActionWithNative,
  resolveServertoolResponseStagePrepassInitialApplicationWithNative,
  planServertoolRegistryAutoHookDescriptorsWithNative,
  planServertoolRegistryLookupActionWithNative,
  planServertoolRegistryProjectionWithNative
} from '../../sharedmodule/llmswitch-core/dist/native/servertool-wrapper.js';
import { loadNativeRouterHotpathBindingForInternalUse } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath.js';

describe('servertool CLI native bridge', () => {
  it('uses Rust-owned projection output and client-visible shell', () => {
    const nativeProjection = buildClientExecCliProjectionOutputWithNative({
      flowId: 'stop_message_flow',
      input: {
        continuationPrompt: '继续做下一步',
        repeatCount: 1,
        maxRepeats: 3
      }
    });

    expect(nativeProjection).toMatchObject({
      toolName: 'stop_message_auto',
      flowId: 'stop_message_flow',
      repeatCount: 1,
      maxRepeats: 3
    });
    expect(nativeProjection.execCommand).toContain('routecodex hook run reasoningStop');
    expect(nativeProjection.execCommand).not.toContain('stop_message_auto');
    expect(nativeProjection.execCommand).not.toContain('continuationPrompt');
    expect(nativeProjection.execCommand).not.toContain('继续执行原任务');
    expect(nativeProjection.execCommand).not.toContain('stdoutPreview');
    expect(nativeProjection.execCommand).not.toContain('schemaGuidance');
    expect(nativeProjection.execCommand).not.toContain(['--', 'ticket'].join(''));
    expect(nativeProjection.execCommand).not.toContain('old_cli_');

    const shell = buildClientVisibleProjectionShellWithNative({
      requestId: 'req_native_bridge',
      clientCallId: 'call_native_bridge',
      nativeProjection,
      reasoningText: '模型 stop 后需要继续执行',
      additionalToolCalls: []
    } as any);

    const toolCall = (shell as any).choices?.[0]?.message?.tool_calls?.[0];
    expect((shell as any).choices?.[0]?.finish_reason).toBe('tool_calls');
    expect(toolCall?.function?.name).toBe('exec_command');
    expect(JSON.parse(toolCall.function.arguments).cmd).toBe(nativeProjection.execCommand);
    expect((shell as any).__servertool_cli_projection).toBeUndefined();
    expect(JSON.stringify(shell)).not.toContain('"metadata"');
    expect(JSON.stringify(shell)).not.toContain('"__rt"');
  });

  it('keeps the raw NAPI projection shell contract as JSON string', () => {
    const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
    const buildProjection = binding?.buildClientExecCliProjectionOutputJson;
    const buildShell = binding?.buildClientVisibleProjectionShellJson;
    expect(typeof buildProjection).toBe('function');
    expect(typeof buildShell).toBe('function');

    const rawProjection = (buildProjection as (input: string) => unknown)(JSON.stringify({
      flowId: 'stop_message_flow',
      input: {
        continuationPrompt: '继续做下一步',
        repeatCount: 1,
        maxRepeats: 3
      }
    }));
    expect(typeof rawProjection).toBe('string');

    const rawShell = (buildShell as (input: string) => unknown)(JSON.stringify({
      requestId: 'req_native_raw_shell',
      clientCallId: 'call_native_raw_shell',
      nativeProjection: JSON.parse(rawProjection as string),
      reasoningText: '模型 stop 后需要继续执行',
      additionalToolCalls: []
    }));

    expect(typeof rawShell).toBe('string');
    expect(JSON.parse(rawShell as string).choices?.[0]?.finish_reason).toBe('tool_calls');
  });

  it('uses Rust-owned CLI projection execution context', () => {
    const execution = buildServertoolCliProjectionExecutionContextWithNative({
      requestId: 'req_native_exec_context',
      clientCallId: 'call_native_exec_context',
      toolName: 'servertool_fixture'
    });

    expect(execution).toEqual({
      flowId: 'servertool_cli_projection'
    });
  });

  it('uses Rust-owned CLI projection runtime branch result mode', () => {
    const branch = buildServertoolCliProjectionRuntimeBranchWithNative({
      requestId: 'req_native_runtime_branch',
      toolName: 'web_search',
      toolArguments: '{"query":"rust"}',
      projectedToolCallId: 'call_web_search_1',
      base: {
        choices: [{
          message: {
            tool_calls: [{
              id: 'call_web_search_1',
              type: 'function',
              function: {
                name: 'web_search',
                arguments: '{"query":"rust"}'
              }
            }]
          }
        }]
      }
    });

    expect(branch.resultMode).toBe('tool_flow');
    expect(branch.execution).toEqual({
      flowId: 'servertool_cli_projection'
    });
    expect(branch.result).toEqual({
      mode: 'tool_flow',
      finalChatResponse: branch.chatResponse,
      execution: { flowId: 'servertool_cli_projection' }
    });
    expect((branch.chatResponse as any).choices?.[0]?.finish_reason).toBe('tool_calls');
  });

  it('uses Rust-owned execution-branch planning for CLI projection and post-execution outcome', () => {
    expect(
      planServertoolExecutionBranchWithNative({
        executableToolCalls: [
          {
            id: 'call_cli_projection_1',
            name: 'servertool_fixture',
            arguments: '{"ok":true}',
            executionMode: 'client_exec_cli_projection'
          }
        ],
        executedToolCallsLen: 0
      })
    ).toEqual({
      action: 'client_exec_cli_projection',
      projectedToolCall: {
        id: 'call_cli_projection_1',
        name: 'servertool_fixture',
        arguments: '{"ok":true}'
      },
      projectedToolCallId: 'call_cli_projection_1',
      projectedToolCallIndex: 0
    });

    expect(
      planServertoolExecutionBranchWithNative({
        executableToolCalls: [],
        executedToolCallsLen: 2
      })
    ).toEqual({
      action: 'resolve_execution_outcome'
    });

    expect(
      planServertoolExecutionBranchWithNative({
        executableToolCalls: [
          {
            id: 'call_backend_1',
            name: 'web_search',
            executionMode: 'backend'
          }
        ],
        executedToolCallsLen: 0
      })
    ).toEqual({
      action: 'continue_response_stage'
    });
  });

  it('uses Rust-owned execution-branch application planning through the raw NAPI bridge', () => {
    const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
    const planApplication = binding?.planServertoolExecutionBranchApplicationJson;
    expect(typeof planApplication).toBe('function');

    const rawCliApplication = (planApplication as (input: string) => unknown)(JSON.stringify({
      phase: 'pre_execution',
      branchPlan: {
        action: 'client_exec_cli_projection',
        projectedToolCall: {
          id: 'call_cli_projection_1',
          name: 'servertool_fixture',
          arguments: '{"ok":true}'
        }
      }
    }));
    expect(typeof rawCliApplication).toBe('string');
    expect(JSON.parse(rawCliApplication as string)).toEqual({
      projectClientExecCli: true,
      resolveExecutionOutcome: false,
      continueResponseStage: false,
      projectedToolCall: {
        id: 'call_cli_projection_1',
        name: 'servertool_fixture',
        arguments: '{"ok":true}'
      }
    });

    const rawOutcomeApplication = (planApplication as (input: string) => unknown)(JSON.stringify({
      phase: 'post_execution',
      branchPlan: {
        action: 'resolve_execution_outcome'
      }
    }));
    expect(typeof rawOutcomeApplication).toBe('string');
    expect(JSON.parse(rawOutcomeApplication as string)).toEqual({
      projectClientExecCli: false,
      resolveExecutionOutcome: true,
      continueResponseStage: false
    });
  });

  it('uses Rust-owned response-stage auto-hook application planning through the raw NAPI bridge', () => {
    const binding = loadNativeRouterHotpathBindingForInternalUse() as Record<string, unknown> | null;
    const planPreApplication = binding?.planServertoolResponseStageAutoHookPreApplicationJson;
    const planPostApplication = binding?.planServertoolResponseStageAutoHookPostApplicationJson;
    expect(typeof planPreApplication).toBe('function');
    expect(typeof planPostApplication).toBe('function');

    const rawPreApplication = (planPreApplication as (input: string) => unknown)(JSON.stringify({
      decision: {
        action: 'return_pass_result',
        result: { action: 'return_passthrough_bypass' }
      }
    }));
    expect(typeof rawPreApplication).toBe('string');
    expect(JSON.parse(rawPreApplication as string)).toEqual({
      returnPassResult: true,
      runAutoHooks: false,
      result: { action: 'return_passthrough_bypass' }
    });

    const rawPostApplication = (planPostApplication as (input: string) => unknown)(JSON.stringify({
      decision: {
        action: 'throw_required_response_hook_empty',
        errorPlan: { message: 'required hook empty' }
      }
    }));
    expect(typeof rawPostApplication).toBe('string');
    expect(JSON.parse(rawPostApplication as string)).toEqual({
      throwRequiredResponseHookEmpty: true,
      returnPassResult: false,
      errorPlan: { message: 'required hook empty' }
    });
  });

  it('uses Rust-owned engine runtime-action planning for orchestration shell exits', () => {
    expect(
      planServertoolEngineRuntimeActionWithNative({
        isStopMessageFlow: true,
        stoplessExecutionFlowId: 'servertool_cli_projection',
        stoplessAction: 'terminal_final',
        engineExecutionFlowId: ' terminal-flow ',
        currentFlowId: 'current-flow'
      })
    ).toEqual({
      action: 'return_stop_message_terminal_final',
      executed: true,
      flowIdSource: 'engine_execution',
      progressStatus: 'completed (stop_message terminal)',
      finalPayloadSource: 'engine_result',
      projectedFlowId: 'terminal-flow'
    });

    expect(
      planServertoolEngineRuntimeActionWithNative({
        isStopMessageFlow: false,
        stoplessExecutionFlowId: ' servertool_cli_projection ',
        stoplessAction: 'cli_projection',
        engineExecutionFlowId: 'servertool-cli-flow',
        currentFlowId: 'current-flow'
      })
    ).toEqual({
      action: 'return_servertool_cli_projection_final',
      executed: true,
      flowIdSource: 'engine_execution',
      progressStatus: 'completed (servertool cli projection; no reenter)',
      finalPayloadSource: 'engine_result',
      projectedFlowId: 'servertool-cli-flow'
    });

    expect(
      planServertoolEngineRuntimeActionWithNative({
        isStopMessageFlow: true,
        stoplessExecutionFlowId: 'stop_message_flow',
        stoplessAction: 'cli_projection',
        engineExecutionFlowId: 'engine-flow',
        currentFlowId: ' current-flow '
      })
    ).toEqual({
      action: 'build_stop_message_cli_projection',
      executed: true,
      flowIdSource: 'current_flow',
      progressStatus: 'completed (stop_message cli projection; no reenter)',
      finalPayloadSource: 'stop_message_cli_projection',
      projectedFlowId: 'current-flow'
    });
  });

  it('uses Rust-owned engine trigger observation planning', () => {
    expect(
      planServertoolEngineTriggerObservationWithNative({
        stopSignalObserved: false,
        result: 'non_stop_flow',
        flowId: 'flow_1'
      })
    ).toEqual({
      shouldLog: false
    });

    expect(
      planServertoolEngineTriggerObservationWithNative({
        stopSignalObserved: true,
        result: ' skipped_passthrough ',
        flowId: ' flow_1 '
      })
    ).toEqual({
      shouldLog: true,
      logStopEntry: {
        stage: 'trigger',
        result: 'skipped_passthrough'
      },
      logStopCompare: {
        stage: 'trigger',
        flowId: 'flow_1'
      }
    });
  });

  it('uses Rust-owned engine preflight planning for synthetic/direct early return', () => {
    expect(
      planServertoolEnginePreflightWithNative({
        hasSyntheticControlText: true,
        stopSignalObserved: true,
        stoplessDisabledOnDirectRoute: true,
        chat: { id: 'chat-synthetic' },
        stopSignal: { observed: true }
      })
    ).toEqual({
      action: 'return_original_chat',
      attachStopGatewayContext: false,
      result: {
        kind: 'return_original_chat',
        chat: { id: 'chat-synthetic' }
      }
    });

    expect(
      planServertoolEnginePreflightWithNative({
        hasSyntheticControlText: false,
        stopSignalObserved: true,
        stoplessDisabledOnDirectRoute: true,
        chat: { id: 'chat-direct' },
        stopSignal: { observed: true }
      })
    ).toEqual({
      action: 'return_original_chat_direct_passthrough',
      attachStopGatewayContext: true,
      result: {
        kind: 'return_original_chat_direct_passthrough',
        chat: { id: 'chat-direct' }
      },
      logStopEntry: {
        stage: 'trigger',
        result: 'skipped_direct_passthrough',
        includeChoiceFacts: false
      },
      logStopCompare: {
        stage: 'trigger'
      }
    });

    expect(
      planServertoolEnginePreflightWithNative({
        hasSyntheticControlText: false,
        stopSignalObserved: true,
        stoplessDisabledOnDirectRoute: false,
        chat: { id: 'chat-continue' },
        stopSignal: { observed: true, reason: 'stop_schema_missing' }
      })
    ).toEqual({
      action: 'continue_to_engine',
      attachStopGatewayContext: true,
      result: {
        kind: 'continue',
        stopSignal: { observed: true, reason: 'stop_schema_missing' }
      },
      logStopEntry: {
        stage: 'entry',
        result: 'observed',
        includeChoiceFacts: true
      }
    });

    expect(
      planServertoolEnginePreflightWithNative({
        hasSyntheticControlText: false,
        stopSignalObserved: true,
        chat: { id: 'chat-context' },
        stopSignal: { observed: true },
        adapterContext: {
          metadata: {
            routeName: 'provider-direct/live'
          }
        }
      })
    ).toEqual({
      action: 'return_original_chat_direct_passthrough',
      attachStopGatewayContext: true,
      result: {
        kind: 'return_original_chat_direct_passthrough',
        chat: { id: 'chat-context' }
      },
      logStopEntry: {
        stage: 'trigger',
        result: 'skipped_direct_passthrough',
        includeChoiceFacts: false
      },
      logStopCompare: {
        stage: 'trigger'
      }
    });
  });

  it('uses Rust-owned engine orchestration preflight action planning', () => {
    expect(
      planServertoolEngineOrchestrationPreflightActionWithNative({
        preflightKind: 'return_original_chat'
      })
    ).toEqual({
      action: 'return_preflight_chat'
    });

    expect(
      planServertoolEngineOrchestrationPreflightActionWithNative({
        preflightKind: 'return_original_chat_direct_passthrough'
      })
    ).toEqual({
      action: 'return_preflight_chat'
    });

    expect(
      planServertoolEngineOrchestrationPreflightActionWithNative({
        preflightKind: 'continue'
      })
    ).toEqual({
      action: 'continue_engine'
    });
  });

  it('uses Rust-owned server-side-tool entry preflight planning', () => {
    expect(
      planServertoolEntryPreflightWithNative({
        hasBaseObject: false,
        adapterClientDisconnected: false,
        chatResponse: 'raw-chat'
      })
    ).toMatchObject({
      action: 'return_passthrough_non_object_chat',
      passthroughResult: {
        mode: 'passthrough',
        finalChatResponse: 'raw-chat'
      }
    });

    expect(
      planServertoolEntryPreflightWithNative({
        hasBaseObject: true,
        adapterClientDisconnected: true,
        chatResponse: { id: 'chat-disconnected' }
      })
    ).toEqual({
      action: 'throw_client_disconnected'
    });

    expect(
      planServertoolEntryPreflightWithNative({
        hasBaseObject: true,
        adapterClientDisconnected: false,
        chatResponse: { id: 'chat-continue' }
      })
    ).toEqual({
      action: 'continue_to_tool_flow'
    });
  });

  it('uses Rust-owned server-side-tool entry preflight application planning', () => {
    expect(
      resolveServertoolEntryPreflightApplicationWithNative({
        entryPreflight: {
          action: 'return_result',
          result: {
            mode: 'passthrough',
            finalChatResponse: 'raw-chat'
          }
        }
      })
    ).toEqual({
      throwError: false,
      returnResult: true,
      result: {
        mode: 'passthrough',
        finalChatResponse: 'raw-chat'
      }
    });

    expect(
      resolveServertoolEntryPreflightApplicationWithNative({
        entryPreflight: {
          action: 'throw_error',
          errorPlan: {
            message: 'client disconnected',
            code: 'SERVERTOOL_CLIENT_DISCONNECTED',
            category: 'client_disconnect',
            status: 499
          } as any
        }
      })
    ).toMatchObject({
      throwError: true,
      errorPlan: {
        message: 'client disconnected',
        code: 'SERVERTOOL_CLIENT_DISCONNECTED',
        category: 'client_disconnect',
        status: 499
      }
    });
  });

  it('uses Rust-owned run-engine entry preflight application planning', () => {
    expect(
      resolveServertoolRunEngineEntryPreflightApplicationWithNative({
        entryPreflight: {
          action: 'return_result',
          result: { mode: 'passthrough', finalChatResponse: { id: 'preflight' } }
        }
      })
    ).toEqual({
      returnResult: true,
      result: { mode: 'passthrough', finalChatResponse: { id: 'preflight' } }
    });

    expect(
      resolveServertoolRunEngineEntryPreflightApplicationWithNative({
        entryPreflight: {
          action: 'continue',
          baseObject: { id: 'base' }
        }
      })
    ).toEqual({
      returnResult: false,
      baseObject: { id: 'base' }
    });
  });

  it('uses Rust-owned server-side-tool engine prepass action planning', () => {
    expect(
      planServertoolEnginePrepassActionWithNative({
        hasPrepassResult: true,
        prepassResult: { mode: 'passthrough', finalChatResponse: { id: 'prepass' } }
      })
    ).toEqual({
      action: 'return_prepass_result',
      result: { mode: 'passthrough', finalChatResponse: { id: 'prepass' } }
    });

    expect(
      planServertoolEnginePrepassActionWithNative({
        hasPrepassResult: false,
        prepassResult: null
      })
    ).toEqual({
      action: 'continue_to_execution'
    });
  });

  it('uses Rust-owned run-engine prepass application planning', () => {
    expect(
      resolveServertoolRunEnginePrepassApplicationWithNative({
        decision: {
          action: 'return_result',
          result: { mode: 'passthrough', finalChatResponse: { id: 'prepass' } }
        }
      })
    ).toEqual({
      returnResult: true,
      result: { mode: 'passthrough', finalChatResponse: { id: 'prepass' } }
    });

    expect(
      resolveServertoolRunEnginePrepassApplicationWithNative({
        decision: { action: 'continue_to_execution' }
      })
    ).toEqual({
      returnResult: false
    });
  });

  it('uses Rust-owned engine skip planning for passthrough and no-execution exits', () => {
    expect(
      planServertoolEngineSkipWithNative({
        engineMode: 'passthrough',
        hasExecution: false,
        finalChatResponse: { id: 'passthrough' }
      })
    ).toEqual({
      action: 'return_skipped_passthrough',
      skipReason: 'passthrough',
      triggerResult: 'skipped_passthrough',
      shellResult: {
        chat: { id: 'passthrough' },
        executed: false
      }
    });

    expect(
      planServertoolEngineSkipWithNative({
        engineMode: 'tool_flow',
        hasExecution: false,
        finalChatResponse: { id: 'no_execution' }
      })
    ).toEqual({
      action: 'return_skipped_no_execution',
      skipReason: 'no_execution',
      triggerResult: 'skipped_no_execution',
      shellResult: {
        chat: { id: 'no_execution' },
        executed: false
      }
    });

    expect(
      planServertoolEngineSkipWithNative({
        engineMode: 'tool_flow',
        hasExecution: true,
        finalChatResponse: { id: 'matched' }
      })
    ).toEqual({
      action: 'continue_matched_flow'
    });
  });

  it('uses Rust-owned stopless CLI projection context planning', () => {
    expect(
      planStoplessCliProjectionContextWithNative({
        metadataWritePlan: {
          stopless: {
            repeatCount: 4,
            maxRepeats: 6,
            triggerHint: 'stop_schema_continue_next_step',
            schemaFeedback: {
              reasonCode: 'stop_schema_continue_next_step'
            }
          }
        },
        stoplessControl: {
          triggerHint: 'control-hint'
        },
        chatStopText: '来自 chat 的 stop 文本',
        adapterStopText: '来自 adapter 的 stop 文本'
      })
    ).toEqual({
      reasoningText: '来自 chat 的 stop 文本',
      repeatCount: 4,
      maxRepeats: 6,
      publicTriggerHint: 'non_terminal_schema',
      schemaFeedback: {
        reasonCode: 'stop_schema_continue_next_step'
      }
    });
  });

  it('does not read legacy execution context or serverToolLoopState as stopless control', () => {
    expect(
      planStoplessCliProjectionContextWithNative({
        chatStopText: '来自 chat 的 stop 文本'
      })
    ).toEqual({
      reasoningText: '来自 chat 的 stop 文本',
      repeatCount: 1,
      maxRepeats: 1
    });
  });

  it('uses Rust-owned execution outcome runtime action planning', () => {
    expect(
      planServertoolExecutionOutcomeRuntimeActionWithNative({
        outcomeMode: 'mixed_client_tools',
        hasLastExecution: false,
        executedToolCallsLen: 0,
        flowId: 'servertool_mixed'
      })
    ).toEqual({
      action: 'invalid_mixed_client_tools_outcome',
      reuseLastExecutionEnvelope: false,
      executionFlowId: 'servertool_mixed'
    });

    expect(
      planServertoolExecutionOutcomeRuntimeActionWithNative({
        outcomeMode: 'mixed_client_tools',
        hasLastExecution: false,
        executedToolCallsLen: 0,
        flowId: '  '
      })
    ).toMatchObject({
      action: 'invalid_mixed_client_tools_outcome',
      executionFlowId: 'servertool_mixed'
    });

    expect(
      planServertoolExecutionOutcomeRuntimeActionWithNative({
        outcomeMode: 'servertool_only',
        hasLastExecution: true,
        executedToolCallsLen: 1,
        lastExecution: {
          flowId: 'flow_1',
          followup: { requestIdSuffix: ':reuse' },
          context: { kept: true }
        },
        flowId: 'servertool_multi'
      })
    ).toEqual({
      action: 'return_execution_contract',
      reuseLastExecutionEnvelope: false,
      executionFlowId: 'servertool_multi'
    });
  });

  it('uses Rust-owned execution outcome materialization result mode planning', () => {
    expect(
      planServertoolExecutionOutcomeMaterializationWithNative({
        requestId: 'req-tool-flow',
        outcomeMode: 'servertool_only',
        requiresPendingInjection: false,
        hasLastExecution: true,
        executedToolCallsLen: 1,
        flowId: 'flow-native'
      })
    ).toEqual({
      action: 'return_tool_flow',
      resultMode: 'tool_flow',
      executionFlowId: 'flow-native'
    });

    expect(
      planServertoolExecutionOutcomeMaterializationWithNative({
        requestId: 'req-missing',
        outcomeMode: 'servertool_only',
        requiresPendingInjection: false,
        hasLastExecution: false,
        executedToolCallsLen: 0
      })
    ).toMatchObject({
      action: 'throw_dispatch_error',
      errorPlan: {
        message: '[servertool] missing native execution contract for servertool-only outcome'
      }
    });
  });

  it('uses Rust-owned execution loop runtime action planning', () => {
    expect(
      planServertoolExecutionLoopRuntimeActionWithNative({
        hasHandlerEntry: false,
        hasMaterializedResult: false,
        hasHandlerError: false
      })
    ).toEqual({
      action: 'skip_non_tool_call_handler'
    });

    expect(
      planServertoolExecutionLoopRuntimeActionWithNative({
        hasHandlerEntry: true,
        triggerMode: 'tool_call',
        hasMaterializedResult: true,
        hasHandlerError: true
      })
    ).toEqual({
      action: 'apply_materialized_result'
    });

    expect(
      planServertoolExecutionLoopRuntimeActionWithNative({
        hasHandlerEntry: true,
        triggerMode: 'tool_call',
        nativeExecutionMode: 'guarded',
        tsExecutionMode: 'guarded',
        hasMaterializedResult: true,
        hasHandlerError: true
      })
    ).toEqual({
      action: 'apply_materialized_result'
    });

    expect(
      planServertoolExecutionLoopRuntimeActionWithNative({
        hasHandlerEntry: true,
        triggerMode: 'tool_call',
        nativeExecutionMode: 'guarded',
        tsExecutionMode: 'legacy',
        hasMaterializedResult: true,
        hasHandlerError: true
      })
    ).toEqual({
      action: 'throw_dispatch_spec_mismatch'
    });
  });

  it('uses Rust-owned execution loop effect planning', () => {
    expect(
      planServertoolExecutionLoopEffectWithNative({
        mode: 'handler_error',
        toolCall: {
          id: 'call_fail_1',
          name: 'web_search',
          arguments: '{}',
          executionMode: 'guarded',
          stripAfterExecute: true
        }
      })
    ).toEqual({
      toolCall: {
        id: 'call_fail_1',
        name: 'web_search',
        arguments: '{}',
        executionMode: 'guarded',
        stripAfterExecute: true
      },
      execution: {
        flowId: 'web_search_error'
      },
      handlerErrorMessage: 'unknown'
    });

    expect(
      planServertoolExecutionLoopEffectWithNative({
        mode: 'noop',
        toolCall: {
          id: 'call_continue_1',
          name: 'continue_execution',
          arguments: '{}',
          executionMode: 'guarded',
          stripAfterExecute: false
        },
      noopOutcome: {
        flowId: 'continue_execution_flow',
        chatResponse: {}
      }
      })
    ).toEqual({
      toolCall: {
        id: 'call_continue_1',
        name: 'continue_execution',
        arguments: '{}',
        executionMode: 'noop',
        stripAfterExecute: true
      },
      execution: {
        flowId: 'continue_execution_flow'
      }
    });
  });

  it('uses Rust-owned response-stage runtime action planning', () => {
    const bypassGatePlan = {
      shouldBypass: true,
      nextAction: 'bypass',
      responseHookMatched: false,
      responseHookRequired: false
    };
    const runAutoHooksGatePlan = {
      shouldBypass: false,
      nextAction: 'run_auto_hooks',
      responseHookMatched: true,
      responseHookRequired: false
    };
    const continueGatePlan = {
      shouldBypass: false,
      nextAction: 'run_auto_hooks',
      responseHookMatched: false,
      responseHookRequired: false
    };

    expect(
      planServertoolResponseStageRuntimeActionWithNative({
        responseStageGatePlan: bypassGatePlan,
        baseObject: { ok: 'bypass' },
        autoHookEvaluated: false,
        hasAutoHookResult: false
      })
    ).toEqual({
      action: 'return_passthrough_bypass',
      passResult: {
        action: 'return_passthrough_bypass'
      },
      prepassResult: {
        action: 'continue_to_execution',
        responseStageGatePlan: bypassGatePlan
      },
      finalizeResult: {
        mode: 'passthrough',
        finalChatResponse: { ok: 'bypass' }
      },
      passthroughResult: {
        mode: 'passthrough',
        finalChatResponse: { ok: 'bypass' }
      }
    });

    expect(
      planServertoolResponseStageRuntimeActionWithNative({
        responseStageGatePlan: {
          shouldBypass: true,
          nextAction: 'bypass',
          responseHookMatched: false,
          responseHookRequired: false,
          skipReason: ' empty_assistant_payload '
        },
        baseObject: { ok: 'bypass-skip' },
        autoHookEvaluated: false,
        hasAutoHookResult: false
      })
    ).toEqual({
      action: 'return_passthrough_bypass',
      passResult: {
        action: 'return_passthrough_bypass'
      },
      prepassResult: {
        action: 'continue_to_execution',
        responseStageGatePlan: {
          shouldBypass: true,
          nextAction: 'bypass',
          responseHookMatched: false,
          responseHookRequired: false,
          skipReason: ' empty_assistant_payload '
        }
      },
      finalizeResult: {
        mode: 'passthrough',
        finalChatResponse: { ok: 'bypass-skip' }
      },
      passthroughResult: {
        mode: 'passthrough',
        finalChatResponse: { ok: 'bypass-skip' }
      },
      skipReason: 'empty_assistant_payload'
    });

    expect(
      planServertoolResponseStageRuntimeActionWithNative({
        responseStageGatePlan: runAutoHooksGatePlan,
        autoHookEvaluated: false,
        hasAutoHookResult: false
      })
    ).toEqual({
      action: 'run_auto_hooks'
    });

    expect(
      planServertoolResponseStageRuntimeActionWithNative({
        responseStageGatePlan: runAutoHooksGatePlan,
        autoHookEvaluated: true,
        hasAutoHookResult: true,
        autoHookResult: {
          mode: 'tool_flow',
          finalChatResponse: { ok: true },
          execution: { flowId: 'flow_1' }
        }
      })
    ).toEqual({
      action: 'return_auto_hook_result',
      passResult: {
        action: 'return_auto_hook_result',
        result: {
          mode: 'tool_flow',
          finalChatResponse: { ok: true },
          execution: { flowId: 'flow_1' }
        }
      },
      prepassResult: {
        action: 'return_result',
        responseStageGatePlan: runAutoHooksGatePlan,
        result: {
          mode: 'tool_flow',
          finalChatResponse: { ok: true },
          execution: { flowId: 'flow_1' }
        }
      },
      finalizeResult: {
        mode: 'tool_flow',
        finalChatResponse: { ok: true },
        execution: { flowId: 'flow_1' }
      }
    });

    expect(
      planServertoolResponseStageRuntimeActionWithNative({
        responseStageGatePlan: continueGatePlan,
        baseObject: { ok: 'no-hook' },
        autoHookEvaluated: true,
        hasAutoHookResult: false
      })
    ).toEqual({
      action: 'return_passthrough_no_auto_hook_result',
      passResult: {
        action: 'continue_without_result'
      },
      prepassResult: {
        action: 'continue_to_execution',
        responseStageGatePlan: continueGatePlan
      },
      finalizeResult: {
        mode: 'passthrough',
        finalChatResponse: { ok: 'no-hook' }
      },
      passthroughResult: {
        mode: 'passthrough',
        finalChatResponse: { ok: 'no-hook' }
      }
    });

    expect(
      planServertoolResponseStageRuntimeActionWithNative({
        responseStageGatePlan: {
          shouldBypass: false,
          nextAction: 'run_auto_hooks',
          responseHookMatched: true,
          responseHookRequired: true,
          responseHookName: 'stop_message_auto'
        },
        autoHookEvaluated: true,
        hasAutoHookResult: false
      })
    ).toEqual({
      action: 'return_required_response_hook_empty',
      responseHookName: 'stop_message_auto'
    });
  });

  it('uses Rust-owned response-stage prepass initial application planning', () => {
    expect(
      resolveServertoolResponseStagePrepassInitialApplicationWithNative({
        decision: { action: 'run_auto_hooks' }
      })
    ).toEqual({
      runAutoHook: true
    });

    expect(
      resolveServertoolResponseStagePrepassInitialApplicationWithNative({
        decision: {
          action: 'return_prepass_result',
          result: {
            action: 'continue_to_execution',
            responseStageGatePlan: {
              shouldBypass: false,
              nextAction: 'continue_to_execution',
              responseHookMatched: false,
              responseHookRequired: false
            }
          }
        }
      })
    ).toEqual({
      runAutoHook: false,
      result: {
        action: 'continue_to_execution',
        responseStageGatePlan: {
          shouldBypass: false,
          nextAction: 'continue_to_execution',
          responseHookMatched: false,
          responseHookRequired: false
        }
      }
    });
  });

  it('uses Rust-owned registry lookup action planning', () => {
    expect(
      planServertoolRegistryLookupActionWithNative({
        name: 'custom_tool',
        builtinEntryPresent: false
      })
    ).toEqual({
      action: 'return_none',
      canonicalName: 'custom_tool'
    });
  });

  it('uses Rust-owned registry auto-hook descriptor planning', () => {
    expect(
      planServertoolRegistryAutoHookDescriptorsWithNative({
        hooks: [
          {
            id: ' stop_message_auto ',
            phase: 'post',
            priority: 999,
            order: 7
          },
          {
            id: 'vision_auto',
            phase: 'invalid'
          }
        ]
      })
    ).toEqual([
      {
        id: 'stop_message_auto',
        phase: 'post',
        priority: 999,
        order: 7,
        sourceIndex: 0
      },
      {
        id: 'vision_auto',
        phase: 'default',
        priority: 100,
        order: 0,
        sourceIndex: 1
      }
    ]);
  });

  it('uses Rust-owned auto-hook runtime attempt action planning', () => {
    expect(
      planAutoHookRuntimeAttemptWithNative({
        hookId: 'stop_message_auto',
        phase: 'default',
        priority: 40,
        queue: 'A_optional',
        queueIndex: 1,
        queueTotal: 2,
        hasPlannedResult: true,
        hasMaterializedResult: true,
        materializedFlowId: 'stop_message_flow'
      })
    ).toMatchObject({
      action: 'return_result',
      returnResult: true,
      continueQueue: false,
      rethrowError: false,
      traceEvent: {
        result: 'match',
        reason: 'matched',
        flowId: 'stop_message_flow'
      }
    });

    expect(
      planAutoHookRuntimeAttemptWithNative({
        hookId: 'vision_auto',
        phase: 'default',
        priority: 20,
        queue: 'A_optional',
        queueIndex: 1,
        queueTotal: 2,
        hasPlannedResult: false,
        hasMaterializedResult: false
      })
    ).toMatchObject({
      action: 'continue_queue',
      returnResult: false,
      continueQueue: true,
      rethrowError: false,
      traceEvent: {
        result: 'miss',
        reason: 'predicate_false'
      }
    });

    expect(
      planAutoHookRuntimeAttemptWithNative({
        hookId: 'stop_message_auto',
        phase: 'default',
        priority: 40,
        queue: 'A_optional',
        queueIndex: 1,
        queueTotal: 1,
        error: { message: 'boom' }
      })
    ).toMatchObject({
      action: 'rethrow_error',
      returnResult: false,
      continueQueue: false,
      rethrowError: true,
      traceEvent: {
        result: 'error',
        reason: 'boom'
      }
    });
  });

  it('uses Rust-owned auto-hook caller finalization result mode planning', () => {
    expect(
      planAutoHookCallerFinalizationWithNative({
        resultPresent: true,
        metadataWritePlanPresent: true,
        chatResponse: { choices: [] },
        execution: { flowId: 'auto-hook-finalization' },
        metadataWritePlan: { runtimeControl: { servertool: true } },
        queueIndex: 1,
        queueTotal: 2
      })
    ).toEqual({
      action: 'return_result',
      returnResult: true,
      continueNextQueue: false,
      returnNull: false,
      resultMode: 'tool_flow',
      result: {
        mode: 'tool_flow',
        finalChatResponse: { choices: [] },
        execution: { flowId: 'auto-hook-finalization' },
        metadataWritePlan: { runtimeControl: { servertool: true } }
      }
    });

    expect(
      planAutoHookCallerFinalizationWithNative({
        resultPresent: false,
        queueIndex: 1,
        queueTotal: 2
      })
    ).toEqual({
      action: 'continue_next_queue',
      returnResult: false,
      continueNextQueue: true,
      returnNull: false
    });
  });

  it('uses Rust-owned auto-hook caller result projection planning', () => {
    expect(
      planAutoHookCallerResultProjectionWithNative({
        resultPresent: true,
        metadataWritePlanPresent: true,
        chatResponse: { choices: [] },
        execution: { flowId: 'auto-hook' },
        metadataWritePlan: { runtimeControl: { servertool: true } }
      })
    ).toMatchObject({
      result: {
        mode: 'tool_flow',
        finalChatResponse: { choices: [] },
        execution: { flowId: 'auto-hook' },
        metadataWritePlan: { runtimeControl: { servertool: true } }
      }
    });

    expect(
      planAutoHookCallerResultProjectionWithNative({
        resultPresent: true,
        metadataWritePlanPresent: false,
        chatResponse: { choices: [] },
        execution: { flowId: 'auto-hook' }
      })
    ).toMatchObject({
      result: {
        mode: 'tool_flow',
        finalChatResponse: { choices: [] },
        execution: { flowId: 'auto-hook' }
      }
    });

    expect(() =>
      planAutoHookCallerResultProjectionWithNative({
        resultPresent: false,
        metadataWritePlanPresent: false
      })
    ).toThrow('auto-hook caller result projection requires queue result');
  });

  it('uses Rust-owned engine selection rerun overrides without TS empty-object fallback', () => {
    expect(
      planEngineSelectionAfterRunWithNative({
        primaryAutoHookIds: [' stop_message_auto ', 'vision_auto'],
        engineResult: { mode: 'passthrough' }
      })
    ).toEqual({
      action: 'rerun_excluding_primary_hooks',
      overrides: {
        excludeAutoHookIds: ['stop_message_auto', 'vision_auto']
      }
    });

    expect(
      planEngineSelectionAfterRunWithNative({
        primaryAutoHookIds: ['stop_message_auto'],
        engineResult: {
          mode: 'tool_flow',
          execution: { flowId: 'flow_engine_selection' }
        }
      })
    ).toMatchObject({
      action: 'return_current'
    });
  });

  it('uses Rust-owned registry projection planning for names, records, and auto handler order', () => {
    expect(
      planServertoolRegistryProjectionWithNative({
        registeredNames: [' stop_message_auto ', 'vision_auto', 'stop_message_auto'],
        registeredRecords: [
          { name: 'vision_auto', trigger: 'auto', sourceIndex: 0 },
          { name: ' custom_tool ', trigger: 'tool_call', sourceIndex: 1 },
          { name: 'stop_message_auto', trigger: 'auto', sourceIndex: 2 }
        ],
        autoHandlerNames: ['vision_auto', ' stop_message_auto ']
      })
    ).toEqual({
      registeredNames: ['stop_message_auto', 'vision_auto'],
      registeredRecords: [
        { name: 'custom_tool', trigger: 'tool_call', sourceIndex: 1 },
        { name: 'vision_auto', trigger: 'auto', sourceIndex: 0 },
        { name: 'stop_message_auto', trigger: 'auto', sourceIndex: 2 }
      ],
      autoHandlerNames: ['vision_auto', 'stop_message_auto']
    });
  });

  it.each([
    ['web_search', 'web_search'],
    ['vision_auto', 'multimodal']
  ])(
    'projects %s as client exec CLI projection with route hint %s',
    (toolName, routeHint) => {
      expect(buildClientExecCliProjectionOutputWithNative({
        toolName,
        input: { query: 'x' }
      })).toMatchObject({
        toolName,
        routeHint
      });
    }
  );

  it('rejects fake_exec as client exec CLI projection at the Rust bridge', () => {
    expect(() => buildClientExecCliProjectionOutputWithNative({
      toolName: 'fake_exec',
      input: { query: 'x' }
    })).toThrow('SERVERTOOL_DENIED_TOOL: fake_exec');
  });

  it('parses CLI projection tool arguments at the Rust bridge', () => {
    expect(parseServertoolCliProjectionToolArgumentsWithNative({
      arguments: '{"cmd":"pwd"}'
    })).toEqual({ cmd: 'pwd' });

    expect(() => parseServertoolCliProjectionToolArgumentsWithNative({
      arguments: '[]'
    })).toThrow('SERVERTOOL_CLI_INVALID_FIELD: arguments');
  });

  it('rejects additional servertool calls in the client-visible shell', () => {
    const nativeProjection = buildClientExecCliProjectionOutputWithNative({
      toolName: 'servertool_fixture',
      input: { value: 1 }
    });

    expect(() => buildClientVisibleProjectionShellWithNative({
      requestId: 'req_native_bridge_extra_tool',
      clientCallId: 'call_native_bridge_extra_tool',
      nativeProjection,
      reasoningText: 'servertool fixture',
      additionalToolCalls: [
        {
          id: 'call_web_search',
          type: 'function',
          function: {
            name: 'web_search',
            arguments: '{}'
          }
        }
      ]
    } as any)).toThrow('SERVERTOOL_UNSUPPORTED_TOOL: web_search');
  });
});
