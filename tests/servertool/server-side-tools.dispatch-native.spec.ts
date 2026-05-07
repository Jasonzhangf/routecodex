import { describe, expect, test } from '@jest/globals';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import {
  registerServerToolHandler,
  listRegisteredServerToolHandlerRecords
} from '../../sharedmodule/llmswitch-core/src/servertool/registry.js';
import {
  planServertoolOutcomeWithNative,
  planServertoolToolCallDispatchWithNative
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-chat-process-servertool-orchestration-semantics.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

const DISPATCH_TOOL_A = 'dispatch_native_clock_like';
const DISPATCH_TOOL_B = 'dispatch_native_exec_like';

registerServerToolHandler(DISPATCH_TOOL_A, async (ctx) => ({
  chatResponse: {
    ...(ctx.base as any),
    tool_outputs: [
      {
        tool_call_id: ctx.toolCall?.id,
        name: ctx.toolCall?.name,
        content: JSON.stringify({ ok: true, tool: ctx.toolCall?.name })
      }
    ]
  } as JsonObject,
  execution: {
    flowId: `${ctx.toolCall?.name}_ok`,
    followup: {
      requestIdSuffix: ':dispatch_test',
      injection: {
        ops: [
          { op: 'append_assistant_message', required: true },
          { op: 'append_tool_messages_from_tool_outputs', required: true }
        ]
      }
    }
  }
}));

registerServerToolHandler(DISPATCH_TOOL_B, async (ctx) => ({
  chatResponse: {
    ...(ctx.base as any),
    tool_outputs: [
      {
        tool_call_id: ctx.toolCall?.id,
        name: ctx.toolCall?.name,
        content: JSON.stringify({ ok: true, tool: ctx.toolCall?.name })
      }
    ]
  } as JsonObject,
  execution: {
    flowId: `${ctx.toolCall?.name}_ok`,
    followup: {
      requestIdSuffix: ':dispatch_test',
      injection: {
        ops: [
          { op: 'append_assistant_message', required: true },
          { op: 'append_tool_messages_from_tool_outputs', required: true }
        ]
      }
    }
  }
}));

function makeResponse(toolNames: string[]): JsonObject {
  return {
    id: 'chatcmpl-servertool-dispatch-native',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: toolNames.map((name, index) => ({
            id: `call_dispatch_${index + 1}`,
            type: 'function',
            function: {
              name,
              arguments: '{}'
            }
          }))
        },
        finish_reason: 'tool_calls'
      }
    ]
  } as JsonObject;
}

function makeAdapterContext(): AdapterContext {
  return {
    requestId: 'req-servertool-dispatch-native',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses'
  } as any;
}

function makeSessionAdapterContext(): AdapterContext {
  return {
    requestId: 'req-servertool-dispatch-native-session',
    entryEndpoint: '/v1/responses',
    providerProtocol: 'openai-responses',
    sessionId: 'sess_dispatch_1',
    conversationId: 'conv_dispatch_1'
  } as any;
}

