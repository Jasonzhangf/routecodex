import { describe, expect, test } from '@jest/globals';

import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import {
  saveRoutingInstructionStateSync
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import type { RoutingInstructionState } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions/types.js';

function buildStopResponse(text = '阶段完成'): JsonObject {
  return {
    id: 'chatcmpl-goal-mode-stop',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text
        },
        finish_reason: 'stop'
      }
    ]
  } as JsonObject;
}

function buildReasoningStopToolCallResponse(): JsonObject {
  return {
    id: 'chatcmpl-goal-mode-reasoning-stop-tool',
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
              id: 'call_goal_mode_reasoning_stop',
              type: 'function',
              function: {
                name: 'reasoning.stop',
                arguments: JSON.stringify({
                  task_goal: 'legacy stop',
                  is_completed: false,
                  next_step: 'should never execute in goal mode'
                })
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ]
  } as JsonObject;
}

function createRoutingInstructionState(overrides: Partial<RoutingInstructionState> = {}): RoutingInstructionState {
  return {
    stoplessGoalState: undefined,
    forcedTarget: undefined,
    stickyTarget: undefined,
    preferTarget: undefined,
    allowedProviders: new Set<string>(),
    disabledProviders: new Set<string>(),
    disabledKeys: new Map<string, Set<string | number>>(),
    disabledModels: new Map<string, Set<string>>(),
    stopMessageSource: undefined,
    stopMessageText: undefined,
    stopMessageMaxRepeats: undefined,
    stopMessageUsed: undefined,
    stopMessageUpdatedAt: undefined,
    stopMessageLastUsedAt: undefined,
    stopMessageStageMode: undefined,
    stopMessageAiMode: undefined,
    stopMessageAiSeedPrompt: undefined,
    stopMessageAiHistory: undefined,
    preCommandSource: undefined,
    preCommandScriptPath: undefined,
    preCommandUpdatedAt: undefined,
    chatProcessLastTotalTokens: undefined,
    chatProcessLastInputTokens: undefined,
    chatProcessLastMessageCount: undefined,
    chatProcessLastUpdatedAt: undefined,
    ...overrides
  };
}

describe('server-side-tools goal mode legacy reasoning.stop gating', () => {
  test('goal-capable adapter context excludes legacy reasoning_stop_guard even with persisted reasoningStopMode=on', async () => {
    const sessionId = 'goal-mode-disables-legacy-guard';
    const stickyKey = `session:${sessionId}`;
    saveRoutingInstructionStateSync(stickyKey, createRoutingInstructionState({
      reasoningStopMode: 'on'
    } as any));

    const result = await runServerSideToolEngine({
      chatResponse: buildStopResponse('goal turn stopped'),
      adapterContext: {
        sessionId,
        requestSemantics: {
          tools: {
            clientToolsRaw: [
              { type: 'function', function: { name: 'get_goal', parameters: { type: 'object' } } },
              { type: 'function', function: { name: 'update_goal', parameters: { type: 'object' } } }
            ]
          }
        }
      } as any,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      requestId: 'req_goal_mode_legacy_guard_skip'
    });

    expect(result.mode).toBe('passthrough');
    expect(result.execution?.flowId).toBeUndefined();
  });

  test('managed stopless goal state excludes legacy reasoning_stop_guard even with stale reasoningStopMode=on', async () => {
    const sessionId = 'managed-goal-disables-legacy-guard';
    const stickyKey = `session:${sessionId}`;
    saveRoutingInstructionStateSync(stickyKey, createRoutingInstructionState({
      reasoningStopMode: 'on'
    } as any));

    const result = await runServerSideToolEngine({
      chatResponse: buildStopResponse('managed goal turn stopped'),
      adapterContext: {
        sessionId,
        stoplessGoalState: {
          status: 'active',
          objective: 'continue managed goal',
          updatedAt: Date.now(),
          createdAt: Date.now()
        }
      } as any,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      requestId: 'req_managed_goal_legacy_guard_skip'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('stopless_goal_continue_flow');
  });

  test('goal-capable adapter context does not execute legacy reasoning.stop tool calls', async () => {
    const result = await runServerSideToolEngine({
      chatResponse: buildReasoningStopToolCallResponse(),
      adapterContext: {
        __rt: { goalMode: true },
        requestSemantics: {
          tools: {
            clientToolsRaw: [
              { type: 'function', function: { name: 'get_goal', parameters: { type: 'object' } } },
              { type: 'function', function: { name: 'update_goal', parameters: { type: 'object' } } }
            ]
          }
        }
      } as any,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      requestId: 'req_goal_mode_reasoning_stop_tool_skip'
    });

    expect(result.mode).toBe('passthrough');
    const toolOutputs = (result.finalChatResponse as any)?.tool_outputs;
    expect(toolOutputs).toBeUndefined();
    const toolCalls = (result.finalChatResponse as any)?.choices?.[0]?.message?.tool_calls ?? [];
    expect(toolCalls).toEqual([]);
  });
});
