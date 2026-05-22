import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, jest, test } from '@jest/globals';

import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import { runServerToolOrchestration } from '../../sharedmodule/llmswitch-core/src/servertool/engine.js';
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

  test('uses stop_message_flow client inject followup instead of reentering when the hop is already followup', async () => {
    const sessionId = 'stop-message-flow-followup-hop';
    const stickyKey = `session:${sessionId}`;
    const state = createEmptyRoutingInstructionState();
    state.stopMessageText = '继续执行';
    state.stopMessageMaxRepeats = 3;
    state.stopMessageUsed = 1;
    state.stopMessageUpdatedAt = Date.now();
    saveRoutingInstructionStateSync(stickyKey, state);

    const clientInjectDispatch = jest.fn(async () => ({ ok: true } as const));
    const reenterPipeline = jest.fn(async () => ({
      body: buildStopResponse('不应重入')
    }));

    const result = await runServerToolOrchestration({
      chat: buildStopResponse('再次停止'),
      adapterContext: {
        sessionId,
        clientInjectSource: 'servertool.stop_message',
        __rt: { serverToolFollowup: true }
      } as unknown as AdapterContext,
      requestId: 'req_stop_message_flow_followup_hop',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      clientInjectDispatch,
      reenterPipeline
    });

    expect(result.executed).toBe(true);
    expect(clientInjectDispatch).toHaveBeenCalledTimes(1);
    expect(reenterPipeline).not.toHaveBeenCalled();
    expect(loadRoutingInstructionStateSync(stickyKey)?.stopMessageUsed).toBe(2);
  });
});
