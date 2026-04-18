import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const { convertProviderResponse: coreConvertProviderResponse } = await import(
  '../../../sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.js'
);
const actualBridge = await import('../../../src/modules/llmswitch/bridge.ts');

const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));
const mockResumeResponsesConversation = jest.fn();
const mockResumeLatestResponsesContinuationByScope = jest.fn();

const mockBridgeModule = () => ({
  ...actualBridge,
  convertProviderResponse: coreConvertProviderResponse,
  createSnapshotRecorder: mockCreateSnapshotRecorder,
  loadRoutingInstructionStateSync: () => undefined,
  rebindResponsesConversationRequestId: async () => {},
  resumeLatestResponsesContinuationByScope: mockResumeLatestResponsesContinuationByScope,
  resumeResponsesConversation: mockResumeResponsesConversation,
  extractSessionIdentifiersFromMetadata: (metadata?: Record<string, unknown>) => ({
    sessionId:
      typeof metadata?.sessionId === 'string'
        ? metadata.sessionId
        : typeof (metadata?.__raw_request_body as Record<string, unknown> | undefined)?.metadata === 'object'
          ? (((metadata?.__raw_request_body as Record<string, unknown>).metadata as Record<string, unknown>).session_id as string | undefined)
          : undefined,
    conversationId:
      typeof metadata?.conversationId === 'string'
        ? metadata.conversationId
        : undefined
  }),
  syncReasoningStopModeFromRequest: () => 'off',
  sanitizeFollowupText: async (raw: unknown) => (typeof raw === 'string' ? raw : '')
});

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', mockBridgeModule);
jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.ts', mockBridgeModule);

jest.unstable_mockModule('../../../src/server/runtime/http-server/servertool-admin-state.js', () => ({
  isServerToolEnabled: () => false
}));
jest.unstable_mockModule('../../../src/server/runtime/http-server/servertool-admin-state.ts', () => ({
  isServerToolEnabled: () => false
}));

const { createRequestExecutor, __requestExecutorTestables } = await import(
  '../../../src/server/runtime/http-server/request-executor.js'
);
const { StatsManager } = await import('../../../src/server/runtime/http-server/stats-manager.js');
const { handleResponses } = await import('../../../src/server/handlers/responses-handler.js');
const { handleChatCompletions } = await import('../../../src/server/handlers/chat-handler.js');
const { handleMessages } = await import('../../../src/server/handlers/messages-handler.js');

async function listenApp(app: express.Express): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function closeServer(server?: http.Server): Promise<void> {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function fetchJson(baseUrl: string, routePath: string, body: unknown): Promise<{ status: number; payload: any }> {
  const response = await fetch(`${baseUrl}${routePath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    payload: text ? JSON.parse(text) : null
  };
}

async function fetchText(baseUrl: string, routePath: string, options: {
  body: string;
  headers: Record<string, string>;
}): Promise<{ status: number; body: string; headers: Headers }> {
  const response = await fetch(`${baseUrl}${routePath}`, {
    method: 'POST',
    headers: options.headers,
    body: options.body
  });
  return {
    status: response.status,
    body: await response.text(),
    headers: response.headers
  };
}

function createProviderHandle(args: {
  runtimeKey: string;
  providerKey: string;
  providerType: 'anthropic' | 'gemini';
  providerProtocol: 'anthropic-messages' | 'gemini-chat';
  processIncoming: (payload: Record<string, unknown>) => Promise<unknown>;
}) {
  return {
    runtimeKey: args.runtimeKey,
    providerId: args.providerKey,
    providerKey: args.providerKey,
    providerType: args.providerType,
    providerFamily: args.providerType,
    providerProtocol: args.providerProtocol,
    runtime: {
      runtimeKey: args.runtimeKey,
      providerId: args.providerKey,
      keyAlias: args.providerKey,
      providerType: args.providerType,
      endpoint: `mock://${args.providerType}`,
      auth: { type: 'apiKey', value: 'mock' },
      outboundProfile: args.providerProtocol
    },
    instance: {
      initialize: async () => {},
      cleanup: async () => {},
      processIncoming: args.processIncoming
    }
  } as any;
}

