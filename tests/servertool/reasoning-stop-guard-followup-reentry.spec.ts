import * as fs from 'node:fs';
import * as path from 'node:path';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import { appendReasoningStopSummaryToChatResponse } from '../../sharedmodule/llmswitch-core/src/servertool/handlers/reasoning-stop-guard-blocks.ts';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js';
import type { RoutingInstructionState } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-reasoning-stop-followup-reentry-sessions');

function buildStopResponse(content = 'done'): JsonObject {
  return {
    id: 'chatcmpl_reasoning_stop_followup',
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

function buildResponsesStopResponse(): JsonObject {
  return {
    created_at: 1777949419,
    id: 'resp_reasoning_stop_followup',
    object: 'response',
    output: [
      {
        id: 'message_req_1',
        role: 'assistant',
        status: 'completed',
        type: 'message',
        content: []
      }
    ],
    status: 'completed'
  };
}

function buildReasoningStopSummaryBlock(summary: string): string {
  return `[reasoning.stop]\n${summary}\n结束标记: [app.finished:reasoning.stop] {"tool":"reasoning.stop","completed":true}`;
}

function buildCompletedSummary(goal = 'A', evidence = 'B'): string {
  return [
    `用户任务目标: ${goal}`,
    '是否完成: 是',
    `完成证据: ${evidence}`,
    '工作类型: bug_fix',
    '是否最佳修复点: 是',
    '真源判断依据: 该修复位于 stop 真源校验入口，能避免下游重复补丁。'
  ].join('\n');
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

describe('reasoning_stop_guard followup reentry', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
  });

  beforeEach(() => {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  });

  test('does not bypass guard on servertool.reasoning_stop_guard followup hop', async () => {
    const sessionId = 'reasoning-stop-followup-reentry-guard';
    setStoplessMode(sessionId, 'on');
    const adapterContext = {
      sessionId,
      clientInjectSource: 'servertool.reasoning_stop_guard',
      __rt: {
        serverToolFollowup: true
      }
    } as unknown as AdapterContext;

    const result = await runServerSideToolEngine({
      chatResponse: buildStopResponse('再次停止'),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_followup_reentry_guard'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_guard_flow');
  });

  test('does not finalize reasoning_stop_continue followup from stale persisted summary only', async () => {
    const sessionId = 'reasoning-stop-followup-reentry-continue';
    const stickyKey = `session:${sessionId}`;
    const state = createEmptyRoutingInstructionState();
    state.reasoningStopMode = 'on';
    state.reasoningStopArmed = true;
    state.reasoningStopSummary = buildCompletedSummary();
    state.reasoningStopUpdatedAt = Date.now();
    saveRoutingInstructionStateSync(stickyKey, state);

    const adapterContext = {
      sessionId,
      clientInjectSource: 'servertool.reasoning_stop_continue',
      __rt: {
        serverToolFollowup: true
      }
    } as unknown as AdapterContext;

    const result = await runServerSideToolEngine({
      chatResponse: buildStopResponse('完成'),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_followup_reentry_continue'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_guard_flow');
  });

  test('does not finalize plain stopless summary when completed stop is missing completion evidence', async () => {
    const sessionId = 'reasoning-stop-followup-invalid-completed-summary';
    const stickyKey = `session:${sessionId}`;
    const state = createEmptyRoutingInstructionState();
    state.reasoningStopMode = 'on';
    state.reasoningStopArmed = true;
    state.reasoningStopSummary = '用户任务目标: A\n是否完成: 是';
    state.reasoningStopUpdatedAt = Date.now();
    saveRoutingInstructionStateSync(stickyKey, state);

    const adapterContext = {
      sessionId,
      clientInjectSource: 'servertool.reasoning_stop_continue',
      __rt: {
        serverToolFollowup: true
      }
    } as unknown as AdapterContext;

    const result = await runServerSideToolEngine({
      chatResponse: buildStopResponse('完成'),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_followup_invalid_completed_summary'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_guard_flow');
  });

  test('allows finalize on reasoning_stop_continue followup only when current turn carries fresh reasoning.stop summary block', async () => {
    const sessionId = 'reasoning-stop-followup-fresh-summary';
    const stickyKey = `session:${sessionId}`;
    const state = createEmptyRoutingInstructionState();
    state.reasoningStopMode = 'on';
    state.reasoningStopArmed = true;
    state.reasoningStopSummary = '用户任务目标: A\n是否完成: 否\n下一步: 继续';
    state.reasoningStopUpdatedAt = Date.now();
    saveRoutingInstructionStateSync(stickyKey, state);

    const adapterContext = {
      sessionId,
      clientInjectSource: 'servertool.reasoning_stop_continue',
      __rt: {
        serverToolFollowup: true
      }
    } as unknown as AdapterContext;

    const freshSummary = buildCompletedSummary();
    const result = await runServerSideToolEngine({
      chatResponse: buildStopResponse(buildReasoningStopSummaryBlock(freshSummary)),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      requestId: 'req_reasoning_stop_followup_fresh_summary'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('reasoning_stop_finalize_flow');
    const message = (result.finalChatResponse as any).choices?.[0]?.message;
    expect(String(message?.content || '')).toContain('完成证据: B');
    expect(String(message?.content || '')).toContain('[app.finished:reasoning.stop]');
  });

  test('appendReasoningStopSummaryToChatResponse writes stop marker into responses output message content', () => {
    const result = appendReasoningStopSummaryToChatResponse(
      buildResponsesStopResponse(),
      buildCompletedSummary()
    ) as any;
    const output = result.output;
    expect(Array.isArray(output)).toBe(true);
    const firstMessage = output?.[0];
    expect(firstMessage?.type).toBe('message');
    expect(Array.isArray(firstMessage?.content)).toBe(true);
    expect(firstMessage?.content?.[0]?.type).toBe('output_text');
    expect(String(firstMessage?.content?.[0]?.text || '')).toContain('[app.finished:reasoning.stop]');
    expect(String(result.output_text || '')).toContain('[app.finished:reasoning.stop]');
  });

  test('orchestration finalizes responses followup only when reenter body carries fresh reasoning.stop summary block', async () => {
    const sessionId = 'reasoning-stop-followup-empty-responses-body';
    const stickyKey = `session:${sessionId}`;
    const state = createEmptyRoutingInstructionState();
    state.reasoningStopMode = 'on';
    state.reasoningStopArmed = true;
    state.reasoningStopSummary = buildCompletedSummary();
    state.reasoningStopUpdatedAt = Date.now();
    saveRoutingInstructionStateSync(stickyKey, state);

    const { runServerToolOrchestration } = await import('../../sharedmodule/llmswitch-core/src/servertool/engine.js');

    const initialResponsesBody = buildResponsesStopResponse() as any;
    initialResponsesBody.output = [
      {
        id: 'message_req_1',
        role: 'assistant',
        status: 'completed',
        type: 'message',
        content: [{ type: 'output_text', text: '完成' }]
      }
    ];

    const result = await runServerToolOrchestration({
      chat: initialResponsesBody,
      adapterContext: {
        sessionId,
        clientInjectSource: 'servertool.reasoning_stop_continue',
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: '继续执行' }]
        },
        __rt: {
          serverToolFollowup: true
        }
      } as unknown as AdapterContext,
      requestId: 'req_reasoning_stop_followup_empty_responses_body',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      reenterPipeline: async () => ({
        body: {
          ...buildResponsesStopResponse(),
          output: [
            {
              id: 'message_req_1',
              role: 'assistant',
              status: 'completed',
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: buildReasoningStopSummaryBlock(buildCompletedSummary())
                }
              ]
            }
          ],
          output_text: buildReasoningStopSummaryBlock(buildCompletedSummary())
        } as JsonObject
      })
    });

    expect(result.executed).toBe(true);
    const body = result.chat as any;
    expect(String(body.output_text || '')).toContain('[app.finished:reasoning.stop]');
    const firstMessage = body.output?.[0];
    expect(Array.isArray(firstMessage?.content)).toBe(true);
    const hasMarker = (firstMessage?.content || []).some((part: any) =>
      String(part?.text || part?.output_text || '').includes('[app.finished:reasoning.stop]')
    );
    expect(hasMarker).toBe(true);
  });
});
