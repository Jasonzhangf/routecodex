import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test } from '@jest/globals';

import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js';
import type { RoutingInstructionState } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.js';
import { runRespProcessStage3ServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage3_servertool_orchestration/index.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-stage3-reentry-sessions');

function buildStopResponse(content = 'done'): JsonObject {
  return {
    id: 'chatcmpl_stage3_reentry',
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

describe('resp_process stage3 servertool followup reentry', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
  });

  beforeEach(() => {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  });

  test('reasoning_stop_guard followup re-enters orchestration instead of followup_bypass', async () => {
    const sessionId = 'stage3-reentry-guard';
    setStoplessMode(sessionId, 'on');
    let reenterCalls = 0;

    const result = await runRespProcessStage3ServerToolOrchestration({
      payload: buildStopResponse('再次停止') as any,
      adapterContext: {
        sessionId,
        clientInjectSource: 'servertool.reasoning_stop_guard',
        capturedChatRequest: {
          model: 'deepseek-reasoner',
          messages: [{ role: 'user', content: '继续执行' }]
        },
        __rt: { serverToolFollowup: true }
      } as unknown as AdapterContext,
      requestId: 'req_stage3_reentry_guard',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => {
        reenterCalls += 1;
        return { body: buildStopResponse('继续执行') };
      }
    });

    expect(result.executed).toBe(true);
    expect(result.flowId).toBe('reasoning_stop_guard_flow');
    expect(reenterCalls).toBeGreaterThan(0);
  });

  test('non-reasoning followup still bypasses orchestration', async () => {
    const result = await runRespProcessStage3ServerToolOrchestration({
      payload: buildStopResponse('普通 followup') as any,
      adapterContext: {
        sessionId: 'stage3-bypass-normal-followup',
        clientInjectSource: 'servertool.clock',
        __rt: { serverToolFollowup: true }
      } as unknown as AdapterContext,
      requestId: 'req_stage3_bypass_normal_followup',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: buildStopResponse('不会执行') })
    });

    expect(result.executed).toBe(false);
    expect(result.flowId).toBeUndefined();
    expect(result.payload).toEqual(buildStopResponse('普通 followup'));
  });
});
