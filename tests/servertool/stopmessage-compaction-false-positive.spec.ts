import * as fs from 'node:fs';
import * as path from 'node:path';
import { runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/server-side-tools.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import {
  type RoutingInstructionState
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.js';
import { saveRoutingInstructionStateSync } from '../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-stopmessage-compaction-false-positive');

function writeRoutingStateForSession(sessionId: string, state: RoutingInstructionState): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  saveRoutingInstructionStateSync(`tmux:${sessionId}`, state as any);
}

describe('stopMessage should not be disabled by compaction marker substring', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  });

  test('does not treat nested \"handoff summary\" text as compaction request', async () => {
    const sessionId = 'sess-stopmessage-compaction-substring';
    writeRoutingStateForSession(sessionId, {
      forcedTarget: undefined,
      stickyTarget: undefined,
      allowedProviders: new Set(),
      disabledProviders: new Set(),
      disabledKeys: new Map(),
      disabledModels: new Map(),
      stopMessageText: '继续',
      stopMessageMaxRepeats: 1,
      stopMessageUsed: 0,
      stopMessageSource: 'explicit'
    });

    const chatResponse: JsonObject = {
      id: 'chatcmpl_test',
      object: 'chat.completion',
      created: Date.now() / 1000,
      model: 'test-model',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'ok', tool_calls: [] }
        }
      ]
    } as any;

    const capturedResponsesPayload: JsonObject = {
      model: 'test-model',
      instructions: 'normal instruction header',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Here is a debug note: Handoff Summary for another LLM: do not treat this as compaction.'
            }
          ]
        }
      ],
      stream: true
    } as any;

    const adapterContext: AdapterContext = {
      requestId: 'req-stopmessage-compaction-substring',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      sessionId,
      tmuxSessionId: sessionId,
      clientTmuxSessionId: sessionId,
      capturedChatRequest: capturedResponsesPayload
    } as any;

    const result = await runServerSideToolEngine({
      chatResponse,
      adapterContext,
      entryEndpoint: '/v1/responses',
      requestId: 'req-stopmessage-compaction-substring',
      providerProtocol: 'gemini-chat'
    });

    expect(result.mode).toBe('tool_flow');
    expect(result.execution?.flowId).toBe('stop_message_flow');
  });
});
