import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, jest, test } from '@jest/globals';

import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js';
import type { RoutingInstructionState } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js';
import { runServertoolResponseStageOrchestrationShell } from '../../sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-stage3-reentry-sessions');
const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');

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

function bindRuntimeControl(adapterContext: Record<string, unknown>, runtimeControl: Record<string, unknown>): Record<string, unknown> {
  const stored = { ...runtimeControl };
  Reflect.set(adapterContext, METADATA_CENTER_SYMBOL, {
    readRuntimeControl: () => stored,
    writeRuntimeControl: (key: string, value: unknown) => {
      stored[key] = value;
    }
  });
  return adapterContext;
}

describe('resp_process stage3 servertool followup reentry', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
  });

  beforeEach(() => {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  });

  test('non-reasoning followup still bypasses orchestration', async () => {
    const result = await runServertoolResponseStageOrchestrationShell({
      payload: buildStopResponse('普通 followup') as any,
      adapterContext: bindRuntimeControl(
        {
          sessionId: 'stage3-bypass-normal-followup',
          clientInjectSource: 'servertool.followup'
        },
        { serverToolFollowup: true, serverToolFollowupSource: 'servertool.followup' }
      ) as unknown as AdapterContext,
      requestId: 'req_stage3_bypass_normal_followup',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: buildStopResponse('不会执行') })
    });

    expect(result.executed).toBe(false);
    expect(result.flowId).toBeUndefined();
    expect(result.payload).toEqual(buildStopResponse('普通 followup'));
  });

  test('response-stage shell does not mirror MetadataCenter runtime control onto adapterContext.runtime_control', async () => {
    const adapterContext = bindRuntimeControl(
      {
        sessionId: 'stage3-runtime-control-no-mirror'
      },
      { serverToolFollowup: true, serverToolFollowupSource: 'servertool.followup' }
    ) as unknown as AdapterContext & Record<string, unknown>;

    const result = await runServertoolResponseStageOrchestrationShell({
      payload: buildStopResponse('普通 followup') as any,
      adapterContext,
      requestId: 'req_stage3_runtime_control_no_mirror',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      reenterPipeline: async () => ({ body: buildStopResponse('不会执行') })
    });

    expect(result.executed).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(adapterContext, 'runtime_control')).toBe(false);
  });
});
