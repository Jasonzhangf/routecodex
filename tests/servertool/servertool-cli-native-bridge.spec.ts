import {
  buildClientExecCliProjectionOutputWithNative,
  buildServertoolCliProjectionExecutionContextWithNative,
  buildClientVisibleProjectionShellWithNative,
  planServertoolEnginePreflightWithNative,
  planServertoolEngineSkipWithNative,
  planServertoolEngineRuntimeActionWithNative,
  planStoplessCliProjectionContextWithNative,
  planServertoolExecutionBranchWithNative,
  planServertoolExecutionLoopEffectWithNative,
  planServertoolExecutionLoopRuntimeActionWithNative,
  planServertoolExecutionOutcomeRuntimeActionWithNative,
  planServertoolEntryPreflightWithNative,
  planServertoolResponseStageRuntimeActionWithNative,
  planServertoolRegistryAutoHookDescriptorsWithNative,
  planServertoolRegistryLookupActionWithNative,
  planServertoolRegistryProjectionWithNative,
  planServertoolRegistryRegistrationActionWithNative
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.js';
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
      flowId: 'servertool_cli_projection',
      context: {
        servertoolCliProjection: {
          clientCallId: 'call_native_exec_context',
          toolName: 'servertool_fixture',
          requestId: 'req_native_exec_context'
        }
      }
    });
  });

  it('uses Rust-owned execution-branch planning for CLI projection and post-execution outcome', () => {
    expect(
      planServertoolExecutionBranchWithNative({
        executableToolCalls: [
          {
            id: 'call_cli_projection_1',
            name: 'servertool_fixture',
            executionMode: 'client_exec_cli_projection'
          }
        ],
        executedToolCallsLen: 0
      })
    ).toEqual({
      action: 'client_exec_cli_projection',
      projectedToolCallId: 'call_cli_projection_1'
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

  it('uses Rust-owned engine runtime-action planning for orchestration shell exits', () => {
    expect(
      planServertoolEngineRuntimeActionWithNative({
        hasPendingInjection: true,
        isStopMessageFlow: true,
        hasServertoolCliProjectionContext: true,
        stoplessAction: 'terminal_final'
      })
    ).toEqual({
      action: 'persist_pending_injection_and_return'
    });

    expect(
      planServertoolEngineRuntimeActionWithNative({
        hasPendingInjection: false,
        isStopMessageFlow: false,
        hasServertoolCliProjectionContext: true,
        stoplessAction: 'cli_projection'
      })
    ).toEqual({
      action: 'return_servertool_cli_projection_final'
    });

    expect(
      planServertoolEngineRuntimeActionWithNative({
        hasPendingInjection: false,
        isStopMessageFlow: true,
        hasServertoolCliProjectionContext: false,
        stoplessAction: 'cli_projection'
      })
    ).toEqual({
      action: 'build_stop_message_cli_projection'
    });
  });

  it('uses Rust-owned engine preflight planning for synthetic/direct early return', () => {
    expect(
      planServertoolEnginePreflightWithNative({
        hasSyntheticControlText: true,
        stopSignalObserved: true,
        stoplessDisabledOnDirectRoute: true
      })
    ).toEqual({
      action: 'return_original_chat'
    });

    expect(
      planServertoolEnginePreflightWithNative({
        hasSyntheticControlText: false,
        stopSignalObserved: true,
        stoplessDisabledOnDirectRoute: true
      })
    ).toEqual({
      action: 'return_original_chat_direct_passthrough'
    });

    expect(
      planServertoolEnginePreflightWithNative({
        hasSyntheticControlText: false,
        stopSignalObserved: true,
        stoplessDisabledOnDirectRoute: false
      })
    ).toEqual({
      action: 'continue_to_engine'
    });
  });

  it('uses Rust-owned server-side-tool entry preflight planning', () => {
    expect(
      planServertoolEntryPreflightWithNative({
        hasBaseObject: false,
        adapterClientDisconnected: false
      })
    ).toEqual({
      action: 'return_passthrough_non_object_chat'
    });

    expect(
      planServertoolEntryPreflightWithNative({
        hasBaseObject: true,
        adapterClientDisconnected: true
      })
    ).toEqual({
      action: 'throw_client_disconnected'
    });

    expect(
      planServertoolEntryPreflightWithNative({
        hasBaseObject: true,
        adapterClientDisconnected: false
      })
    ).toEqual({
      action: 'continue_to_tool_flow'
    });
  });

  it('uses Rust-owned engine skip planning for passthrough and no-execution exits', () => {
    expect(
      planServertoolEngineSkipWithNative({
        engineMode: 'passthrough',
        hasExecution: false
      })
    ).toEqual({
      action: 'return_skipped_passthrough',
      skipReason: 'passthrough'
    });

    expect(
      planServertoolEngineSkipWithNative({
        engineMode: 'tool_flow',
        hasExecution: false
      })
    ).toEqual({
      action: 'return_skipped_no_execution',
      skipReason: 'no_execution'
    });

    expect(
      planServertoolEngineSkipWithNative({
        engineMode: 'tool_flow',
        hasExecution: true
      })
    ).toEqual({
      action: 'continue_matched_flow'
    });
  });

  it('uses Rust-owned stopless CLI projection context planning', () => {
    expect(
      planStoplessCliProjectionContextWithNative({
        executionContext: {
          serverToolLoopState: {
            repeatCount: 4,
            maxRepeats: 6,
            triggerHint: 'loop-hint',
            schemaFeedback: {
              reason_code: 'loop_feedback'
            }
          },
          stopSchemaTriggerHint: 'context-hint',
          stopSchemaFeedback: {
            reason_code: 'context_feedback'
          }
        },
        stoplessControl: {
          triggerHint: 'control-hint'
        },
        runtimeSnapshot: {
          used: 1,
          maxRepeats: 3
        },
        chatStopText: '来自 chat 的 stop 文本',
        adapterStopText: '来自 adapter 的 stop 文本'
      })
    ).toEqual({
      reasoningText: '来自 chat 的 stop 文本',
      repeatCount: 2,
      maxRepeats: 3,
      triggerHint: 'loop-hint',
      schemaFeedback: {
        reason_code: 'loop_feedback'
      }
    });
  });

  it('uses Rust-owned execution outcome runtime action planning', () => {
    expect(
      planServertoolExecutionOutcomeRuntimeActionWithNative({
        outcomeMode: 'mixed_client_tools',
        requiresPendingInjection: true,
      followupStrategy: 'pending_injection',
      useLastExecutionFollowup: false,
      hasLastExecutionFollowup: false,
      hasResolvedFollowup: false,
      hasLastExecution: false,
      executedToolCallsLen: 0
    })
  ).toEqual({
    action: 'return_mixed_client_tools_pending_injection',
    reuseLastExecutionEnvelope: false
  });

    expect(
      planServertoolExecutionOutcomeRuntimeActionWithNative({
        outcomeMode: 'servertool_only',
        requiresPendingInjection: false,
      followupStrategy: 'reuse_last_execution',
      useLastExecutionFollowup: true,
      hasLastExecutionFollowup: true,
      hasResolvedFollowup: true,
      hasLastExecution: true,
      executedToolCallsLen: 1
    })
  ).toEqual({
    action: 'reuse_last_execution_followup',
    reuseLastExecutionEnvelope: true
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
      }
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
        noopFlowId: 'continue_execution_flow',
        noopFollowup: {
          requestIdSuffix: ':continue_execution_followup'
        },
        noopExecutionContext: {
          continue_execution: {
            visibleSummary: '继续执行'
          }
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
        flowId: 'continue_execution_flow',
        followup: {
          requestIdSuffix: ':continue_execution_followup'
        },
        context: {
          continue_execution: {
            visibleSummary: '继续执行'
          }
        }
      }
    });
  });

  it('uses Rust-owned response-stage runtime action planning', () => {
    expect(
      planServertoolResponseStageRuntimeActionWithNative({
        responseStageNextAction: 'bypass',
        autoHookEvaluated: false,
        hasAutoHookResult: false
      })
    ).toEqual({
      action: 'return_passthrough_bypass'
    });

    expect(
      planServertoolResponseStageRuntimeActionWithNative({
        responseStageNextAction: 'run_auto_hooks',
        autoHookEvaluated: false,
        hasAutoHookResult: false
      })
    ).toEqual({
      action: 'run_auto_hooks'
    });

    expect(
      planServertoolResponseStageRuntimeActionWithNative({
        responseStageNextAction: 'run_auto_hooks',
        autoHookEvaluated: true,
        hasAutoHookResult: true
      })
    ).toEqual({
      action: 'return_auto_hook_result'
    });

    expect(
      planServertoolResponseStageRuntimeActionWithNative({
        responseStageNextAction: 'run_auto_hooks',
        autoHookEvaluated: true,
        hasAutoHookResult: false
      })
    ).toEqual({
      action: 'return_passthrough_no_auto_hook_result'
    });
  });

  it('uses Rust-owned registry registration and lookup action planning', () => {
    expect(
      planServertoolRegistryRegistrationActionWithNative({
        name: ' stop_message_auto ',
        hasHandler: true,
        builtinNameMatched: true,
        builtinEntryPresent: true,
        registrationAllowedByConfig: true
      })
    ).toEqual({
      action: 'ignore_builtin_override',
      canonicalName: 'stop_message_auto'
    });

    expect(
      planServertoolRegistryRegistrationActionWithNative({
        name: ' custom_tool ',
        hasHandler: true,
        builtinNameMatched: false,
        builtinEntryPresent: false,
        registrationAllowedByConfig: true
      })
    ).toEqual({
      action: 'register_adhoc',
      canonicalName: 'custom_tool'
    });

    expect(
      planServertoolRegistryLookupActionWithNative({
        name: 'custom_tool',
        builtinEntryPresent: false,
        adHocEntryPresent: true
      })
    ).toEqual({
      action: 'return_adhoc',
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
        order: 7
      },
      {
        id: 'vision_auto',
        phase: 'default',
        priority: 100,
        order: 0
      }
    ]);
  });

  it('uses Rust-owned registry projection planning for names, records, and auto handler order', () => {
    expect(
      planServertoolRegistryProjectionWithNative({
        registeredNames: [' stop_message_auto ', 'vision_auto', 'stop_message_auto'],
        registeredRecords: [
          { name: 'vision_auto', trigger: 'auto' },
          { name: ' custom_tool ', trigger: 'tool_call' },
          { name: 'stop_message_auto', trigger: 'auto' }
        ],
        autoHandlerNames: ['vision_auto', ' stop_message_auto ']
      })
    ).toEqual({
      registeredNames: ['stop_message_auto', 'vision_auto'],
      registeredRecords: [
        { name: 'custom_tool', trigger: 'tool_call' },
        { name: 'vision_auto', trigger: 'auto' },
        { name: 'stop_message_auto', trigger: 'auto' }
      ],
      autoHandlerNames: ['vision_auto', 'stop_message_auto']
    });
  });

  it.each(['web_search', 'vision_auto', 'memory_cache_auto'])(
    'rejects %s as client exec CLI projection at the Rust bridge',
    (toolName) => {
      expect(() => buildClientExecCliProjectionOutputWithNative({
        toolName,
        input: { query: 'x' }
      })).toThrow(`SERVERTOOL_UNSUPPORTED_TOOL: ${toolName}`);
    }
  );

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
