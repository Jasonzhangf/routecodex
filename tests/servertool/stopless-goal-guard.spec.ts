import { describe, expect, test, beforeEach, jest } from '@jest/globals';
import { loadRoutingInstructionStateSync } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js';
import { buildNativeFollowupPayloadFromInjection } from '../../sharedmodule/llmswitch-core/src/servertool/handlers/followup-request-builder/native-block.js';
import { buildChatFollowupPayloadFromInjection } from '../../sharedmodule/llmswitch-core/src/servertool/handlers/followup-request-builder/chat-block.js';

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

  test('non-goal followup sourced turn does not enqueue another stopless followup (loop breaker)', async () => {
    await import('../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js');
    const { listAutoServerToolHooks } = await import('../../sharedmodule/llmswitch-core/src/servertool/registry.js');

    const hook = listAutoServerToolHooks().find((entry) => entry.id === 'stopless_goal_guard');
    expect(hook).toBeDefined();

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

    const plan = await hook!.handler({
      base,
      toolCalls: [],
      adapterContext: {
        sessionId: 'stopless-goal-nongoal-loop-breaker',
        clientInjectSource: 'servertool.stopless_goal_continue',
        __rt: {
          serverToolFollowup: true,
          clientInjectSource: 'servertool.stopless_goal_continue'
        }
      } as any,
      requestId: 'req-stopless-goal-loop-breaker-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      capabilities: {
        reenterPipeline: true,
        providerInvoker: false
      }
    });

    expect(plan).toBeNull();
  });

  test('non-goal bootstrap followup keeps complete tool list (must not strip reasoning.stop)', () => {
    const payload = buildChatFollowupPayloadFromInjection({
      adapterContext: {
        sessionId: 'stopless-goal-nongoal-keep-tools',
        clientInjectSource: 'servertool.stopless_goal_continue',
        stoplessGoalState: {
          status: 'active',
          objective: 'legacy managed state should not trigger tool stripping for non-goal bootstrap',
          updatedAt: 1,
          createdAt: 1
        },
        capturedChatRequest: {
          model: 'gpt-4.1',
          messages: [
            {
              role: 'user',
              content: '继续执行'
            }
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'reasoning.stop',
                description: 'reasoning stop control',
                parameters: { type: 'object', properties: {} }
              }
            },
            {
              type: 'function',
              function: {
                name: 'exec_command',
                description: 'run shell',
                parameters: { type: 'object', properties: {} }
              }
            }
          ]
        }
      } as any,
      chatResponse: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: '继续'
            }
          }
        ]
      } as any,
      injection: {
        ops: [
          { op: 'preserve_tools' },
          { op: 'ensure_standard_tools' },
          { op: 'append_user_text', text: '继续执行，不要停止。' }
        ]
      }
    });

    expect(payload).not.toBeNull();
    const tools = Array.isArray((payload as Record<string, unknown>)?.tools)
      ? ((payload as Record<string, unknown>).tools as Array<Record<string, unknown>>)
      : [];
    const names = tools.map((tool) => {
      const fn = tool?.function as Record<string, unknown> | undefined;
      return typeof fn?.name === 'string' ? fn.name : '';
    });
    expect(names).toContain('reasoning.stop');
    expect(names).toContain('exec_command');
  });

  test('non-goal bootstrap native followup also keeps complete tool list (not only reasoning.stop)', () => {
    const payload = buildNativeFollowupPayloadFromInjection({
      adapterContext: {
        sessionId: 'stopless-goal-nongoal-keep-tools-native',
        clientInjectSource: 'servertool.stopless_goal_continue',
        stoplessGoalState: {
          status: 'active',
          objective: 'native path must not collapse tool list',
          updatedAt: 1,
          createdAt: 1
        },
        capturedChatRequest: {
          model: 'gpt-4.1',
          messages: [
            {
              role: 'user',
              content: '继续执行'
            }
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'reasoning.stop',
                description: 'reasoning stop control',
                parameters: { type: 'object', properties: {} }
              }
            },
            {
              type: 'function',
              function: {
                name: 'exec_command',
                description: 'run shell',
                parameters: { type: 'object', properties: {} }
              }
            },
            {
              type: 'function',
              function: {
                name: 'apply_patch',
                description: 'apply patch',
                parameters: { type: 'object', properties: {} }
              }
            }
          ]
        }
      } as any,
      chatResponse: {
        choices: [
          {
            message: {
              role: 'assistant',
              content: '继续'
            }
          }
        ]
      } as any,
      injection: {
        ops: [
          { op: 'preserve_tools' },
          { op: 'ensure_standard_tools' },
          { op: 'append_user_text', text: '继续执行，不要停止。' }
        ]
      }
    });

    expect(payload).not.toBeNull();
    const tools = Array.isArray((payload as Record<string, unknown>)?.tools)
      ? ((payload as Record<string, unknown>).tools as Array<Record<string, unknown>>)
      : [];
    const names = tools.map((tool) => {
      const fn = tool?.function as Record<string, unknown> | undefined;
      return typeof fn?.name === 'string' ? fn.name : '';
    });
    expect(names).toContain('reasoning.stop');
    expect(names).toContain('exec_command');
    expect(names).toContain('apply_patch');
  });
});
