import { describe, expect, test, beforeEach, jest } from '@jest/globals';
import { loadRoutingInstructionStateSync } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js';

describe('stopless goal guard', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('paused stopless goal does not trigger auto followup', async () => {
    await import('../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js');
    const { listAutoServerToolHooks } = await import('../../sharedmodule/llmswitch-core/src/servertool/registry.js');

    const hook = listAutoServerToolHooks().find((entry) => entry.id === 'stopless_goal_guard');
    expect(hook).toBeDefined();

    const plan = await hook!.handler({
      base: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '暂停等待'
            }
          }
        ]
      } as any,
      toolCalls: [],
      adapterContext: {
        sessionId: 'stopless-goal-guard-paused',
        stoplessGoalState: {
          status: 'paused',
          objective: '完成 RCC stopless goal 接管',
          latestNote: '等待 Jason 确认',
          updatedAt: 1,
          createdAt: 1
        }
      } as any,
      requestId: 'req-stopless-goal-guard-2',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      capabilities: {
        reenterPipeline: true,
        providerInvoker: false
      }
    });

    expect(plan).toBeNull();
  });

  test('active stopless goal only counts plain stop replies and forces stopped after threshold', async () => {
    await import('../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js');
    const { listAutoServerToolHooks } = await import('../../sharedmodule/llmswitch-core/src/servertool/registry.js');

    const hook = listAutoServerToolHooks().find((entry) => entry.id === 'stopless_goal_guard');
    expect(hook).toBeDefined();

    const sessionId = 'stopless-goal-no-progress-threshold';
    const base = {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '完成。'
          }
        }
      ]
    } as any;

    for (let i = 0; i < 3; i += 1) {
      const plan = await hook!.handler({
        base,
        toolCalls: [],
        adapterContext: {
          sessionId,
          ...(i === 0
            ? {
                stoplessGoalState: {
                  status: 'active',
                  objective: '收口 stopless -> /goal 生命周期',
                  updatedAt: 1,
                  createdAt: 1
                }
              }
            : {})
        } as any,
        requestId: `req-stopless-goal-no-progress-${i + 1}`,
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        capabilities: {
          reenterPipeline: true,
          providerInvoker: false
        }
      });
      expect(plan).toBeNull();
    }

    const persisted = loadRoutingInstructionStateSync(`session:${sessionId}`);
    expect((persisted?.stoplessGoalState as Record<string, unknown>)?.status).toBe('stopped');
    expect((persisted?.stoplessGoalState as Record<string, unknown>)?.errorClass).toBe('repeated_no_progress');
    expect((persisted?.stoplessGoalState as Record<string, unknown>)?.attemptsExhausted).toBe(true);
    expect((persisted?.stoplessGoalState as Record<string, unknown>)?.consecutiveNoProgress).toBe(3);
  });

  test('non-goal stop responses do not enqueue stopless followup', async () => {
    await import('../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js');
    const { listAutoServerToolHooks } = await import('../../sharedmodule/llmswitch-core/src/servertool/registry.js');

    const hook = listAutoServerToolHooks().find((entry) => entry.id === 'stopless_goal_guard');
    expect(hook).toBeDefined();

    const plan = await hook!.handler({
      base: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: 'done'
            }
          }
        ]
      } as any,
      toolCalls: [],
      adapterContext: {
        requestId: 'req-non-goal',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        capturedChatRequest: {
          tools: [{ type: 'function', function: { name: 'exec_command' } }]
        }
      } as any,
      requestId: 'req-non-goal',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      capabilities: {
        reenterPipeline: false,
        clientInjectDispatch: false,
        providerInvoker: false
      }
    });

    expect(plan).toBeNull();
  });
});
