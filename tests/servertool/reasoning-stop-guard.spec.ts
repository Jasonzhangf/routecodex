import * as fs from 'node:fs';
import * as path from 'node:path';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
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
        text: '当前任务没有完成，请继续执行。请先调用 reasoning.stop 进行自查：任务目标、是否完成、完成证据或未完成原因。'
      }
    ]);
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
        cannot_complete_reason: '需要更多样本'
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
    expect(state?.reasoningStopSummary).toContain('无法完成原因: 需要更多样本');
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
