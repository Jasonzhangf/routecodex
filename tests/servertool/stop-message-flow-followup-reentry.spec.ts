import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, jest, test } from '@jest/globals';

import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import { runServertoolResponseStageOrchestrationShell } from '../../sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.js';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js';
import type { RoutingInstructionState } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-stop-message-flow-followup-sessions');

function buildStopResponse(content = 'done'): JsonObject {
  return {
    id: 'chatcmpl_stop_message_flow_followup',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content
        }
      }
    ]
  };
}

function buildToolCallsResponse(): JsonObject {
  return {
    id: 'chatcmpl_stop_message_flow_tool_calls',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'apply_patch',
                arguments: '{"filePath":"tmp/a.txt","patch":"+ hello"}'
              }
            }
          ]
        }
      }
    ]
  };
}

function createEmptyRoutingInstructionState(): RoutingInstructionState {
  return {
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
    reasoningStopMode: undefined,
    reasoningStopArmed: undefined,
    reasoningStopSummary: undefined,
    reasoningStopUpdatedAt: undefined,
    preCommandSource: undefined,
    preCommandScriptPath: undefined,
    preCommandUpdatedAt: undefined
  };
}

describe('stop_message_flow followup reentry', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
  });

  beforeEach(() => {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  });

  test('uses stop_message_flow standard servertool reenter followup instead of client/tmux inject when the hop is already followup', async () => {
    const sessionId = 'stop-message-flow-followup-hop';
    const stickyKey = `session:${sessionId}`;
    const state = createEmptyRoutingInstructionState();
    state.stopMessageText = '继续执行';
    state.stopMessageMaxRepeats = 3;
    state.stopMessageUsed = 0;
    state.stopMessageUpdatedAt = Date.now();
    saveRoutingInstructionStateSync(stickyKey, state);

    const clientInjectDispatch = jest.fn(async () => ({ ok: true } as const));
    const reenterPipeline = jest.fn(async () => ({
      body: buildStopResponse('reentered')
    }));

    const result = await runServerToolOrchestration({
      chat: buildStopResponse('再次停止'),
      adapterContext: {
        sessionId,
        clientInjectSource: 'servertool.stop_message',
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'start' }]
        },
        __rt: { serverToolFollowup: true }
      } as unknown as AdapterContext,
      requestId: 'req_stop_message_flow_followup_hop',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      clientInjectDispatch,
      reenterPipeline
    });

    expect(result.executed).toBe(true);
    expect(clientInjectDispatch).not.toHaveBeenCalled();
    expect(reenterPipeline).toHaveBeenCalledTimes(1);
    expect(loadRoutingInstructionStateSync(stickyKey)?.stopMessageUsed).toBe(1);
  });

  test('non-goal stopless default uses simple reenter for three consecutive stop turns then stops', async () => {
    const sessionId = 'stopless-default-three-turns';
    const stickyKey = `session:${sessionId}`;
    const reenterPipeline = jest.fn(async () => ({
      body: buildStopResponse('reentered')
    }));

    for (let index = 0; index < 3; index += 1) {
      const result = await runServerToolOrchestration({
        chat: buildStopResponse(`stop-${index + 1}`),
        adapterContext: {
          sessionId,
          capturedChatRequest: {
            model: 'gpt-test',
            messages: [{ role: 'user', content: 'start' }]
          }
        } as unknown as AdapterContext,
        requestId: `req_stopless_default_${index + 1}`,
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        reenterPipeline
      });

      expect(result.executed).toBe(true);
      expect(result.flowId).toBe('stop_message_flow');
      expect(loadRoutingInstructionStateSync(stickyKey)?.stopMessageUsed).toBe(index + 1);
    }

    const exhausted = await runServerToolOrchestration({
      chat: buildStopResponse('stop-4'),
      adapterContext: {
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'start' }]
        }
      } as unknown as AdapterContext,
      requestId: 'req_stopless_default_4',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline
    });

    expect(exhausted.executed).toBe(false);
    expect(reenterPipeline).toHaveBeenCalledTimes(3);
  });

  test('stop followup tool_calls resets default consecutive stop budget', async () => {
    const sessionId = 'stopless-default-tool-calls-reset';
    const stickyKey = `session:${sessionId}`;
    const state = createEmptyRoutingInstructionState();
    state.stopMessageText = '继续执行';
    state.stopMessageMaxRepeats = 3;
    state.stopMessageUsed = 2;
    state.stopMessageStageMode = 'on';
    state.stopMessageAiMode = 'off';
    state.stopMessageSource = 'default';
    state.stopMessageUpdatedAt = Date.now();
    saveRoutingInstructionStateSync(stickyKey, state);

    const reenterPipeline = jest.fn(async () => ({
      body: buildToolCallsResponse()
    }));

    const first = await runServerToolOrchestration({
      chat: buildStopResponse('stop-before-tool-call'),
      adapterContext: {
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'start' }]
        }
      } as unknown as AdapterContext,
      requestId: 'req_stopless_tool_calls_reset_first',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline
    });

    expect(first.executed).toBe(true);
    expect(first.chat.choices).toEqual(buildToolCallsResponse().choices);
    expect(loadRoutingInstructionStateSync(stickyKey)?.stopMessageUsed).toBe(0);

    reenterPipeline.mockResolvedValueOnce({ body: buildStopResponse('continued-after-reset') });
    const second = await runServerToolOrchestration({
      chat: buildStopResponse('new-stop-after-tool-call'),
      adapterContext: {
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'start again' }]
        }
      } as unknown as AdapterContext,
      requestId: 'req_stopless_tool_calls_reset_second',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline
    });

    expect(second.executed).toBe(true);
    expect(loadRoutingInstructionStateSync(stickyKey)?.stopMessageUsed).toBe(1);
  });

  test('servertool followup hop stop still triggers stopless simple reenter', async () => {
    const sessionId = 'stopless-after-apply-patch-followup-stop';
    const stickyKey = `session:${sessionId}`;
    const reenterPipeline = jest.fn(async () => ({
      body: buildStopResponse('continued after apply_patch followup stop')
    }));

    const result = await runServerToolOrchestration({
      chat: buildStopResponse('apply_patch followup stopped'),
      adapterContext: {
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'start' }]
        },
        __rt: {
          serverToolFollowup: true,
          serverToolFollowupFlowId: 'apply_patch_flow'
        }
      } as unknown as AdapterContext,
      requestId: 'req_stopless_after_apply_patch_followup_stop',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline
    });

    expect(result.executed).toBe(true);
    expect(result.flowId).toBe('stop_message_flow');
    expect(reenterPipeline).toHaveBeenCalledTimes(1);
    expect(loadRoutingInstructionStateSync(stickyKey)?.stopMessageUsed).toBe(1);
  });

  test('servertool loop-state followup stop still triggers stopless simple reenter', async () => {
    const sessionId = 'stopless-after-loop-state-followup-stop';
    const reenterPipeline = jest.fn(async () => ({
      body: buildStopResponse('continued after loop-state followup stop')
    }));

    const result = await runServerToolOrchestration({
      chat: buildStopResponse('loop-state followup stopped'),
      adapterContext: {
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'start' }]
        },
        __rt: {
          serverToolFollowup: true,
          serverToolLoopState: {
            flowId: 'apply_patch_flow'
          }
        }
      } as unknown as AdapterContext,
      requestId: 'req_stopless_after_loop_state_followup_stop',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline
    });

    expect(result.executed).toBe(true);
    expect(result.flowId).toBe('stop_message_flow');
    expect(reenterPipeline).toHaveBeenCalledTimes(1);
  });

  test('response-stage followup bypass still allows stopless when apply_patch followup returns stop', async () => {
    const sessionId = 'response-stage-apply-patch-followup-stopless';
    const reenterPipeline = jest.fn(async () => ({
      body: buildStopResponse('continued from response-stage')
    }));

    const result = await runServertoolResponseStageOrchestrationShell({
      payload: buildStopResponse('apply_patch followup stopped') as any,
      adapterContext: {
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'start' }]
        },
        __rt: {
          serverToolFollowup: true
        }
      } as unknown as AdapterContext,
      requestId: 'req_response_stage_apply_patch_followup_stopless',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline
    });

    expect(result.executed).toBe(true);
    expect(result.flowId).toBe('stop_message_flow');
    expect(reenterPipeline).toHaveBeenCalledTimes(1);
  });

  test('openai-responses relay chat.completion stop triggers stopless reenter', async () => {
    const sessionId = 'responses-relay-chat-completion-stopless';
    const reenterPipeline = jest.fn(async () => ({
      body: buildStopResponse('continued from responses relay')
    }));

    const result = await runServertoolResponseStageOrchestrationShell({
      payload: buildStopResponse('responses relay stopped') as any,
      adapterContext: {
        sessionId,
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'start' }]
        }
      } as unknown as AdapterContext,
      requestId: 'req_responses_relay_chat_completion_stopless',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline
    });

    expect(result.executed).toBe(true);
    expect(result.flowId).toBe('stop_message_flow');
    expect(reenterPipeline).toHaveBeenCalledTimes(1);
  });
});
