import * as fs from 'node:fs';
import * as path from 'node:path';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import {
  type RoutingInstructionState
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.js';
import { buildOpenAIChatFromAnthropicMessage } from '../../sharedmodule/llmswitch-core/src/conversion/hub/response/response-runtime.js';
import { saveRoutingInstructionStateSync } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-stopmessage-anthropic-stop-sequence');

function writeRoutingStateForSession(sessionId: string, state: RoutingInstructionState): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  saveRoutingInstructionStateSync(`tmux:${sessionId}`, state as any);
}

describe('stopMessage trigger for /v1/messages (anthropic stop_sequence)', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  });

  test('treats stop_reason=stop_sequence as finish_reason=stop (eligible for stopMessage)', async () => {
    const sessionId = 'sess-anthropic-stop-seq';
    writeRoutingStateForSession(sessionId, {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续',
      stopMessageMaxRepeats: 1,
      stopMessageUsed: 0
    });

    const anthropicPayload: JsonObject = {
      id: 'msg_test_stop_sequence',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      stop_reason: 'stop_sequence',
      content: [{ type: 'text', text: 'ok' }]
    };
    const chatResponse = buildOpenAIChatFromAnthropicMessage(anthropicPayload) as any;
    expect(chatResponse?.choices?.[0]?.finish_reason).toBe('stop');

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-anthropic-stop-seq',
      entryEndpoint: '/v1/messages',
      providerProtocol: 'anthropic-messages',
      sessionId,
      tmuxSessionId: sessionId,
      clientTmuxSessionId: sessionId,
      capturedChatRequest: {
        model: 'claude-test',
        messages: [{ role: 'user', content: 'hi' }]
      }
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/messages',
      requestId: 'req-stopmessage-anthropic-stop-seq',
      providerProtocol: 'anthropic-messages'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('stop_message_flow');
  });
});
