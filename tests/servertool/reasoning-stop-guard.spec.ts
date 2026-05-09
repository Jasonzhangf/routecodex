import * as fs from 'node:fs';
import * as path from 'node:path';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import { __unsafeBuildAdapterContextForTest } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.js';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js';
import type { RoutingInstructionState } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-reasoning-stop-sessions');

function buildStopResponse(content = 'done'): JsonObject {
  return {
    id: 'chatcmpl_reasoning_stop',
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

function buildReasoningStopToolCallResponse(argumentsPayload: Record<string, unknown>): JsonObject {
  return {
    id: 'chatcmpl_reasoning_stop_call',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_reasoning_stop_1',
              type: 'function',
              function: {
                name: 'reasoning.stop',
                arguments: JSON.stringify(argumentsPayload)
              }
            }
          ]
        }
      }
    ]
  };
}

function buildCompletedSsotAssessment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    work_type: 'bug_fix',
    is_best_fix_point: true,
    rationale: 'stop contract 是唯一收口点，能在停止前统一约束真源判断。',
    ...overrides
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

function setStoplessMode(sessionId: string, mode: 'on' | 'off' | 'endless'): void {
  const stickyKey = `session:${sessionId}`;
  const existing = loadRoutingInstructionStateSync(stickyKey);
  const next = existing ?? createEmptyRoutingInstructionState();
  next.reasoningStopMode = mode;
  if (mode === 'off') {
    next.reasoningStopArmed = undefined;
    next.reasoningStopSummary = undefined;
    next.reasoningStopUpdatedAt = undefined;
  }
  saveRoutingInstructionStateSync(stickyKey, next);
}

