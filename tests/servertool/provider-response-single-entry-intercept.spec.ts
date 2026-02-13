import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { convertProviderResponse } from '../../sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.js';
import type { JsonObject } from '../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js';

const SESSION_DIR = path.join(os.tmpdir(), 'routecodex-single-entry-servertool');
const PREV_SESSION_DIR = process.env.ROUTECODEX_SESSION_DIR;

describe('provider-response single-entry servertool interception', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
  });

  afterAll(() => {
    if (PREV_SESSION_DIR === undefined) {
      delete process.env.ROUTECODEX_SESSION_DIR;
    } else {
      process.env.ROUTECODEX_SESSION_DIR = PREV_SESSION_DIR;
    }
  });

  beforeEach(() => {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  });

  test('still intercepts clock tool_calls on serverToolFollowup hop at chat_process response entry', async () => {
    let reenterCount = 0;

    const providerResponse: JsonObject = {
      id: 'chatcmpl-followup-raw',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_clock_followup_1',
                type: 'function',
                function: {
                  name: 'clock',
                  arguments: JSON.stringify({
                    action: 'schedule',
                    items: [
                      {
                        dueAt: new Date(Date.now() + 60_000).toISOString(),
                        task: 'single-entry intercept regression'
                      }
                    ],
                    taskId: ''
                  })
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ]
    } as JsonObject;

    const result = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse,
      context: {
        requestId: 'req_single_entry_followup_1',
        entryEndpoint: '/v1/messages',
        providerProtocol: 'openai-chat',
        sessionId: 's_single_entry_followup_1',
        capturedChatRequest: {
          model: 'gpt-test',
          messages: [{ role: 'user', content: 'hello' }]
        },
        __rt: {
          serverToolFollowup: true
        }
      } as any,
      entryEndpoint: '/v1/messages',
      wantsStream: false,
      reenterPipeline: async () => {
        reenterCount += 1;
        return {
          body: {
            id: 'chatcmpl-followup-final',
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
          } as JsonObject
        };
      }
    });

    expect(reenterCount).toBe(1);
    expect(result.body).toBeDefined();
    expect((result.body as any)?.choices?.[0]?.message?.content).toBe('ok');
    expect((result.body as any)?.choices?.[0]?.message?.tool_calls).toBeUndefined();
  });
});
