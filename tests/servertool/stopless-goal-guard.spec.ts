import { describe, expect, test, beforeEach, jest } from '@jest/globals';
import { loadRoutingInstructionStateSync } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js';

describe('stopless goal guard', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  test('active stopless goal schedules followup without reasoning.stop contract', async () => {
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
              content: '阶段性汇报'
            }
          }
        ]
      } as any,
      toolCalls: [],
      adapterContext: {
        sessionId: 'stopless-goal-guard-active',
        stoplessGoalState: {
          status: 'active',
          objective: '完成 RCC stopless goal 接管',
          latestNote: '继续推进，不要停止',
          updatedAt: 1,
          createdAt: 1
        }
      } as any,
      requestId: 'req-stopless-goal-guard-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      capabilities: {
        reenterPipeline: true,
        providerInvoker: false
      }
    });

    expect(plan?.flowId).toBe('stopless_goal_continue_flow');
    const finalized = await plan!.finalize({});
    expect(finalized?.execution?.followup?.requestIdSuffix).toBe(':stopless_goal_continue');
    expect(finalized?.execution?.followup?.metadata).toMatchObject({
      clientInjectSource: 'servertool.stopless_goal_continue'
    });
    const ops = (finalized?.execution?.followup as any)?.injection?.ops ?? [];
    expect(ops[0]).toEqual({ op: 'append_assistant_message', required: false });
    expect(ops[1]).toMatchObject({
      op: 'append_user_text'
    });
    expect(String(ops[1]?.text)).toContain('目标：完成 RCC stopless goal 接管');
    expect(String(ops[1]?.text)).not.toContain('reasoning.stop');
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

  test('active stopless goal forces stopped after three plain stop replies without validated goal transition', async () => {
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

    const first = await hook!.handler({
      base,
      toolCalls: [],
      adapterContext: {
        sessionId,
        stoplessGoalState: {
          status: 'active',
          objective: '收口 stopless -> /goal 生命周期',
          updatedAt: 1,
          createdAt: 1
        }
      } as any,
      requestId: 'req-stopless-goal-no-progress-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      capabilities: {
        reenterPipeline: true,
        providerInvoker: false
      }
    });
    expect(first?.flowId).toBe('stopless_goal_continue_flow');

    for (let i = 0; i < 1; i += 1) {
      const plan = await hook!.handler({
        base,
        toolCalls: [],
        adapterContext: {
          sessionId
        } as any,
        requestId: `req-stopless-goal-no-progress-${i + 2}`,
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        capabilities: {
          reenterPipeline: true,
          providerInvoker: false
        }
      });
      expect(plan?.flowId).toBe('stopless_goal_continue_flow');
    }

    const third = await hook!.handler({
      base,
      toolCalls: [],
      adapterContext: {
        sessionId
      } as any,
      requestId: 'req-stopless-goal-no-progress-3',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      capabilities: {
        reenterPipeline: true,
        providerInvoker: false
      }
    });

    expect(third).toBeNull();
    const persisted = loadRoutingInstructionStateSync(`session:${sessionId}`);
    expect((persisted?.stoplessGoalState as Record<string, unknown>)?.status).toBe('stopped');
    expect((persisted?.stoplessGoalState as Record<string, unknown>)?.errorClass).toBe('repeated_no_progress');
    expect((persisted?.stoplessGoalState as Record<string, unknown>)?.attemptsExhausted).toBe(true);
    expect((persisted?.stoplessGoalState as Record<string, unknown>)?.consecutiveNoProgress).toBe(3);
  });
});
