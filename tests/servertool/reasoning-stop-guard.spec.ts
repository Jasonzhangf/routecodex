import * as fs from 'node:fs';
import * as path from 'node:path';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
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
    reasoningStopArmed: undefined,
    reasoningStopSummary: undefined,
    reasoningStopUpdatedAt: undefined,
    preCommandSource: undefined,
    preCommandScriptPath: undefined,
    preCommandUpdatedAt: undefined
  };
}

describe('servertool reasoning.stop guard', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
  });

  beforeEach(() => {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  });

  test('intercepts stop and injects servertool followup when reasoning.stop state is missing', async () => {
    const adapterContext = {
      sessionId: 'reasoning-stop-guard-s1'
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
    expect(followup?.injection?.ops).toEqual([
      { op: 'preserve_tools' },
      { op: 'ensure_standard_tools' },
      { op: 'append_assistant_message', required: false },
      {
        op: 'append_user_text',
        text: '当前任务未完成，禁止直接停止。你必须先调用 reasoning.stop 做停止自检。只允许两种真实停止条件：1) 已完成用户任务，并给出 completion_evidence；2) 已尝试完所有可行路径且仍被阻塞，并给出 cannot_complete_reason + blocking_evidence（并声明 attempts_exhausted=true）。若仍有任何可执行下一步，必须填写 next_step 并继续执行，不得停止。'
      }
    ]);
  });

  test('fails fast when reasoning_stop_guard followup cannot build payload (missing seed)', async () => {
    const adapterContext = {
      sessionId: 'reasoning-stop-guard-missing-seed'
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
    expect(result.execution?.flowId).toBe('reasoning_stop_flow');
    const state = loadRoutingInstructionStateSync(`session:${sessionId}`);
    expect(state?.reasoningStopArmed).toBe(true);
    expect(state?.reasoningStopSummary).toContain('用户任务目标: 修复 qwen stop 异常');
    expect(state?.reasoningStopSummary).toContain('是否完成: 否');
    expect(state?.reasoningStopSummary).toContain('已穷尽可行尝试: 是');
    expect(state?.reasoningStopSummary).toContain('无法完成原因: 需要更多样本');
    expect(state?.reasoningStopSummary).toContain('阻塞证据: 已检查最近 20 分钟样本，均缺少完整上下文');
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
    expect(result.execution?.flowId).toBe('reasoning_stop_flow');
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
    expect(result.execution?.flowId).toBe('reasoning_stop_flow');
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
    expect(result.execution?.flowId).toBe('reasoning_stop_flow');
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
    expect(result.execution?.flowId).toBe('reasoning_stop_flow');
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
    expect(result.execution?.flowId).toBe('reasoning_stop_flow');
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
    const lastOp = followup?.injection?.ops?.[3];
    expect(lastOp).toEqual(
      expect.objectContaining({
        op: 'append_user_text'
      })
    );
    expect(String((lastOp as any)?.text || '')).toContain('next_step: 检查 daemon 日志并定位阻塞点');
    // continue path should keep state armed until a completed/blocked finalize happens
    const persisted = loadRoutingInstructionStateSync(stickyKey);
    expect(persisted?.reasoningStopArmed).toBe(true);
  });

  test('allows real stop, appends summary, then clears reasoning.stop state', async () => {
    const sessionId = 'reasoning-stop-guard-s3';
    const stickyKey = `session:${sessionId}`;
    const state = createEmptyRoutingInstructionState();
    state.reasoningStopArmed = true;
    state.reasoningStopSummary = '用户任务目标: A\n是否完成: 是\n完成证据: B';
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
    expect(message?.content).toContain('完成证据: B');
    const cleared = loadRoutingInstructionStateSync(stickyKey);
    expect(cleared).toBeNull();
  });
});
