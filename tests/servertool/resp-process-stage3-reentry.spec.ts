import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, jest, test } from '@jest/globals';

import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-state-store.js';
import type { RoutingInstructionState } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.js';
import { runServertoolResponseStageOrchestrationShell } from '../../sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.js';

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
  const stateKey = `session:${sessionId}`;
  const existing = loadRoutingInstructionStateSync(stateKey);
  const next = existing ?? createEmptyRoutingInstructionState();
  next.reasoningStopMode = mode;
  if (mode === 'off') {
    next.reasoningStopArmed = undefined;
    next.reasoningStopSummary = undefined;
    next.reasoningStopUpdatedAt = undefined;
  }
  saveRoutingInstructionStateSync(stateKey, next);
}

describe('resp_process stage3 servertool followup reentry', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
  });

  beforeEach(() => {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  });

  test('stop_message followup hop does not use client inject or reenter orchestration', async () => {
    const sessionId = 'stage3-reentry-guard';
    setStoplessMode(sessionId, 'on');
    const clientInjectDispatch = jest.fn(async () => ({ ok: true } as const));
    let reenterCalls = 0;

    const result = await runServertoolResponseStageOrchestrationShell({
      payload: buildStopResponse('再次停止') as any,
      adapterContext: {
        sessionId,
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: '继续执行' }]
        },
        __rt: { serverToolFollowup: true }
      } as unknown as AdapterContext,
      requestId: 'req_stage3_reentry_guard',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      allowFollowup: true,
      clientInjectDispatch,
      reenterPipeline: async () => {
        reenterCalls += 1;
        return { body: buildStopResponse('继续执行') };
      }
    });

    expect(result.executed).toBe(false);
    expect(clientInjectDispatch).not.toHaveBeenCalled();
    expect(reenterCalls).toBe(0);
    expect(loadRoutingInstructionStateSync(`session:${sessionId}`)?.stopMessageUsed).toBeUndefined();
  });

  test('non-reasoning followup still bypasses orchestration', async () => {
    const result = await runServertoolResponseStageOrchestrationShell({
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