describe('server-side-tools native dispatch planner', () => {
  test('returns spec-driven execution metadata in native dispatch plan', () => {
    const plan = planServertoolToolCallDispatchWithNative({
      toolCalls: [{ id: 'call_1', name: DISPATCH_TOOL_A, arguments: '{}' }],
      disableToolCallHandlers: false,
      registeredToolCallHandlers: listRegisteredServerToolHandlerRecords()
        .filter((entry) => entry.registration.trigger === 'tool_call')
        .map((entry) => ({
          name: entry.registration.name,
          trigger: entry.registration.trigger,
          executionMode: entry.registration.executionMode,
          stripAfterExecute: entry.registration.stripAfterExecute
        }))
    });
    expect(plan.executableToolCalls).toHaveLength(1);
    expect(plan.executableToolCalls[0]).toMatchObject({
      id: 'call_1',
      name: DISPATCH_TOOL_A,
      executionMode: 'guarded',
      stripAfterExecute: true
    });
  });

  test('executes only included registered handler names', async () => {
    const result = await runServerSideToolEngine({
      chatResponse: makeResponse([DISPATCH_TOOL_A, DISPATCH_TOOL_B]),
      adapterContext: makeSessionAdapterContext(),
      entryEndpoint: '/v1/responses',
      requestId: 'req-servertool-dispatch-native-include',
      providerProtocol: 'openai-responses',
      includeToolCallHandlerNames: [DISPATCH_TOOL_A]
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('servertool_mixed');
    const remaining = (result.finalChatResponse as any)?.choices?.[0]?.message?.tool_calls ?? [];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.function?.name).toBe(DISPATCH_TOOL_B);
    expect(result.pendingInjection).toMatchObject({
      sessionId: 'sess_dispatch_1',
      aliasSessionIds: ['conv_dispatch_1'],
      afterToolCallIds: ['call_dispatch_2']
    });
    expect(result.pendingInjection?.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_dispatch_1',
            type: 'function',
            function: {
              name: DISPATCH_TOOL_A,
              arguments: '{}'
            }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'call_dispatch_1',
        name: DISPATCH_TOOL_A,
        content: JSON.stringify({ ok: true, tool: DISPATCH_TOOL_A })
      }
    ]);
  });

  test('returns spec-driven mixed outcome contract from native planner', () => {
    const outcome = planServertoolOutcomeWithNative({
      toolCalls: [
        { id: 'call_dispatch_1', name: DISPATCH_TOOL_A, arguments: '{}' },
        { id: 'call_dispatch_2', name: DISPATCH_TOOL_B, arguments: '{}' }
      ],
      executedToolCalls: [
        {
          id: 'call_dispatch_1',
          name: DISPATCH_TOOL_A,
          arguments: '{}',
          executionMode: 'guarded',
          stripAfterExecute: true
        }
      ],
      executedFlowIds: [`${DISPATCH_TOOL_A}_ok`],
      sessionId: 'sess_dispatch_1',
      conversationId: 'conv_dispatch_1',
      toolOutputs: [
        {
          tool_call_id: 'call_dispatch_1',
          name: DISPATCH_TOOL_A,
          content: JSON.stringify({ ok: true, tool: DISPATCH_TOOL_A })
        }
      ],
      pendingInjectionMessageKinds: ['assistant_tool_calls', 'tool_outputs'],
      followupInjectionOps: ['append_assistant_message', 'append_tool_messages_from_tool_outputs'],
      hasLastExecutionFollowup: true,
      lastExecutionFlowId: `${DISPATCH_TOOL_A}_ok`
    });
    expect(outcome).toMatchObject({
      outcomeMode: 'mixed_client_tools',
      followupStrategy: 'pending_injection',
      requiresPendingInjection: true,
      primaryExecutionMode: 'guarded',
      pendingSessionId: 'sess_dispatch_1',
      aliasSessionIds: ['conv_dispatch_1']
    });
    expect(outcome.pendingInjectionMessageKinds).toEqual(['assistant_tool_calls', 'tool_outputs']);
    expect(outcome.pendingInjectionMessagesResolved).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_dispatch_1',
            type: 'function',
            function: {
              name: DISPATCH_TOOL_A,
              arguments: '{}'
            }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'call_dispatch_1',
        name: DISPATCH_TOOL_A,
        content: JSON.stringify({ ok: true, tool: DISPATCH_TOOL_A })
      }
    ]);
    expect(outcome.followupInjectionOps).toEqual([]);
  });

  test('native planner echoes configured generic followup ops', () => {
    const outcome = planServertoolOutcomeWithNative({
      toolCalls: [{ id: 'call_dispatch_1', name: DISPATCH_TOOL_A, arguments: '{}' }],
      executedToolCalls: [
        {
          id: 'call_dispatch_1',
          name: DISPATCH_TOOL_A,
          arguments: '{}',
          executionMode: 'guarded',
          stripAfterExecute: true
        }
      ],
      executedFlowIds: [`${DISPATCH_TOOL_A}_ok`],
      pendingInjectionMessageKinds: ['assistant_tool_calls', 'tool_outputs'],
      followupInjectionOps: ['append_assistant_message', 'append_tool_messages_from_tool_outputs'],
      hasLastExecutionFollowup: false
    });
    expect(outcome.followupInjectionOps).toEqual([
      'append_assistant_message',
      'append_tool_messages_from_tool_outputs'
    ]);
    expect(outcome.followupInjectionOpsResolved).toEqual([
      { op: 'append_assistant_message', required: true },
      { op: 'append_tool_messages_from_tool_outputs', required: true }
    ]);
  });

  test('uses servertool-only followup branch when all tool calls are executed', async () => {
    const result = await runServerSideToolEngine({
      chatResponse: makeResponse([DISPATCH_TOOL_A]),
      adapterContext: makeAdapterContext(),
      entryEndpoint: '/v1/responses',
      requestId: 'req-servertool-dispatch-native-followup',
      providerProtocol: 'openai-responses'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe(`${DISPATCH_TOOL_A}_ok`);
    expect(result.execution?.followup).toBeTruthy();
    expect((result.execution as any)?.followup?.injection?.ops).toEqual([
      { op: 'append_assistant_message', required: true },
      { op: 'append_tool_messages_from_tool_outputs', required: true }
    ]);
    expect(result.pendingInjection).toBeUndefined();
  });

  test('keeps tool_calls untouched when tool_call handlers are disabled', async () => {
    const result = await runServerSideToolEngine({
      chatResponse: makeResponse([DISPATCH_TOOL_A]),
      adapterContext: makeAdapterContext(),
      entryEndpoint: '/v1/responses',
      requestId: 'req-servertool-dispatch-native-disabled',
      providerProtocol: 'openai-responses',
      disableToolCallHandlers: true
    });

    expect(result.mode).toBe('passthrough');
    const remaining = (result.finalChatResponse as any)?.choices?.[0]?.message?.tool_calls ?? [];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.function?.name).toBe(DISPATCH_TOOL_A);
  });

  test('skips unregistered tool_call handlers without crashing', async () => {
    const result = await runServerSideToolEngine({
      chatResponse: makeResponse(['dispatch_native_unknown']),
      adapterContext: makeAdapterContext(),
      entryEndpoint: '/v1/responses',
      requestId: 'req-servertool-dispatch-native-unknown',
      providerProtocol: 'openai-responses'
    });

    expect(result.mode).toBe('passthrough');
    const remaining = (result.finalChatResponse as any)?.choices?.[0]?.message?.tool_calls ?? [];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.function?.name).toBe('dispatch_native_unknown');
  });
});
