import * as fs from 'node:fs';
import * as path from 'node:path';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import {
  serializeRoutingInstructionState,
  type RoutingInstructionState
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-stopmessage-sessions');

function writeRoutingStateForSession(sessionId: string, state: RoutingInstructionState): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const filename = `session-${sessionId}.json`;
  const filepath = path.join(SESSION_DIR, filename);
  const payload = {
    version: 1,
    state: serializeRoutingInstructionState(state)
  };
  fs.writeFileSync(filepath, JSON.stringify(payload), { encoding: 'utf8' });
}

describe('stop_message_auto servertool', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
  });

  test('schedules followup when stopMessage is active and finish_reason=stop', async () => {
    const sessionId = 'stopmessage-spec-session-1';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: 'hi'
        }
      ]
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-1',
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

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-1',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('stop_message_flow');
    const followup = result.execution?.followup as any;
    expect(followup).toBeDefined();
    const payload = followup.payload as JsonObject;
    const messages = Array.isArray((payload as any).messages) ? (payload as any).messages : [];
    expect(messages.length).toBeGreaterThan(1);
    const last = messages[messages.length - 1] as any;
    expect(last.role).toBe('user');
    expect(last.content).toBe('继续');
    expect(followup.metadata?.disableStickyRoutes).toBe(true);
    expect(followup.metadata?.preserveRouteHint).toBe(false);

    const persisted = JSON.parse(
      fs.readFileSync(path.join(SESSION_DIR, `session-${sessionId}.json`), 'utf8')
    ) as { state?: { stopMessageUsed?: number; stopMessageLastUsedAt?: number } };
    expect(persisted?.state?.stopMessageUsed).toBe(1);
    expect(typeof persisted?.state?.stopMessageLastUsedAt).toBe('number');
  });

  test('skips followup when client disconnects mid-stream', async () => {
    const sessionId = 'stopmessage-spec-session-disconnected';
    const state: RoutingInstructionState = {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续',
      stopMessageMaxRepeats: 2,
      stopMessageUsed: 0
    };
    writeRoutingStateForSession(sessionId, state);

    const capturedChatRequest: JsonObject = {
      model: 'gpt-test',
      messages: [
        {
          role: 'user',
          content: 'hi'
        }
      ]
    };

    const chatResponse: JsonObject = {
      id: 'chatcmpl-stop-2',
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

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-2',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      sessionId,
      capturedChatRequest,
      clientConnectionState: { disconnected: true }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/chat/completions',
      requestId: 'req-stopmessage-2',
      providerProtocol: 'openai-chat'
    });

    expect(result.mode).toBe('passthrough');
  });
});