describe('HTTP handler -> request-executor unified semantics E2E', () => {
  jest.setTimeout(20_000);

  beforeEach(() => {
    __requestExecutorTestables.resetRequestExecutorInternalStateForTests();
    mockCreateSnapshotRecorder.mockClear();
    mockResumeResponsesConversation.mockReset();
    mockResumeLatestResponsesContinuationByScope.mockReset();
  });

  afterEach(async () => {
    __requestExecutorTestables.resetRequestExecutorInternalStateForTests();
  });

  it('keeps responses endpoint inbound payload intact and restores previous_response_id at final HTTP response', async () => {
    const pipelineExecute = jest.fn(async (input: any) => ({
      providerPayload: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 responses handler 整链验证' }]
      },
      standardizedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 responses handler 整链验证' }]
      },
      processedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 responses handler 整链验证' }],
        semantics: {
          continuation: {
            chainId: 'req_chain_http_responses_1',
            stickyScope: 'request_chain',
            stateOrigin: 'openai-responses',
            resumeFrom: {
              protocol: 'openai-responses',
              requestId: 'req_chain_http_responses_1',
              previousResponseId: 'resp_prev_http_responses_1'
            }
          },
          audit: {
            protocolMapping: {
              unsupported: [
                {
                  field: 'response_format',
                  disposition: 'unsupported',
                  sourceProtocol: 'openai-responses',
                  targetProtocol: 'anthropic-messages',
                  reason: 'structured_output_not_supported',
                  source: 'chat.parameters'
                }
              ]
            }
          }
        }
      },
      target: {
        providerKey: 'mock.anthropic.responses',
        providerType: 'anthropic',
        outboundProfile: 'anthropic-messages',
        runtimeKey: 'runtime:anthropic:responses',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {
        capturedChatRequest: {
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: '继续执行 responses handler 整链验证' }]
        }
      }
    }));

    const processIncoming = jest.fn(async (payload: Record<string, unknown>) => ({
      status: 200,
      data: {
        id: 'msg_http_responses_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: `responses handler 整链响应: ${JSON.stringify(payload)}` }],
        stop_reason: 'end_turn'
      }
    }));

    const handle = createProviderHandle({
      runtimeKey: 'runtime:anthropic:responses',
      providerKey: 'mock.anthropic.responses',
      providerType: 'anthropic',
      providerProtocol: 'anthropic-messages',
      processIncoming
    });

    const executor = createRequestExecutor({
      runtimeManager: {
        resolveRuntimeKey: (_providerKey?: string, fallback?: string) => fallback,
        getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey === handle.runtimeKey ? handle : undefined)
      },
      getHubPipeline: () => ({
        execute: pipelineExecute,
        updateVirtualRouterConfig: jest.fn(),
        dispose: jest.fn()
      } as any),
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => ({ success: true }))
        }
      } as any),
      logStage: jest.fn(),
      stats: new StatsManager()
    });

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/responses', (req, res) => {
      void handleResponses(req as any, res as any, {
        executePipeline: (input) => executor.execute(input as any),
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);

    try {
      const result = await fetchJson(baseUrl, '/v1/responses', {
        model: 'claude-sonnet-4-5',
        previous_response_id: 'resp_prev_http_responses_1',
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: '继续执行 responses handler 整链验证' }]
          }
        ],
        response_format: { type: 'json_object' }
      });

      expect(result.status).toBe(200);
      expect(result.payload).toMatchObject({
        object: 'response',
        previous_response_id: 'resp_prev_http_responses_1',
        status: 'completed'
      });
      expect(JSON.stringify(result.payload)).toContain('responses handler 整链响应');

      expect(pipelineExecute).toHaveBeenCalledTimes(1);
      const pipelineInput = pipelineExecute.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.endpoint).toBe('/v1/responses');
      expect(pipelineInput.metadata?.providerProtocol).toBe('openai-responses');
      expect(pipelineInput.payload?.previous_response_id).toBe('resp_prev_http_responses_1');
      expect(pipelineInput.payload?.response_format).toEqual({ type: 'json_object' });
      expect(pipelineInput.metadata?.__raw_request_body?.previous_response_id).toBe('resp_prev_http_responses_1');

      expect(processIncoming).toHaveBeenCalledTimes(1);
      expect(processIncoming).toHaveBeenCalledWith(expect.objectContaining({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 responses handler 整链验证' }]
      }));
    } finally {
      await closeServer(server);
    }
  });



  it('rewrites /v1/responses.submit_tool_outputs into a resumed /v1/responses pipeline request and preserves response continuity', async () => {
    mockResumeResponsesConversation.mockResolvedValue({
      payload: {
        model: 'claude-sonnet-4-5',
        previous_response_id: 'resp_submit_prev_1',
        input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行 submit_tool_outputs 整链验证' }] }],
        tool_outputs: [{ tool_call_id: 'call_submit_1', output: 'ok' }]
      },
      meta: {
        previousRequestId: 'req_chain_submit_1',
        restoredFromResponseId: 'resp_submit_prev_1'
      }
    });

    const pipelineExecute = jest.fn(async (_input: any) => ({
      providerPayload: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 submit_tool_outputs 整链验证' }]
      },
      standardizedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 submit_tool_outputs 整链验证' }]
      },
      processedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 submit_tool_outputs 整链验证' }],
        semantics: {
          continuation: {
            chainId: 'req_chain_submit_1',
            stickyScope: 'request_chain',
            stateOrigin: 'openai-responses',
            resumeFrom: {
              protocol: 'openai-responses',
              requestId: 'req_chain_submit_1',
              responseId: 'resp_submit_prev_1',
              previousResponseId: 'resp_submit_prev_1'
            },
            toolContinuation: {
              mode: 'submit_tool_outputs',
              submittedToolCallIds: ['call_submit_1']
            }
          }
        }
      },
      target: {
        providerKey: 'mock.anthropic.submit',
        providerType: 'anthropic',
        outboundProfile: 'anthropic-messages',
        runtimeKey: 'runtime:anthropic:submit',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {
        capturedChatRequest: {
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: '继续执行 submit_tool_outputs 整链验证' }]
        }
      }
    }));

    const processIncoming = jest.fn(async (payload: Record<string, unknown>) => ({
      status: 200,
      data: {
        id: 'msg_http_submit_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: `submit_tool_outputs 整链响应: ${JSON.stringify(payload)}` }],
        stop_reason: 'end_turn'
      }
    }));

    const handle = createProviderHandle({
      runtimeKey: 'runtime:anthropic:submit',
      providerKey: 'mock.anthropic.submit',
      providerType: 'anthropic',
      providerProtocol: 'anthropic-messages',
      processIncoming
    });

    const executor = createRequestExecutor({
      runtimeManager: {
        resolveRuntimeKey: (_providerKey?: string, fallback?: string) => fallback,
        getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey === handle.runtimeKey ? handle : undefined)
      },
      getHubPipeline: () => ({
        execute: pipelineExecute,
        updateVirtualRouterConfig: jest.fn(),
        dispose: jest.fn()
      } as any),
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => ({ success: true }))
        }
      } as any),
      logStage: jest.fn(),
      stats: new StatsManager()
    });

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/responses/:id/submit_tool_outputs', (req, res) => {
      void handleResponses(
        req as any,
        res as any,
        {
          executePipeline: (input: any) => executor.execute(input),
          errorHandling: null
        },
        {
          entryEndpoint: '/v1/responses.submit_tool_outputs',
          responseIdFromPath: (req as any).params.id
        }
      );
    });

    const { server, baseUrl } = await listenApp(app);

    try {
      const result = await fetchJson(baseUrl, '/v1/responses/resp_submit_prev_1/submit_tool_outputs', {
        tool_outputs: [{ tool_call_id: 'call_submit_1', output: 'ok' }]
      });

      expect(result.status).toBe(200);
      expect(result.payload).toMatchObject({
        object: 'response',
        previous_response_id: 'resp_submit_prev_1',
        status: 'completed'
      });
      expect(JSON.stringify(result.payload)).toContain('submit_tool_outputs 整链响应');

      expect(mockResumeResponsesConversation).toHaveBeenCalledTimes(1);
      expect(mockResumeResponsesConversation).toHaveBeenCalledWith(
        'resp_submit_prev_1',
        {
          response_id: 'resp_submit_prev_1',
          tool_outputs: [{ tool_call_id: 'call_submit_1', output: 'ok' }]
        },
        expect.objectContaining({ requestId: expect.any(String) })
      );

      expect(pipelineExecute).toHaveBeenCalledTimes(1);
      const pipelineInput = pipelineExecute.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.endpoint).toBe('/v1/responses');
      expect(pipelineInput.metadata?.providerProtocol).toBe('openai-responses');
      expect(pipelineInput.metadata?.inboundStream).toBe(false);
      expect(pipelineInput.metadata?.responsesResume).toEqual({
        previousRequestId: 'req_chain_submit_1',
        restoredFromResponseId: 'resp_submit_prev_1'
      });
      expect(pipelineInput.payload?.previous_response_id).toBe('resp_submit_prev_1');
      expect(pipelineInput.payload?.tool_outputs).toEqual([{ tool_call_id: 'call_submit_1', output: 'ok' }]);
      expect(pipelineInput.metadata?.__raw_request_body).toEqual({
        tool_outputs: [{ tool_call_id: 'call_submit_1', output: 'ok' }]
      });

      expect(processIncoming).toHaveBeenCalledTimes(1);
      expect(processIncoming).toHaveBeenCalledWith(expect.objectContaining({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 submit_tool_outputs 整链验证' }]
      }));
    } finally {
      await closeServer(server);
    }
  });

  it('keeps ordinary /v1/responses payload untouched at handler boundary so continuation can be resolved after routing', async () => {
    const pipelineExecute = jest.fn(async (input: any) => ({
      status: 200,
      body: {
        object: 'response',
        id: 'resp_restored_scope_1',
        status: 'completed',
        previous_response_id: input.body?.previous_response_id ?? null,
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ordinary continuation restored' }]
          }
        ]
      }
    }));

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/responses', (req, res) => {
      void handleResponses(req as any, res as any, {
        executePipeline: pipelineExecute,
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);

    try {
      const result = await fetchJson(baseUrl, '/v1/responses', {
        model: 'gpt-5.3-codex',
        metadata: {
          session_id: 'sess-1',
          __shadowCompareForcedProviderKey: 'crs.key2.gpt-5.3-codex',
          __rt: {
            disableStickyRoutes: true
          }
        },
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: '历史 user' }]
          },
          {
            role: 'assistant',
            content: [{ type: 'output_text', text: '历史 assistant' }]
          },
          {
            role: 'user',
            content: [{ type: 'input_text', text: '只发送本轮 delta' }]
          }
        ]
      });

      expect(result.status).toBe(200);
      expect(result.payload).toMatchObject({
        previous_response_id: null,
        status: 'completed'
      });
      expect(mockResumeLatestResponsesContinuationByScope).not.toHaveBeenCalled();

      const pipelineInput = pipelineExecute.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.body?.previous_response_id).toBeUndefined();
      expect(pipelineInput.body?.input).toEqual([
        {
          role: 'user',
          content: [{ type: 'input_text', text: '历史 user' }]
        },
        {
          role: 'assistant',
          content: [{ type: 'output_text', text: '历史 assistant' }]
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: '只发送本轮 delta' }]
        }
      ]);
      expect(pipelineInput.metadata?.responsesResume).toBeUndefined();
      expect(pipelineInput.metadata?.__raw_request_body?.input).toHaveLength(3);
      expect(pipelineInput.metadata?.session_id).toBe('sess-1');
      expect(pipelineInput.metadata?.__shadowCompareForcedProviderKey).toBe('crs.key2.gpt-5.3-codex');
      expect(pipelineInput.metadata?.__rt).toMatchObject({
        disableStickyRoutes: true
      });
    } finally {
      await closeServer(server);
    }
  });

  it('keeps chat endpoint inbound mapping at handler boundary and returns final chat completion through executor/converter chain', async () => {
    const pipelineExecute = jest.fn(async (input: any) => ({
      providerPayload: {
        model: 'gemini-2.5-pro',
        contents: [{ role: 'user', parts: [{ text: '继续执行 chat handler 整链验证' }] }]
      },
      standardizedRequest: {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: '继续执行 chat handler 整链验证' }]
      },
      processedRequest: {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: '继续执行 chat handler 整链验证' }],
        semantics: {
          continuation: {
            chainId: 'session_http_chat_1',
            stickyScope: 'session',
            stateOrigin: 'openai-chat',
            resumeFrom: {
              protocol: 'openai-chat'
            }
          }
        }
      },
      target: {
        providerKey: 'mock.gemini.chat',
        providerType: 'gemini',
        outboundProfile: 'gemini-chat',
        runtimeKey: 'runtime:gemini:chat',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {
        capturedChatRequest: {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', content: '继续执行 chat handler 整链验证' }]
        }
      }
    }));

    const processIncoming = jest.fn(async () => ({
      status: 200,
      data: {
        id: 'gem_http_chat_1',
        model: 'gemini-2.5-pro',
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              role: 'model',
              parts: [{ text: 'chat handler 整链响应完成' }]
            }
          }
        ]
      }
    }));

    const handle = createProviderHandle({
      runtimeKey: 'runtime:gemini:chat',
      providerKey: 'mock.gemini.chat',
      providerType: 'gemini',
      providerProtocol: 'gemini-chat',
      processIncoming
    });

    const executor = createRequestExecutor({
      runtimeManager: {
        resolveRuntimeKey: (_providerKey?: string, fallback?: string) => fallback,
        getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey === handle.runtimeKey ? handle : undefined)
      },
      getHubPipeline: () => ({
        execute: pipelineExecute,
        updateVirtualRouterConfig: jest.fn(),
        dispose: jest.fn()
      } as any),
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => ({ success: true }))
        }
      } as any),
      logStage: jest.fn(),
      stats: new StatsManager()
    });

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/chat/completions', (req, res) => {
      void handleChatCompletions(req as any, res as any, {
        executePipeline: (input) => executor.execute(input as any),
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);

    try {
      const result = await fetchJson(baseUrl, '/v1/chat/completions', {
        model: 'gemini-2.5-pro',
        metadata: {
          session_id: 'chat-sess-1',
          __shadowCompareForcedProviderKey: 'duck.key2.gpt-5.3-codex'
        },
        messages: [{ role: 'user', content: '继续执行 chat handler 整链验证' }]
      });

      expect(result.status).toBe(200);
      expect(result.payload?.object).toBe('chat.completion');
      expect(result.payload?.choices?.[0]?.message?.content).toBe('chat handler 整链响应完成');

      expect(pipelineExecute).toHaveBeenCalledTimes(1);
      const pipelineInput = pipelineExecute.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.endpoint).toBe('/v1/chat/completions');
      expect(pipelineInput.metadata?.providerProtocol).toBe('openai-chat');
      expect(pipelineInput.payload?.messages).toEqual([{ role: 'user', content: '继续执行 chat handler 整链验证' }]);
      expect(pipelineInput.metadata?.__raw_request_body?.messages).toEqual([
        { role: 'user', content: '继续执行 chat handler 整链验证' }
      ]);
      expect(pipelineInput.metadata?.session_id).toBe('chat-sess-1');
      expect(pipelineInput.metadata?.__shadowCompareForcedProviderKey).toBe('duck.key2.gpt-5.3-codex');

      expect(processIncoming).toHaveBeenCalledTimes(1);
      expect(processIncoming).toHaveBeenCalledWith(expect.objectContaining({
        model: 'gemini-2.5-pro',
        contents: [{ role: 'user', parts: [{ text: '继续执行 chat handler 整链验证' }] }]
      }));
    } finally {
      await closeServer(server);
    }
  });




  it('parses /v1/messages SSE request body and preserves the last JSON event into the unified pipeline', async () => {
    const pipelineExecute = jest.fn(async (_input: any) => ({
      providerPayload: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 messages handler SSE 整链验证（第二帧）' }]
      },
      standardizedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 messages handler SSE 整链验证（第二帧）' }]
      },
      processedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 messages handler SSE 整链验证（第二帧）' }],
        semantics: {
          continuation: {
            chainId: 'conversation_http_messages_sse_1',
            stickyScope: 'conversation',
            stateOrigin: 'anthropic-messages',
            resumeFrom: {
              protocol: 'anthropic-messages',
              turnId: 'conversation_http_messages_sse_1'
            }
          }
        }
      },
      target: {
        providerKey: 'mock.anthropic.messages.sse',
        providerType: 'anthropic',
        outboundProfile: 'anthropic-messages',
        runtimeKey: 'runtime:anthropic:messages:sse',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {
        capturedChatRequest: {
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: '继续执行 messages handler SSE 整链验证（第二帧）' }]
        }
      }
    }));

    const processIncoming = jest.fn(async (payload: Record<string, unknown>) => ({
      status: 200,
      data: {
        id: 'msg_http_messages_sse_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: `messages handler SSE 整链响应: ${JSON.stringify(payload)}` }],
        stop_reason: 'end_turn'
      }
    }));

    const handle = createProviderHandle({
      runtimeKey: 'runtime:anthropic:messages:sse',
      providerKey: 'mock.anthropic.messages.sse',
      providerType: 'anthropic',
      providerProtocol: 'anthropic-messages',
      processIncoming
    });

    const executor = createRequestExecutor({
      runtimeManager: {
        resolveRuntimeKey: (_providerKey?: string, fallback?: string) => fallback,
        getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey === handle.runtimeKey ? handle : undefined)
      },
      getHubPipeline: () => ({
        execute: pipelineExecute,
        updateVirtualRouterConfig: jest.fn(),
        dispose: jest.fn()
      } as any),
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => ({ success: true }))
        }
      } as any),
      logStage: jest.fn(),
      stats: new StatsManager()
    });

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/messages', (req, res) => {
      void handleMessages(req as any, res as any, {
        executePipeline: (input) => executor.execute(input as any),
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);

    const sseRequestBody = [
      'event: message',
      'data: {"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"继续执行 messages handler SSE 整链验证（第一帧）"}]}',
      '',
      'event: message',
      'data: {"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"继续执行 messages handler SSE 整链验证（第二帧）"}]}',
      '',
    ].join('\n');

    try {
      const result = await fetchText(baseUrl, '/v1/messages', {
        headers: {
          'content-type': 'text/event-stream',
          accept: 'text/event-stream'
        },
        body: sseRequestBody
      });

      expect(result.status).toBe(200);
      expect(result.headers.get('content-type')).toContain('text/event-stream');
      expect(result.body).toContain('messages handler SSE 整链响应');
      expect(result.body).toContain('第二帧');
      expect(result.body).toContain('event:');

      expect(pipelineExecute).toHaveBeenCalledTimes(1);
      const pipelineInput = pipelineExecute.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.endpoint).toBe('/v1/messages');
      expect(pipelineInput.metadata?.providerProtocol).toBe('anthropic-messages');
      expect(pipelineInput.metadata?.inboundStream).toBe(true);
      expect(pipelineInput.metadata?.outboundStream).toBe(true);
      expect(pipelineInput.payload?.messages).toEqual([
        { role: 'user', content: '继续执行 messages handler SSE 整链验证（第二帧）' }
      ]);
      expect(pipelineInput.metadata?.__raw_request_body).toMatchObject({
        format: 'sse'
      });
      expect(String(pipelineInput.metadata?.__raw_request_body?.rawText || '')).toContain('第一帧');
      expect(String(pipelineInput.metadata?.__raw_request_body?.rawText || '')).toContain('第二帧');
      expect(Array.isArray(pipelineInput.metadata?.__raw_request_body?.events)).toBe(true);
      expect(pipelineInput.metadata?.__raw_request_body?.events).toHaveLength(2);

      expect(processIncoming).toHaveBeenCalledTimes(1);
      expect(processIncoming).toHaveBeenCalledWith(expect.objectContaining({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 messages handler SSE 整链验证（第二帧）' }]
      }));
    } finally {
      await closeServer(server);
    }
  });
  it('keeps messages endpoint inbound payload intact and returns anthropic message body through executor/converter chain', async () => {
    const pipelineExecute = jest.fn(async (_input: any) => ({
      providerPayload: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 messages handler 整链验证' }]
      },
      standardizedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 messages handler 整链验证' }]
      },
      processedRequest: {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 messages handler 整链验证' }],
        semantics: {
          continuation: {
            chainId: 'conversation_http_messages_1',
            stickyScope: 'conversation',
            stateOrigin: 'anthropic-messages',
            resumeFrom: {
              protocol: 'anthropic-messages',
              turnId: 'conversation_http_messages_1'
            }
          },
          audit: {
            protocolMapping: {
              preserved: [
                {
                  field: 'messages',
                  disposition: 'preserved',
                  sourceProtocol: 'anthropic-messages',
                  targetProtocol: 'anthropic-messages',
                  reason: 'protocol_identity',
                  source: 'chat.messages'
                }
              ]
            }
          }
        }
      },
      target: {
        providerKey: 'mock.anthropic.messages',
        providerType: 'anthropic',
        outboundProfile: 'anthropic-messages',
        runtimeKey: 'runtime:anthropic:messages',
        processMode: 'standard'
      },
      processMode: 'standard',
      metadata: {
        capturedChatRequest: {
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: '继续执行 messages handler 整链验证' }]
        }
      }
    }));

    const processIncoming = jest.fn(async (payload: Record<string, unknown>) => ({
      status: 200,
      data: {
        id: 'msg_http_messages_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: `messages handler 整链响应: ${JSON.stringify(payload)}` }],
        stop_reason: 'end_turn'
      }
    }));

    const handle = createProviderHandle({
      runtimeKey: 'runtime:anthropic:messages',
      providerKey: 'mock.anthropic.messages',
      providerType: 'anthropic',
      providerProtocol: 'anthropic-messages',
      processIncoming
    });

    const executor = createRequestExecutor({
      runtimeManager: {
        resolveRuntimeKey: (_providerKey?: string, fallback?: string) => fallback,
        getHandleByRuntimeKey: (runtimeKey?: string) => (runtimeKey === handle.runtimeKey ? handle : undefined)
      },
      getHubPipeline: () => ({
        execute: pipelineExecute,
        updateVirtualRouterConfig: jest.fn(),
        dispose: jest.fn()
      } as any),
      getModuleDependencies: () => ({
        errorHandlingCenter: {
          handleError: jest.fn(async () => ({ success: true }))
        }
      } as any),
      logStage: jest.fn(),
      stats: new StatsManager()
    });

    const app = express();
    app.use(express.json({ limit: '256kb' }));
    app.post('/v1/messages', (req, res) => {
      void handleMessages(req as any, res as any, {
        executePipeline: (input) => executor.execute(input as any),
        errorHandling: null
      });
    });

    const { server, baseUrl } = await listenApp(app);

    try {
      const result = await fetchJson(baseUrl, '/v1/messages', {
        model: 'claude-sonnet-4-5',
        metadata: {
          session_id: 'msg-sess-1',
          __shadowCompareForcedProviderKey: 'wuzu.key2.gpt-5.3-codex'
        },
        messages: [{ role: 'user', content: '继续执行 messages handler 整链验证' }]
      });

      expect(result.status).toBe(200);
      expect(result.payload).toMatchObject({
        id: 'msg_http_messages_1',
        type: 'message',
        role: 'assistant',
        stop_reason: 'end_turn'
      });
      expect(JSON.stringify(result.payload)).toContain('messages handler 整链响应');

      expect(pipelineExecute).toHaveBeenCalledTimes(1);
      const pipelineInput = pipelineExecute.mock.calls[0]?.[0] as Record<string, any>;
      expect(pipelineInput.endpoint).toBe('/v1/messages');
      expect(pipelineInput.metadata?.providerProtocol).toBe('anthropic-messages');
      expect(pipelineInput.payload?.messages).toEqual([{ role: 'user', content: '继续执行 messages handler 整链验证' }]);
      expect(pipelineInput.metadata?.__raw_request_body?.messages).toEqual([
        { role: 'user', content: '继续执行 messages handler 整链验证' }
      ]);
      expect(pipelineInput.metadata?.session_id).toBe('msg-sess-1');
      expect(pipelineInput.metadata?.__shadowCompareForcedProviderKey).toBe('wuzu.key2.gpt-5.3-codex');

      expect(processIncoming).toHaveBeenCalledTimes(1);
      expect(processIncoming).toHaveBeenCalledWith(expect.objectContaining({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: '继续执行 messages handler 整链验证' }]
      }));
    } finally {
      await closeServer(server);
    }
  });
});
