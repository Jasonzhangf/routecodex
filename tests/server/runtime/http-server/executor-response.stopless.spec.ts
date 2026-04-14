import * as fs from 'node:fs';
import * as path from 'node:path';
import { convertProviderResponseIfNeeded } from '../../../../src/server/runtime/http-server/executor-response.js';
import { loadRoutingInstructionStateSync } from '../../../../sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-executor-response-stopless-sessions');

describe('executor-response stopless direct-model regression', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
  });

  beforeEach(() => {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  });

  test('backfills session scope from original responses request and triggers stopless followup', async () => {
    const sessionId = 'executor-response-stopless-direct';
    const nestedCalls: Array<{ requestId?: string; body?: Record<string, unknown> }> = [];

    const result = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerType: 'openai',
        requestId: 'req_executor_response_stopless_direct',
        serverToolsEnabled: true,
        wantsStream: false,
        originalRequest: {
          model: 'qwenchat.qwen3.6-plus',
          metadata: { sessionId },
          input: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: '请直接回复一句“阶段完成”，然后结束。<**stopless:on**>'
                }
              ]
            }
          ]
        },
        processMode: 'chat',
        response: {
          status: 200,
          body: {
            id: 'chatcmpl_executor_response_stopless',
            object: 'chat.completion',
            model: 'qwen3.6-plus',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: '阶段完成'
                }
              }
            ]
          }
        },
        pipelineMetadata: {}
      },
      {
        logStage() {},
        executeNested: async (input) => {
          nestedCalls.push({
            requestId: input.requestId,
            body: input.body && typeof input.body === 'object' ? (input.body as Record<string, unknown>) : undefined
          });
          return {
            status: 200,
            body: {
              id: 'resp_executor_response_stopless_followup',
              object: 'response',
              status: 'completed',
              output: [
                {
                  id: 'msg_executor_response_stopless_followup',
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [
                    {
                      type: 'output_text',
                      text: '继续执行中'
                    }
                  ]
                }
              ],
              output_text: '继续执行中'
            }
          };
        }
      }
    );

    expect(loadRoutingInstructionStateSync(`session:${sessionId}`)?.reasoningStopMode).toBe('on');
    expect(nestedCalls.length).toBeGreaterThan(0);
    expect(String(nestedCalls[0]?.requestId || '')).toContain(':reasoning_stop_guard');
    expect((result.body as any)?.output_text).toBe('继续执行中');
  });

  test('defaults stopless to on for session-bound responses request without directive', async () => {
    const sessionId = 'executor-response-stopless-default';
    const nestedCalls: Array<{ requestId?: string; body?: Record<string, unknown> }> = [];

    const result = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerType: 'openai',
        requestId: 'req_executor_response_stopless_default',
        serverToolsEnabled: true,
        wantsStream: false,
        originalRequest: {
          model: 'qwenchat.qwen3.6-plus',
          metadata: { sessionId },
          input: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: '请直接回复一句“阶段完成”，然后结束。'
                }
              ]
            }
          ]
        },
        processMode: 'chat',
        response: {
          status: 200,
          body: {
            id: 'chatcmpl_executor_response_stopless_default',
            object: 'chat.completion',
            model: 'qwen3.6-plus',
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: {
                  role: 'assistant',
                  content: '阶段完成'
                }
              }
            ]
          }
        },
        pipelineMetadata: {}
      },
      {
        logStage() {},
        executeNested: async (input) => {
          nestedCalls.push({
            requestId: input.requestId,
            body: input.body && typeof input.body === 'object' ? (input.body as Record<string, unknown>) : undefined
          });
          return {
            status: 200,
            body: {
              id: 'resp_executor_response_stopless_default_followup',
              object: 'response',
              status: 'completed',
              output: [
                {
                  id: 'msg_executor_response_stopless_default_followup',
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [
                    {
                      type: 'output_text',
                      text: '继续执行中'
                    }
                  ]
                }
              ],
              output_text: '继续执行中'
            }
          };
        }
      }
    );

    expect(nestedCalls.length).toBeGreaterThan(0);
    expect(String(nestedCalls[0]?.requestId || '')).toContain(':reasoning_stop_guard');
    expect((result.body as any)?.output_text).toBe('继续执行中');
  });
});
