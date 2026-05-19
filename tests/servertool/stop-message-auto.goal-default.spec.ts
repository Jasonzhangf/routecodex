import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import {
  serializeRoutingInstructionState,
  type RoutingInstructionState
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-stopmessage-goal-default');
const PREV_SESSION_DIR = process.env.ROUTECODEX_SESSION_DIR;
const PREV_DEFAULT_ENABLED = process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED;
const PREV_DEFAULT_MAX = process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS;

function writeRoutingStateForSession(sessionId: string, state: RoutingInstructionState): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const filepath = path.join(SESSION_DIR, `session-${sessionId}.json`);
  fs.writeFileSync(
    filepath,
    JSON.stringify({
      version: 1,
      state: serializeRoutingInstructionState(state)
    }),
    'utf8'
  );
}

function readState(sessionId: string): Record<string, unknown> | undefined {
  const filepath = path.join(SESSION_DIR, `session-${sessionId}.json`);
  if (!fs.existsSync(filepath)) {
    return undefined;
  }
  const payload = JSON.parse(fs.readFileSync(filepath, 'utf8')) as { state?: Record<string, unknown> };
  return payload.state;
}

function buildStopChatResponse(): JsonObject {
  return {
    id: 'chatcmpl-stop-goal-default',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'ok'
        },
        finish_reason: 'stop'
      }
    ]
  };
}

function buildAdapterContext(sessionId: string): AdapterContext {
  return {
    requestId: `req-${sessionId}`,
    entryEndpoint: '/v1/chat/completions',
    providerProtocol: 'openai-chat',
    sessionId,
    capturedChatRequest: {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '继续处理' }]
    }
  } as any;
}

describe('stop_message_auto goal-active/default-repeat contract', () => {
  beforeEach(() => {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
    process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = '1';
    process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS = '2';
  });

  afterEach(() => {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    if (PREV_SESSION_DIR === undefined) {
      delete process.env.ROUTECODEX_SESSION_DIR;
    } else {
      process.env.ROUTECODEX_SESSION_DIR = PREV_SESSION_DIR;
    }
    if (PREV_DEFAULT_ENABLED === undefined) {
      delete process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED;
    } else {
      process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = PREV_DEFAULT_ENABLED;
    }
    if (PREV_DEFAULT_MAX === undefined) {
      delete process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS;
    } else {
      process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS = PREV_DEFAULT_MAX;
    }
  });

  test('/goal active 时不自动续', async () => {
    const sessionId = 'goal-active-skip';
    const now = Date.now();
    const adapterContext = {
      ...buildAdapterContext(sessionId),
      stoplessGoalState: {
        status: 'active',
        objective: 'live goal',
        createdAt: now,
        updatedAt: now
      }
    } as any;
    const result = await runServerSideToolEngine({
      chatResponse: buildStopChatResponse(),
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-goal-active-skip',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('passthrough');
    expect(result.execution).toBeUndefined();
    expect(adapterContext.stoplessGoalState).toMatchObject({ status: 'active' });
  });

  test('非 /goal active 默认只续两次，第三次停并归零', async () => {
    const sessionId = 'default-repeat-2';

    const first = await runServerSideToolEngine({
      chatResponse: buildStopChatResponse(),
      adapterContext: buildAdapterContext(sessionId),
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-default-repeat-1',
      providerProtocol: 'openai-chat'
    });
    expect(first.mode).toBe('tool_flow');
    expect(first.execution?.flowId).toBe('stop_message_flow');
    expect(readState(sessionId)?.stopMessageUsed).toBe(1);

    const second = await runServerSideToolEngine({
      chatResponse: buildStopChatResponse(),
      adapterContext: buildAdapterContext(sessionId),
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-default-repeat-2',
      providerProtocol: 'openai-chat'
    });
    expect(second.mode).toBe('tool_flow');
    expect(second.execution?.flowId).toBe('stop_message_flow');
    expect(readState(sessionId)?.stopMessageUsed).toBe(2);

    const third = await runServerSideToolEngine({
      chatResponse: buildStopChatResponse(),
      adapterContext: buildAdapterContext(sessionId),
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-default-repeat-3',
      providerProtocol: 'openai-chat'
    });
    expect(third.mode).toBe('passthrough');
    expect(third.execution).toBeUndefined();
    expect(readState(sessionId)?.stopMessageUsed).toBe(0);
  });
});
