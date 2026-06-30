import * as fs from 'node:fs';
import * as path from 'node:path';
import { orchestrateServertoolEngine as runServerSideToolEngine } from '../../sharedmodule/llmswitch-core/src/servertool/run-server-side-tool-engine-shell.js';
import type { AdapterContext } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';
import {
  type RoutingInstructionState
} from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js';
import { saveRoutingInstructionStateSync } from '../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-stopmessage-compaction-false-positive');

function writeRoutingStateForSession(sessionId: string, state: RoutingInstructionState): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  saveRoutingInstructionStateSync(`tmux:${sessionId}`, state as any);
}

function bindMetadataCenter<T extends Record<string, unknown>>(
  adapterContext: T,
  providerProtocol: string,
  sessionId?: string
): T {
  const center = MetadataCenter.attach(adapterContext);
  center.writeRuntimeControl(
    'providerProtocol',
    providerProtocol,
    {
      module: 'tests/servertool/stopmessage-compaction-false-positive.spec.ts',
      symbol: 'bindMetadataCenter',
      stage: 'test'
    }
  );
  if (sessionId) {
    center.writeRequestTruth(
      'sessionId',
      sessionId,
      {
        module: 'tests/servertool/stopmessage-compaction-false-positive.spec.ts',
        symbol: 'bindMetadataCenter',
        stage: 'test'
      }
    );
  }
  return adapterContext;
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

    const adapterContext: AdapterContext = bindMetadataCenter({
      requestId: 'req-stopmessage-compaction-substring',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'gemini-chat',
      sessionId,
      tmuxSessionId: sessionId,
      clientTmuxSessionId: sessionId,
      capturedChatRequest: capturedResponsesPayload
    } as any, 'gemini-chat', sessionId);

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