describe('servertool reasoning.stop guard', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
  });

  beforeEach(() => {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    process.env.ROUTECODEX_REASONING_STOP_MODE = "on";
    process.env.RCC_REASONING_STOP_MODE = "on";
  });

  test('is enabled by default (session switch default on)', async () => {
    process.env.ROUTECODEX_REASONING_STOP_MODE = "off";
    process.env.RCC_REASONING_STOP_MODE = "off";
    const adapterContext = {
      sessionId: 'reasoning-stop-default-off'
    } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse: buildStopResponse('阶段完成'),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_default_on'
    });

    expect(result.execution?.flowId).not.toBe('reasoning_stop_guard_flow');
    const persisted = loadRoutingInstructionStateSync('session:reasoning-stop-default-off');
    expect((persisted as RoutingInstructionState | null | undefined)?.reasoningStopMode).toBeUndefined();
  });

  test('intercepts stop and injects servertool followup when reasoning.stop state is missing', async () => {
    const sessionId = 'reasoning-stop-guard-s1';
    setStoplessMode(sessionId, 'on');
    const adapterContext = {
      sessionId
    } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse: buildStopResponse('阶段完成'),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_guard_missing'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_guard_flow');
    const followup = result.execution?.followup as
      | {
          metadata?: Record<string, unknown>;
          injection?: { ops?: Array<Record<string, unknown>> };
        }
      | undefined;
    expect(followup?.metadata?.clientInjectOnly).toBeUndefined();
    expect(followup?.injection?.ops).toEqual(
      expect.arrayContaining([
        { op: 'preserve_tools' },
        { op: 'ensure_standard_tools' },
        { op: 'append_assistant_message', required: false },
        expect.objectContaining({
          op: 'append_user_text'
        })
      ])
    );
    expect(
      followup?.injection?.ops?.some((op) => op && (op as { op?: string }).op === 'append_tool_if_missing')
    ).toBe(false);
    const lastOp = followup?.injection?.ops?.[followup.injection.ops.length - 1];
    expect(lastOp).toEqual(expect.objectContaining({ op: 'append_user_text' }));
    expect(String((lastOp as any)?.text || '')).toContain('reasoning.stop');
  });

  test('reasoning_stop_guard followup does not replay assistant textual tool transport markup into next hop history', async () => {
    const sessionId = 'reasoning-stop-guard-dsml-textual-tool';
    setStoplessMode(sessionId, 'on');
    let capturedFollowupBody: Record<string, unknown> | null = null;

    const orchestration = await runServerToolOrchestration({
      chat: {
        id: 'chatcmpl_reasoning_stop_dsml_textual',
        object: 'chat.completion',
        model: 'mimo-v2.5-pro',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content:
                '<｜DSML│tool_calls>\n' +
                '  <│DSML│invoke name="exec_command">\n' +
                '    <│DSML│parameter name="cmd"><![CDATA[pwd]]></│DSML│parameter>\n' +
                '  </│DSML│invoke>\n' +
                '</│DSML│tool_calls>'
            }
          }
        ]
      } as JsonObject,
      adapterContext: {
        sessionId,
        capturedChatRequest: {
          model: 'mimo-v2.5-pro',
          messages: [{ role: 'user', content: '继续' }],
          tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }]
        }
      } as unknown as AdapterContext,
      requestId: 'req_reasoning_stop_guard_dsml_textual',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async (opts: any) => {
        capturedFollowupBody = opts.body;
        return {
          body: {
            id: 'resp_reasoning_stop_guard_dsml_textual',
            object: 'response',
            model: 'mimo-v2.5-pro',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }]
          } as JsonObject
        };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('reasoning_stop_guard_flow');
    const messages = Array.isArray(capturedFollowupBody?.messages) ? (capturedFollowupBody?.messages as Array<Record<string, unknown>>) : [];
    expect(messages.some((message) => {
      const content = typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '');
      return /DSML|function_calls|RCC_TOOL_CALLS/i.test(content);
    })).toBe(false);
    expect(messages[messages.length - 1]?.role).toBe('user');
  });

  test('reasoning_stop_guard followup drops inherited output budget when rerouted to a different model', async () => {
    const sessionId = 'reasoning-stop-guard-reroute-max-tokens';
    setStoplessMode(sessionId, 'on');
    let capturedFollowupBody: Record<string, unknown> | null = null;

    const orchestration = await runServerToolOrchestration({
      chat: buildStopResponse('阶段完成') as JsonObject,
      adapterContext: {
        sessionId,
        assignedModelId: 'mimo-v2.5-pro',
        modelId: 'mimo-v2.5-pro',
        capturedChatRequest: {
          model: 'deepseek-v4-pro',
          messages: [{ role: 'user', content: '继续' }],
          tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }],
          parameters: {
            max_tokens: 384000,
            max_output_tokens: 384000
          }
        }
      } as unknown as AdapterContext,
      requestId: 'req_reasoning_stop_guard_reroute_max_tokens',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async (opts: any) => {
        capturedFollowupBody = opts.body;
        return {
          body: {
            id: 'resp_reasoning_stop_guard_reroute_max_tokens',
            object: 'response',
            model: 'mimo-v2.5-pro',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }]
          } as JsonObject
        };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('reasoning_stop_guard_flow');
    expect(capturedFollowupBody?.model).toBe('mimo-v2.5-pro');
    expect(capturedFollowupBody?.parameters).toBeUndefined();
    expect((capturedFollowupBody as Record<string, unknown> | null)?.max_tokens).toBeUndefined();
    expect((capturedFollowupBody as Record<string, unknown> | null)?.max_output_tokens).toBeUndefined();
  });

  test('reasoning_stop_guard followup drops inherited output budget even when followup stays on same model', async () => {
    const sessionId = 'reasoning-stop-guard-same-model-max-tokens';
    setStoplessMode(sessionId, 'on');
    let capturedFollowupBody: Record<string, unknown> | null = null;

    const orchestration = await runServerToolOrchestration({
      chat: buildStopResponse('阶段完成') as JsonObject,
      adapterContext: {
        sessionId,
        assignedModelId: 'mimo-v2.5-pro',
        modelId: 'mimo-v2.5-pro',
        capturedChatRequest: {
          model: 'mimo-v2.5-pro',
          messages: [{ role: 'user', content: '继续' }],
          tools: [{ type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }],
          parameters: {
            max_tokens: 384000,
            max_output_tokens: 384000,
            temperature: 0.2
          }
        }
      } as unknown as AdapterContext,
      requestId: 'req_reasoning_stop_guard_same_model_max_tokens',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async (opts: any) => {
        capturedFollowupBody = opts.body;
        return {
          body: {
            id: 'resp_reasoning_stop_guard_same_model_max_tokens',
            object: 'response',
            model: 'mimo-v2.5-pro',
            status: 'completed',
            output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }]
          } as JsonObject
        };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('reasoning_stop_guard_flow');
    expect(capturedFollowupBody?.model).toBe('mimo-v2.5-pro');
    expect(capturedFollowupBody?.parameters).toEqual({ temperature: 0.2 });
    expect((capturedFollowupBody as Record<string, unknown> | null)?.max_tokens).toBeUndefined();
    expect((capturedFollowupBody as Record<string, unknown> | null)?.max_output_tokens).toBeUndefined();
  });

  test('endless mode injects strict anti-stop prompt', async () => {
    const sessionId = 'reasoning-stop-guard-endless-s1';
    setStoplessMode(sessionId, 'endless');
    const adapterContext = {
      sessionId
    } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse: buildStopResponse('阶段完成'),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_guard_endless'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_guard_flow');
    const followup = result.execution?.followup as
      | {
          injection?: { ops?: Array<Record<string, unknown>> };
        }
      | undefined;
    const lastOp = followup?.injection?.ops?.[followup.injection.ops.length - 1];
    expect(lastOp).toEqual(
      expect.objectContaining({
        op: 'append_user_text'
      })
    );
    expect(String((lastOp as any)?.text || '')).toContain('stopless:endless');
    expect(String((lastOp as any)?.text || '')).toContain('不得停止');
  });

  test('fails fast when reasoning_stop_guard followup cannot build payload (missing seed)', async () => {
    const sessionId = 'reasoning-stop-guard-missing-seed';
    setStoplessMode(sessionId, 'on');
    const adapterContext = {
      sessionId
    } as unknown as AdapterContext;

    await expect(
      runServerToolOrchestration({
        chat: buildStopResponse('阶段完成'),
        adapterContext,
        requestId: 'req_reasoning_stop_guard_missing_seed',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        reenterPipeline: async () => ({
          body: {
            id: 'should-not-run'
          } as JsonObject
        })
      })
    ).rejects.toMatchObject({
      code: 'SERVERTOOL_FOLLOWUP_FAILED',
      details: {
        flowId: 'reasoning_stop_guard_flow',
        reason: 'followup_payload_missing'
      }
    });
  });

  test('does not skip unarmed guard without seed for response orchestration path', async () => {
    const sessionId = 'reasoning-stop-guard-response-orchestration-no-seed';
    setStoplessMode(sessionId, 'on');
    const result = await runServerSideToolEngine({
      chatResponse: buildStopResponse('阶段完成'),
      adapterContext: {
        sessionId,
        __rt: {
          servertoolResponseOrchestration: true
        }
      } as unknown as AdapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_guard_response_orchestration_no_seed'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_guard_flow');
  });

  test('reasoning_stop_guard followup keeps original providerKey pinned', async () => {
    const sessionId = 'reasoning-stop-guard-provider-pin';
    setStoplessMode(sessionId, 'on');
    let capturedFollowupMeta: Record<string, unknown> | null = null;

    const orchestration = await runServerToolOrchestration({
      chat: buildStopResponse('阶段完成'),
      adapterContext: {
        sessionId,
        providerKey: 'ali-coding-plan.key1.qwen3.6-plus',
        capturedChatRequest: {
          model: 'qwen3.6-plus',
          messages: [{ role: 'user', content: '继续' }]
        }
      } as unknown as AdapterContext,
      requestId: 'req_reasoning_stop_guard_provider_pin',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async (opts: any) => {
        capturedFollowupMeta =
          opts?.metadata && typeof opts.metadata === 'object'
            ? (opts.metadata as Record<string, unknown>)
            : null;
        return {
          body: buildStopResponse('继续执行')
        };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('reasoning_stop_guard_flow');
    expect((capturedFollowupMeta as any)?.__shadowCompareForcedProviderKey).toBe(
      'ali-coding-plan.key1.qwen3.6-plus'
    );
  });

  test('reasoning_stop_continue followup resolves provider pin from target.providerKey', async () => {
    const sessionId = 'reasoning-stop-continue-target-provider-pin';
    const stickyKey = `session:${sessionId}`;
    const state = createEmptyRoutingInstructionState();
    state.reasoningStopMode = 'on';
    state.reasoningStopArmed = true;
    state.reasoningStopSummary = '用户任务目标: A\n是否完成: 否\n下一步: 继续检查日志并执行下一步';
    state.reasoningStopUpdatedAt = Date.now();
    saveRoutingInstructionStateSync(stickyKey, state);

    let capturedFollowupMeta: Record<string, unknown> | null = null;
    const orchestration = await runServerToolOrchestration({
      chat: buildStopResponse('先停一下'),
      adapterContext: {
        sessionId,
        target: {
          providerKey: 'ali-coding-plan.key1.kimi-k2.5'
        },
        capturedChatRequest: {
          model: 'kimi-k2.5',
          messages: [{ role: 'user', content: '继续' }]
        }
      } as unknown as AdapterContext,
      requestId: 'req_reasoning_stop_continue_target_provider_pin',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async (opts: any) => {
        capturedFollowupMeta =
          opts?.metadata && typeof opts.metadata === 'object'
            ? (opts.metadata as Record<string, unknown>)
            : null;
        return {
          body: buildStopResponse('继续执行')
        };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('reasoning_stop_continue_flow');
    expect((capturedFollowupMeta as any)?.__shadowCompareForcedProviderKey).toBe(
      'ali-coding-plan.key1.kimi-k2.5'
    );
  });

  test('reasoning.stop generic followup keeps original providerKey pinned', async () => {
    const sessionId = 'reasoning-stop-tool-followup-provider-pin';
    let capturedFollowupMeta: Record<string, unknown> | null = null;

    const orchestration = await runServerToolOrchestration({
      chat: buildReasoningStopToolCallResponse({ task_goal: 'A', is_completed: false, next_step: '继续执行下一步' }) as any,
      adapterContext: {
        sessionId,
        providerKey: 'deepseek-web.1.deepseek-reasoner',
        capturedChatRequest: {
          model: 'deepseek-reasoner',
          messages: [{ role: 'user', content: '继续执行' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'reasoning.stop',
                parameters: {
                  type: 'object',
                  properties: {},
                  additionalProperties: true
                }
              }
            }
          ]
        }
      } as unknown as AdapterContext,
      requestId: 'req_reasoning_stop_tool_followup_provider_pin',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async (opts: any) => {
        capturedFollowupMeta =
          opts?.metadata && typeof opts.metadata === 'object'
            ? (opts.metadata as Record<string, unknown>)
            : null;
        return { body: buildStopResponse('继续执行') };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('reasoning_stop_continue_flow');
    expect((capturedFollowupMeta as any)?.__shadowCompareForcedProviderKey).toBe(
      'deepseek-web.1.deepseek-reasoner'
    );
  });

  test('reasoning_stop_guard followup pins provider when adapterContext comes from normalized target metadata', async () => {
    const sessionId = 'reasoning-stop-guard-built-adapter-provider-pin';
    setStoplessMode(sessionId, 'on');
    let capturedFollowupMeta: Record<string, unknown> | null = null;

    const adapterContext = __unsafeBuildAdapterContextForTest(
      {
        id: 'req_reasoning_stop_guard_built_adapter_provider_pin',
        endpoint: '/v1/responses',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        payload: {},
        metadata: {
          sessionId
        },
        processMode: 'chat',
        direction: 'request',
        stage: 'outbound',
        stream: false
      } as any,
      {
        providerKey: 'deepseek-web.2.deepseek-reasoner',
        outboundProfile: 'openai-responses'
      } as any
    ) as AdapterContext;

    (adapterContext as any).capturedChatRequest = {
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: '继续' }]
    };

    const orchestration = await runServerToolOrchestration({
      chat: buildStopResponse('阶段完成'),
      adapterContext,
      requestId: 'req_reasoning_stop_guard_built_adapter_provider_pin',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async (opts: any) => {
        capturedFollowupMeta =
          opts?.metadata && typeof opts.metadata === 'object'
            ? (opts.metadata as Record<string, unknown>)
            : null;
        return {
          body: buildStopResponse('继续执行')
        };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('reasoning_stop_guard_flow');
    expect((adapterContext as any).providerKey).toBe('deepseek-web.2.deepseek-reasoner');
    expect((adapterContext as any).targetProviderKey).toBe('deepseek-web.2.deepseek-reasoner');
    expect((capturedFollowupMeta as any)?.__shadowCompareForcedProviderKey).toBe(
      'deepseek-web.2.deepseek-reasoner'
    );
  });

  test('reasoning_stop_guard followup overrides stale forced provider pin with current providerKey', async () => {
    const sessionId = 'reasoning-stop-guard-provider-pin-override';
    setStoplessMode(sessionId, 'on');
    let capturedFollowupMeta: Record<string, unknown> | null = null;

    const orchestration = await runServerToolOrchestration({
      chat: buildStopResponse('阶段完成'),
      adapterContext: {
        sessionId,
        providerKey: 'deepseek-web.1.deepseek-reasoner',
        capturedChatRequest: {
          model: 'deepseek-reasoner',
          messages: [{ role: 'user', content: '继续' }]
        }
      } as unknown as AdapterContext,
      requestId: 'req_reasoning_stop_guard_provider_pin_override',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async (opts: any) => {
        capturedFollowupMeta =
          opts?.metadata && typeof opts.metadata === 'object'
            ? (opts.metadata as Record<string, unknown>)
            : null;
        return {
          body: buildStopResponse('继续执行')
        };
      }
    });

    expect(orchestration.executed).toBe(true);
    expect(orchestration.flowId).toBe('reasoning_stop_guard_flow');
    expect((capturedFollowupMeta as any)?.__shadowCompareForcedProviderKey).toBe(
      'deepseek-web.1.deepseek-reasoner'
    );
  });

  test('reasoning.stop tool call arms session state', async () => {
    const sessionId = 'reasoning-stop-guard-s2';
    const adapterContext = {
      sessionId
    } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse: buildReasoningStopToolCallResponse({
        task_goal: '修复 qwen stop 异常',
        is_completed: false,
        cannot_complete_reason: '需要更多样本',
        attempts_exhausted: true,
        blocking_evidence: '已检查最近 20 分钟样本，均缺少完整上下文'
      }),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_tool_call'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_finalize_flow');
    const state = loadRoutingInstructionStateSync(`session:${sessionId}`);
    expect(state?.reasoningStopArmed).toBeUndefined();
    expect(state?.reasoningStopSummary).toBeUndefined();
    const message = (result.finalChatResponse as any).choices?.[0]?.message;
    expect(String(message?.content || '')).toContain('[app.finished:reasoning.stop]');
    expect(String(message?.content || '')).toContain('已穷尽可行尝试: 是');
  });

  test('reasoning.stop summary preserves stop_reason=plan_mode for read-only plan tasks', async () => {
    const sessionId = 'reasoning-stop-plan-mode-s1';
    const adapterContext = {
      sessionId
    } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse: buildReasoningStopToolCallResponse({
        task_goal: '审计当前 routing 配置并给出收口方案',
        is_completed: true,
        stop_reason: 'plan_mode',
        completion_evidence: '已完成只读审计，并给出最终计划与配置建议',
        ssot_assessment: {
          work_type: 'analysis_only',
          rationale: '本次是只读审计任务，没有新增实现点或修复点，结论应收口在 stop 真源说明。'
        }
      }),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_plan_mode'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_finalize_flow');
    const state = loadRoutingInstructionStateSync(`session:${sessionId}`);
    expect(state?.reasoningStopSummary).toBeUndefined();
    const message = (result.finalChatResponse as any).choices?.[0]?.message;
    expect(String(message?.content || '')).toContain('停止原因: plan_mode');
    expect(String(message?.content || '')).toContain('[app.finished:reasoning.stop]');
  });

  test('accepts <**stopless:on/off**> directive and binds it to session', async () => {
    const sessionId = 'reasoning-stop-switch-by-directive';
    const adapterContextOn = {
      sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [
          {
            role: 'user',
            content: '开启 stopless 模式 <**stopless:on**>'
          }
        ]
      }
    } as unknown as AdapterContext;
    const onResult = await runServerSideToolEngine({
      chatResponse: buildStopResponse('阶段完成'),
      adapterContext: adapterContextOn,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_switch_on'
    });
    expect(onResult.mode).toBe('tool_flow');
    expect(onResult.execution?.flowId).toBe('reasoning_stop_guard_flow');
    expect(loadRoutingInstructionStateSync(`session:${sessionId}`)?.reasoningStopMode).toBe('on');
    expect(String((adapterContextOn as any).capturedChatRequest?.messages?.[0]?.content || '')).toBe('开启 stopless 模式');

    const adapterContextOff = {
      sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [
          {
            role: 'user',
            content: '关闭 stopless 模式 <**stopless:off**>'
          }
        ]
      }
    } as unknown as AdapterContext;
    const offResult = await runServerSideToolEngine({
      chatResponse: buildStopResponse('阶段完成'),
      adapterContext: adapterContextOff,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_switch_off'
    });
    expect(offResult.mode).toBe('passthrough');
    expect(offResult.execution).toBeUndefined();
    expect(loadRoutingInstructionStateSync(`session:${sessionId}`)?.reasoningStopMode).toBe('off');
    expect(String((adapterContextOff as any).capturedChatRequest?.messages?.[0]?.content || '')).toBe('关闭 stopless 模式');
  });

  test('accepts <**stopless:endless**> directive and binds it to session', async () => {
    const sessionId = 'reasoning-stop-switch-endless-by-directive';
    const adapterContext = {
      sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [
          {
            role: 'user',
            content: '开启极限模式 <**stopless:endless**>'
          }
        ]
      }
    } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse: buildStopResponse('阶段完成'),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_switch_endless'
    });
    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_guard_flow');
    expect(loadRoutingInstructionStateSync(`session:${sessionId}`)?.reasoningStopMode).toBe('endless');
    expect(String((adapterContext as any).capturedChatRequest?.messages?.[0]?.content || '')).toBe('开启极限模式');
  });

  test('does not persist stopless directive when session scope is missing, and default-on still intercepts stop', async () => {
    process.env.ROUTECODEX_REASONING_STOP_MODE = "off";
    process.env.RCC_REASONING_STOP_MODE = "off";
    const adapterContext = {
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [
          {
            role: 'user',
            content: '开启 stopless <**stopless:on**>'
          }
        ]
      }
    } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse: buildStopResponse('阶段完成'),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_switch_no_session'
    });
    expect(result.execution?.flowId).not.toBe('reasoning_stop_guard_flow');
    expect(String((adapterContext as any).capturedChatRequest?.messages?.[0]?.content || '')).toBe('开启 stopless');
  });

  test('strips malformed stopless marker even when directive parse fails, and default-on intercepts', async () => {
    process.env.ROUTECODEX_REASONING_STOP_MODE = "off";
    process.env.RCC_REASONING_STOP_MODE = "off";
    const sessionId = 'reasoning-stop-switch-strip-invalid-marker';
    const stickyKey = `session:${sessionId}`;
    saveRoutingInstructionStateSync(stickyKey, null);
    const adapterContext = {
      sessionId,
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [
          {
            role: 'user',
            content: '测试标记清理 <**stopless:invalid_mode**>'
          }
        ]
      }
    } as unknown as AdapterContext;

    const result = await runServerSideToolEngine({
      chatResponse: buildStopResponse('阶段完成'),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_strip_invalid_marker'
    });
    expect(result.execution?.flowId).not.toBe('reasoning_stop_guard_flow');
    expect(loadRoutingInstructionStateSync(stickyKey)?.reasoningStopMode).toBeUndefined();
    expect(String((adapterContext as any).capturedChatRequest?.messages?.[0]?.content || '')).toBe('测试标记清理');
  });

  test('returns structured error when reasoning.stop payload misses task_goal', async () => {
    const sessionId = 'reasoning-stop-guard-invalid-missing-goal';
    const adapterContext = {
      sessionId
    } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse: buildReasoningStopToolCallResponse({
        is_completed: false,
        cannot_complete_reason: '需要更多上下文'
      }),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_invalid_missing_goal'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_continue_flow');
    const outputs = (result.finalChatResponse as any).tool_outputs;
    expect(Array.isArray(outputs)).toBe(true);
    const last = outputs[outputs.length - 1];
    const payload = JSON.parse(String(last.content || '{}'));
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('TASK_GOAL_REQUIRED');
    expect(typeof payload.message).toBe('string');

    const state = loadRoutingInstructionStateSync(`session:${sessionId}`);
    expect(state?.reasoningStopArmed).not.toBe(true);
    expect(state?.reasoningStopSummary).toBeUndefined();
  });

  test('returns structured error when reasoning.stop payload misses completion evidence', async () => {
    const sessionId = 'reasoning-stop-guard-invalid-missing-evidence';
    const adapterContext = {
      sessionId
    } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse: buildReasoningStopToolCallResponse({
        task_goal: '完成接口迁移',
        is_completed: true
      }),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_invalid_missing_evidence'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_continue_flow');
    const outputs = (result.finalChatResponse as any).tool_outputs;
    expect(Array.isArray(outputs)).toBe(true);
    const last = outputs[outputs.length - 1];
    const payload = JSON.parse(String(last.content || '{}'));
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('COMPLETION_EVIDENCE_REQUIRED');
    expect(typeof payload.message).toBe('string');

    const state = loadRoutingInstructionStateSync(`session:${sessionId}`);
    expect(state?.reasoningStopArmed).not.toBe(true);
    expect(state?.reasoningStopSummary).toBeUndefined();
  });

  test('returns structured error when completed reasoning.stop payload misses ssot_assessment', async () => {
    const sessionId = 'reasoning-stop-guard-invalid-missing-ssot';
    const adapterContext = { sessionId } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse: buildReasoningStopToolCallResponse({
        task_goal: '完成 stop contract 改造',
        is_completed: true,
        completion_evidence: '已修改 stop contract 并补回归'
      }),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_invalid_missing_ssot'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_continue_flow');
    const outputs = (result.finalChatResponse as any).tool_outputs;
    const last = outputs[outputs.length - 1];
    const payload = JSON.parse(String(last.content || '{}'));
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('SSOT_ASSESSMENT_REQUIRED');
  });

  test('returns structured error when completed feature stop omits unique implementation assertion', async () => {
    const sessionId = 'reasoning-stop-guard-invalid-feature-unique';
    const adapterContext = { sessionId } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse: buildReasoningStopToolCallResponse({
        task_goal: '新增 stop 真源合约',
        is_completed: true,
        completion_evidence: '已新增 shared contract 文件',
        ssot_assessment: {
          work_type: 'feature_impl',
          rationale: '该实现位于 servertool stop 真源。'
        }
      }),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_invalid_feature_unique'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_continue_flow');
    const outputs = (result.finalChatResponse as any).tool_outputs;
    const last = outputs[outputs.length - 1];
    const payload = JSON.parse(String(last.content || '{}'));
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('SSOT_UNIQUE_IMPLEMENTATION_REQUIRED');
  });

  test('returns structured error when completed bug-fix stop omits best-fix assertion', async () => {
    const sessionId = 'reasoning-stop-guard-invalid-bug-best-fix';
    const adapterContext = { sessionId } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse: buildReasoningStopToolCallResponse({
        task_goal: '修复 stop 合约缺失校验',
        is_completed: true,
        completion_evidence: '已新增结构化 ssot 校验',
        ssot_assessment: {
          work_type: 'bug_fix',
          rationale: '该修复位于 stop 真源入口。'
        }
      }),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_invalid_bug_best_fix'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_continue_flow');
    const outputs = (result.finalChatResponse as any).tool_outputs;
    const last = outputs[outputs.length - 1];
    const payload = JSON.parse(String(last.content || '{}'));
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('SSOT_BEST_FIX_POINT_REQUIRED');
  });

  test('on mode accepts user_input_required stop and records question in summary', async () => {
    const sessionId = 'reasoning-stop-guard-user-input-on-mode';
    setStoplessMode(sessionId, 'on');
    const adapterContext = { sessionId } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse: buildReasoningStopToolCallResponse({
        task_goal: '确认上线窗口',
        is_completed: false,
        cannot_complete_reason: '涉及生产变更，需要用户确认',
        blocking_evidence: '需要用户明确授权才能继续发布动作',
        attempts_exhausted: true,
        user_input_required: true,
        user_question: '请确认是否允许今晚 22:00 执行发布？'
      }),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_user_input_on_mode'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_finalize_flow');
    const message = (result.finalChatResponse as any).choices?.[0]?.message;
    expect(String(message?.content || '')).toContain('需用户参与: 是');
    expect(String(message?.content || '')).toContain('用户问题: 请确认是否允许今晚 22:00 执行发布？');
  });

  test('endless mode accepts irrecoverably blocked stop with user input', async () => {
    const sessionId = 'reasoning-stop-guard-user-input-endless-mode';
    setStoplessMode(sessionId, 'endless');
    const adapterContext = { sessionId } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse: buildReasoningStopToolCallResponse({
        task_goal: '确认上线窗口',
        is_completed: false,
        attempts_exhausted: true,
        cannot_complete_reason: '涉及生产变更，需要用户确认',
        blocking_evidence: '发布权限与时间窗口均受控，当前无法自行推进',
        user_input_required: true,
        user_question: '请确认是否允许今晚 22:00 执行发布？'
      }),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_user_input_endless_mode'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_finalize_flow');
    const message = (result.finalChatResponse as any).choices?.[0]?.message;
    expect(String(message?.content || '')).toContain('已穷尽可行尝试: 是');
    expect(String(message?.content || '')).toContain('阻塞证据: 发布权限与时间窗口均受控，当前无法自行推进');
    expect(String(message?.content || '')).toContain('需用户参与: 是');
  });

  test('returns structured error when reasoning.stop payload misses next_step and cannot_complete_reason', async () => {
    const sessionId = 'reasoning-stop-guard-invalid-missing-next-or-reason';
    const adapterContext = {
      sessionId
    } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse: buildReasoningStopToolCallResponse({
        task_goal: '继续分析日志',
        is_completed: false
      }),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_invalid_missing_next_or_reason'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_continue_flow');
    const outputs = (result.finalChatResponse as any).tool_outputs;
    expect(Array.isArray(outputs)).toBe(true);
    const last = outputs[outputs.length - 1];
    const payload = JSON.parse(String(last.content || '{}'));
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('NEXT_STEP_OR_CANNOT_COMPLETE_REQUIRED');
  });

  test('returns structured error when reasoning.stop uses cannot_complete_reason without attempts_exhausted=true', async () => {
    const sessionId = 'reasoning-stop-guard-invalid-attempts-exhausted';
    const adapterContext = { sessionId } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse: buildReasoningStopToolCallResponse({
        task_goal: '继续分析日志',
        is_completed: false,
        cannot_complete_reason: '上游 429 持续'
      }),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_invalid_attempts_exhausted'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_continue_flow');
    const outputs = (result.finalChatResponse as any).tool_outputs;
    expect(Array.isArray(outputs)).toBe(true);
    const last = outputs[outputs.length - 1];
    const payload = JSON.parse(String(last.content || '{}'));
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('ATTEMPTS_EXHAUSTED_REQUIRED');
  });

  test('returns structured error when reasoning.stop uses cannot_complete_reason without blocking_evidence', async () => {
    const sessionId = 'reasoning-stop-guard-invalid-blocking-evidence';
    const adapterContext = { sessionId } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse: buildReasoningStopToolCallResponse({
        task_goal: '继续分析日志',
        is_completed: false,
        cannot_complete_reason: '上游 429 持续',
        attempts_exhausted: true
      }),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_invalid_blocking_evidence'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_continue_flow');
    const outputs = (result.finalChatResponse as any).tool_outputs;
    expect(Array.isArray(outputs)).toBe(true);
    const last = outputs[outputs.length - 1];
    const payload = JSON.parse(String(last.content || '{}'));
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe('BLOCKING_EVIDENCE_REQUIRED');
  });

  test('when armed summary has next step, guard injects followup to execute next step', async () => {
    const sessionId = 'reasoning-stop-guard-next-step-continue';
    const stickyKey = `session:${sessionId}`;
    const state = createEmptyRoutingInstructionState();
    state.reasoningStopMode = 'on';
    state.reasoningStopArmed = true;
    state.reasoningStopSummary = '用户任务目标: A\n是否完成: 否\n下一步: 检查 daemon 日志并定位阻塞点';
    state.reasoningStopUpdatedAt = Date.now();
    saveRoutingInstructionStateSync(stickyKey, state);

    const adapterContext = { sessionId } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse: buildStopResponse('先停一下'),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_continue'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_continue_flow');
    const followup = result.execution?.followup as
      | {
          metadata?: Record<string, unknown>;
          injection?: { ops?: Array<Record<string, unknown>> };
        }
      | undefined;
    const lastOp = followup?.injection?.ops?.[followup.injection.ops.length - 1];
    expect(lastOp).toEqual(
      expect.objectContaining({
        op: 'append_user_text'
      })
    );
    expect(String((lastOp as any)?.text || '')).toContain('next_step: 检查 daemon 日志并定位阻塞点');
    expect(
      followup?.injection?.ops?.some((op) => op && (op as { op?: string }).op === 'replace_tools')
    ).toBe(false);
    expect(followup?.injection?.ops).toEqual(
      expect.arrayContaining([
        { op: 'preserve_tools' },
        { op: 'ensure_standard_tools' }
      ])
    );
    // continue path should keep state armed until a completed/blocked finalize happens
    const persisted = loadRoutingInstructionStateSync(stickyKey);
    expect(persisted?.reasoningStopArmed).toBe(true);
  });

  test('reasoning_stop_continue followup 429 fails fast instead of soft-skipping', async () => {
    const sessionId = 'reasoning-stop-guard-next-step-followup-429';
    const stickyKey = `session:${sessionId}`;
    const state = createEmptyRoutingInstructionState();
    state.reasoningStopMode = 'on';
    state.reasoningStopArmed = true;
    state.reasoningStopSummary = '用户任务目标: A\n是否完成: 否\n下一步: 继续检查日志并执行下一步';
    state.reasoningStopUpdatedAt = Date.now();
    saveRoutingInstructionStateSync(stickyKey, state);

    await expect(
      runServerToolOrchestration({
        chat: buildStopResponse('先停一下'),
        adapterContext: {
          sessionId,
          capturedChatRequest: {
            model: 'gpt-test',
            messages: [{ role: 'user', content: '继续' }]
          }
        } as unknown as AdapterContext,
        requestId: 'req_reasoning_stop_continue_followup_429',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        reenterPipeline: async () => {
          const error = new Error('followup 429') as Error & {
            code?: string;
            status?: number;
            statusCode?: number;
            upstreamCode?: string;
            details?: Record<string, unknown>;
          };
          error.code = 'SERVERTOOL_FOLLOWUP_FAILED';
          error.status = 429;
          error.statusCode = 429;
          error.upstreamCode = 'HTTP_429';
          error.details = {
            upstreamCode: 'HTTP_429',
            reason: 'followup_http_429'
          };
          throw error;
        }
      })
    ).rejects.toMatchObject({
      code: 'SERVERTOOL_FOLLOWUP_FAILED',
      status: 429,
      upstreamCode: 'HTTP_429',
      details: expect.objectContaining({
        flowId: 'reasoning_stop_continue_flow'
      })
    });

    const persisted = loadRoutingInstructionStateSync(stickyKey);
    expect(persisted?.reasoningStopArmed).toBe(true);
  });

  test('reasoning_stop_continue auto-limit fails fast instead of pretending completion', async () => {
    const sessionId = 'reasoning-stop-guard-next-step-auto-limit';
    const stickyKey = `session:${sessionId}`;
    const state = createEmptyRoutingInstructionState();
    state.reasoningStopMode = 'on';
    state.reasoningStopArmed = true;
    state.reasoningStopSummary = '用户任务目标: A\n是否完成: 否\n下一步: 继续检查日志并执行下一步';
    state.reasoningStopUpdatedAt = Date.now();
    saveRoutingInstructionStateSync(stickyKey, state);

    await expect(
      runServerToolOrchestration({
        chat: buildStopResponse('先停一下'),
        adapterContext: {
          sessionId,
          capturedChatRequest: {
            model: 'gpt-test',
            messages: [{ role: 'user', content: '继续' }]
          },
          __rt: {
            serverToolLoopState: {
              flowId: 'reasoning_stop_continue_flow',
              payloadHash: '__servertool_auto__',
              repeatCount: 2,
              startedAtMs: Date.now()
            }
          }
        } as unknown as AdapterContext,
        requestId: 'req_reasoning_stop_continue_auto_limit',
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        reenterPipeline: async () => ({
          body: buildStopResponse('先停一下')
        })
      })
    ).rejects.toMatchObject({
      code: 'SERVERTOOL_FOLLOWUP_FAILED',
      status: 502,
      details: expect.objectContaining({
        flowId: 'reasoning_stop_continue_flow',
        reason: 'followup_auto_limit_hit'
      })
    });

    const persisted = loadRoutingInstructionStateSync(stickyKey);
    expect(persisted?.reasoningStopArmed).toBe(true);
  });

  test('on mode allows finalize stop when summary asks for user input', async () => {
    const sessionId = 'reasoning-stop-guard-user-input-finalize';
    const stickyKey = `session:${sessionId}`;
    const state = createEmptyRoutingInstructionState();
    state.reasoningStopMode = 'on';
    state.reasoningStopArmed = true;
    state.reasoningStopSummary =
      '用户任务目标: A\n是否完成: 否\n需用户参与: 是\n用户问题: 需要你确认是否继续执行高风险操作？\n已穷尽可行尝试: 是\n无法完成原因: 当前步骤涉及高风险变更\n阻塞证据: 缺少审批，系统拒绝执行';
    state.reasoningStopUpdatedAt = Date.now();
    saveRoutingInstructionStateSync(stickyKey, state);

    const adapterContext = { sessionId } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse: buildStopResponse('请你确认一下'),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_user_input_finalize'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_finalize_flow');
    expect(result.execution?.followup).toBeUndefined();
    const message = (result.finalChatResponse as any).choices?.[0]?.message;
    expect(message?.content).toContain('[reasoning.stop]');
    expect(message?.content).toContain('[app.finished:reasoning.stop]');
    expect(message?.content).toContain('需用户参与: 是');
    expect(message?.content).toContain('已穷尽可行尝试: 是');
    const cleared = loadRoutingInstructionStateSync(stickyKey);
    expect(cleared?.reasoningStopArmed).toBeUndefined();
    expect(cleared?.reasoningStopSummary).toBeUndefined();
  });

  test('endless mode allows finalize stop on irrecoverable blocking without user input', async () => {
    const sessionId = 'reasoning-stop-guard-endless-blocked-finalize';
    const stickyKey = `session:${sessionId}`;
    const state = createEmptyRoutingInstructionState();
    state.reasoningStopMode = 'endless';
    state.reasoningStopArmed = true;
    state.reasoningStopSummary =
      '用户任务目标: 连接外部私有仓库\n是否完成: 否\n已穷尽可行尝试: 是\n无法完成原因: 当前环境缺少访问凭证且无法自动获取\n阻塞证据: git 与 API 均返回认证失败';
    state.reasoningStopUpdatedAt = Date.now();
    saveRoutingInstructionStateSync(stickyKey, state);

    const adapterContext = { sessionId } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse: buildStopResponse('无法继续'),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_endless_blocked_finalize'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_finalize_flow');
    expect(result.execution?.followup).toBeUndefined();
    const message = (result.finalChatResponse as any).choices?.[0]?.message;
    expect(message?.content).toContain('[reasoning.stop]');
    expect(message?.content).toContain('[app.finished:reasoning.stop]');
    expect(message?.content).toContain('已穷尽可行尝试: 是');
    expect(message?.content).toContain('阻塞证据: git 与 API 均返回认证失败');
    const cleared = loadRoutingInstructionStateSync(stickyKey);
    expect(cleared?.reasoningStopArmed).toBeUndefined();
    expect(cleared?.reasoningStopSummary).toBeUndefined();
  });

  test('allows real stop, appends summary, then clears reasoning.stop state', async () => {
    const sessionId = 'reasoning-stop-guard-s3';
    const stickyKey = `session:${sessionId}`;
    const state = createEmptyRoutingInstructionState();
    state.reasoningStopMode = 'on';
    state.reasoningStopArmed = true;
    state.reasoningStopSummary =
      '用户任务目标: A\n是否完成: 是\n完成证据: B\n工作类型: bug_fix\n是否最佳修复点: 是\n真源判断依据: stop 合约入口是唯一校验点。';
    state.reasoningStopUpdatedAt = Date.now();
    saveRoutingInstructionStateSync(stickyKey, state);

    const adapterContext = {
      sessionId
    } as unknown as AdapterContext;
    const result = await runServerSideToolEngine({
      chatResponse: buildStopResponse('已处理'),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_finalize'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_finalize_flow');
    expect(result.execution?.followup).toBeUndefined();
    const message = (result.finalChatResponse as any).choices?.[0]?.message;
    expect(message?.content).toContain('已处理');
    expect(message?.content).toContain('[reasoning.stop]');
    expect(message?.content).toContain('[app.finished:reasoning.stop]');
    expect(message?.content).toContain('完成证据: B');
    const cleared = loadRoutingInstructionStateSync(stickyKey);
    expect(cleared?.reasoningStopMode).toBe('on');
    expect(cleared?.reasoningStopArmed).toBeUndefined();
    expect(cleared?.reasoningStopSummary).toBeUndefined();
  });
});
