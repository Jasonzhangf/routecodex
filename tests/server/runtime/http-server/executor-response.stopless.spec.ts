import * as fs from 'node:fs';
import * as path from 'node:path';
import { jest } from '@jest/globals';
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync
} from '../../../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-state-store.js';

const SESSION_DIR = path.join(process.cwd(), 'tmp', 'jest-executor-response-stopless-sessions');

function createEmptyRoutingInstructionState() {
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

function persistReasoningStopMode(sessionId: string, mode: 'on' | 'off' | 'endless'): void {
  const stateKey = `session:${sessionId}`;
  const existing = loadRoutingInstructionStateSync(stateKey);
  const next = existing ?? createEmptyRoutingInstructionState();
  next.reasoningStopMode = mode;
  if (mode === 'off') {
    next.reasoningStopArmed = undefined;
    next.reasoningStopSummary = undefined;
    next.reasoningStopUpdatedAt = undefined;
  }
  saveRoutingInstructionStateSync(stateKey, next as any);
}

const mockSyncReasoningStopModeFromRequest = jest.fn((baseContext: Record<string, unknown>) => {
  const mode = 'off';
  baseContext.reasoningStopMode = mode;
  const sessionId = typeof baseContext.sessionId === 'string' ? baseContext.sessionId.trim() : '';
  if (sessionId) {
    persistReasoningStopMode(sessionId, mode);
  }
  return mode;
});

const mockConvertProviderResponse = jest.fn();
const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));
const mockBridgeModule = () => ({
  convertProviderResponse: mockConvertProviderResponse,
  createSnapshotRecorder: mockCreateSnapshotRecorder,
  syncReasoningStopModeFromRequest: mockSyncReasoningStopModeFromRequest,
  sanitizeFollowupText: async (raw: unknown) => (typeof raw === 'string' ? raw : '')
});

jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);

describe('executor-response stopless direct-model regression', () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
  });

  beforeEach(() => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();
    mockSyncReasoningStopModeFromRequest.mockClear();
    mockSyncReasoningStopModeFromRequest.mockImplementation((baseContext: Record<string, unknown>) => {
      const mode = 'off';
      baseContext.reasoningStopMode = mode;
      const sessionId = typeof baseContext.sessionId === 'string' ? baseContext.sessionId.trim() : '';
      if (sessionId) {
        persistReasoningStopMode(sessionId, mode);
      }
      return mode;
    });
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  });

  test('backfills session scope from original responses request and triggers stopless followup', async () => {
    mockSyncReasoningStopModeFromRequest.mockImplementationOnce((baseContext: Record<string, unknown>) => {
      const mode = 'on';
      baseContext.reasoningStopMode = mode;
      const sessionId = typeof baseContext.sessionId === 'string' ? baseContext.sessionId.trim() : '';
      if (sessionId) {
        persistReasoningStopMode(sessionId, mode);
      }
      return mode;
    });
    mockConvertProviderResponse.mockImplementation(async ({ reenterPipeline }) => {
      const followup = await reenterPipeline({
        entryEndpoint: '/v1/responses',
        requestId: 'req_executor_response_stopless_direct:reasoning_stop_guard',
        body: {
          model: 'qwenchat.qwen3.6-plus',
          input: [
            {
              role: 'user',
              content: [{ type: 'input_text', text: '继续执行' }]
            }
          ]
        },
        metadata: {
          __rt: { serverToolFollowup: true }
        }
      });
      return {
        body: (followup as { body?: Record<string, unknown> }).body ?? {
          id: 'resp_executor_response_stopless_followup',
          object: 'response',
          output_text: '继续执行中'
        }
      };
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../src/server/runtime/http-server/executor-response.js'
    );
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

  test('defaults stopless to off for session-bound responses request without directive', async () => {
    mockConvertProviderResponse.mockImplementation(async () => {
      return {
        body: {
          id: 'resp_executor_response_stopless_default_passthrough',
          object: 'chat.completion',
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
      };
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../src/server/runtime/http-server/executor-response.js'
    );
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

    expect(loadRoutingInstructionStateSync(`session:${sessionId}`)?.reasoningStopMode).toBe('off');
    expect(nestedCalls.length).toBe(0);
    expect((result.body as any)?.choices?.[0]?.message?.content).toBe('阶段完成');
  });

});
