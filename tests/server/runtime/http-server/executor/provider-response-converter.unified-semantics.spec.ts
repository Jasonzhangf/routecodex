import { describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { MetadataCenter } from '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const mockConvertProviderResponse = jest.fn();
const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));

const TEST_METADATA_WRITER = {
  module: 'tests/server/runtime/http-server/executor/provider-response-converter.unified-semantics.spec.ts',
  symbol: 'buildPipelineMetadata',
  stage: 'test_runtime_control_provider_protocol'
} as const;

function buildPipelineMetadata(providerProtocol: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const metadata = { ...extra };
  MetadataCenter.attach(metadata).writeRuntimeControl(
    'providerProtocol',
    providerProtocol,
    TEST_METADATA_WRITER,
    'seed provider protocol for converter test'
  );
  return metadata;
}
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/response-converter.js', () => ({
  convertProviderResponse: mockConvertProviderResponse
}));
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/response-converter.ts', () => ({
  convertProviderResponse: mockConvertProviderResponse
}));
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/snapshot-recorder.js', () => ({
  createSnapshotRecorder: mockCreateSnapshotRecorder
}));
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/snapshot-recorder.ts', () => ({
  createSnapshotRecorder: mockCreateSnapshotRecorder
}));

describe('provider-response-converter unified semantics handoff', () => {
  it('live 10000 direct chat sample returns a tool_calls terminal SSE frame for the current turn', () => {
    const samplePath = path.resolve(
      process.env.HOME || '',
      '.rcc/codex-samples/openai-chat/ports/10000/req_1782434871078_e3eff4df/client-response_1.json'
    );
    if (!fs.existsSync(samplePath)) {
      return;
    }
    const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8')) as {
      body?: { bodyText?: string };
      meta?: { entryEndpoint?: string };
    };
    expect(sample.meta?.entryEndpoint).toBe('/v1/chat/completions');
    const text = sample.body?.bodyText ?? '';
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text).toContain('"function":{"name":"directory_tree","arguments":""}');
    expect(text).toContain('data: [DONE]');
    expect(text).not.toContain('/v1/chat/completions');
    expect(text).not.toContain('"finish_reason":"stop"');
    expect(text).not.toContain('"finish_reason":"length"');
  });

  it('live 10000 direct chat sample provider response is anthropic tool_use upstream for the same chat turn', () => {
    const sampleDir = path.resolve(
      process.env.HOME || '',
      '.rcc/codex-samples/openai-chat/ports/10000/req_1782434871078_e3eff4df'
    );
    if (!fs.existsSync(sampleDir)) {
      return;
    }
    const providerResponse = JSON.parse(
      fs.readFileSync(path.join(sampleDir, 'provider-response_3.json'), 'utf8')
    ) as {
      body?: { bodyText?: string };
      meta?: { providerKey?: string; entryEndpoint?: string };
    };
    const providerText = providerResponse.body?.bodyText ?? '';
    expect(providerResponse.meta?.entryEndpoint).toBe('/v1/chat/completions');
    expect(providerResponse.meta?.providerKey).toBe('minimax.key1.MiniMax-M3');
    expect(providerResponse.meta?.providerId).toBe('minimax');
    expect(providerText).toContain('"type":"tool_use"');
    expect(providerText).toContain('"stop_reason":"tool_use"');
    expect(providerText).toContain('"name":"directory_tree"');
  });

  it('live 10000 direct chat sample request already contains multi-turn tool history before the current provider call', () => {
    const sampleDir = path.resolve(
      process.env.HOME || '',
      '.rcc/codex-samples/openai-chat/ports/10000/req_1782434871078_e3eff4df'
    );
    if (!fs.existsSync(sampleDir)) {
      return;
    }
    const clientRequest = JSON.parse(
      fs.readFileSync(path.join(sampleDir, 'client-request.json'), 'utf8')
    ) as { body?: { body?: { messages?: Array<Record<string, unknown>> } } };
    const providerRequest = JSON.parse(
      fs.readFileSync(path.join(sampleDir, 'provider-request.json'), 'utf8')
    ) as { body?: { messages?: Array<Record<string, unknown>> } };

    const clientMessages = Array.isArray(clientRequest.body?.body?.messages)
      ? clientRequest.body.body.messages
      : [];
    const providerMessages = Array.isArray(providerRequest.body?.messages)
      ? providerRequest.body.messages
      : [];

    expect(clientMessages).toHaveLength(12);
    expect(clientMessages[2]?.role).toBe('assistant');
    expect(Array.isArray(clientMessages[2]?.tool_calls)).toBe(true);
    expect(clientMessages[2]?.tool_calls).toHaveLength(2);
    expect(clientMessages[5]?.role).toBe('assistant');
    expect(Array.isArray(clientMessages[5]?.tool_calls)).toBe(true);
    expect(clientMessages[5]?.tool_calls).toHaveLength(6);
    expect(
      clientMessages.filter((message) => message?.role === 'tool').map((message) => message.tool_call_id)
    ).toEqual([
      'call_6e1e1975d7cc4b7b88486c52',
      'call_84410eee62894e62b718be4b',
      'call_00_lvjYzE6DE4c6wlDP9MPo8317',
      'call_01_wtHZR8FHHkIlegv3yUKQ6646',
      'call_02_OcX2UisABTktHahMIsHg1645',
      'call_03_R6svQQbpoXX2lIX8WlTw3555',
      'call_04_nBwCk57FyYgcPC6Mly4j9559',
      'call_05_RcBXx9ICwaNSJ4NKJh7O0630'
    ]);

    expect(providerMessages).toHaveLength(17);
    expect(providerMessages[1]?.role).toBe('assistant');
    expect(providerMessages[2]?.role).toBe('user');
    expect(
      providerMessages.slice(1).every((message, index) =>
        index % 2 === 0 ? message?.role === 'assistant' : message?.role === 'user'
      )
    ).toBe(true);
    expect(
      providerMessages
        .slice(2)
        .filter((message) => message?.role === 'user')
        .every((message) =>
          Array.isArray(message?.content)
          && message.content.every((item: any) => item?.type === 'tool_result')
        )
    ).toBe(true);
  });

  it('live 10000 provider request snapshots with identical buildTime are duplicate captures of one turn, not follow-up turns', () => {
    const sampleDir = path.resolve(
      process.env.HOME || '',
      '.rcc/codex-samples/openai-chat/ports/10000/req_1782434871078_e3eff4df'
    );
    if (!fs.existsSync(sampleDir)) {
      return;
    }
    const providerRequest = JSON.parse(
      fs.readFileSync(path.join(sampleDir, 'provider-request.json'), 'utf8')
    ) as { meta?: { buildTime?: string; clientRequestId?: string; stage?: string } };
    const providerRequest1 = JSON.parse(
      fs.readFileSync(path.join(sampleDir, 'provider-request_1.json'), 'utf8')
    ) as { meta?: { buildTime?: string; clientRequestId?: string; stage?: string } };

    expect(providerRequest.meta?.stage).toBe('provider-request');
    expect(providerRequest1.meta?.stage).toBe('provider-request');
    expect(providerRequest.meta?.clientRequestId).toBe('req_1782434871078_e3eff4df');
    expect(providerRequest1.meta?.clientRequestId).toBe('req_1782434871078_e3eff4df');
    expect(providerRequest.meta?.buildTime).toBe(providerRequest1.meta?.buildTime);
  });

  it('RED: direct chat tool_calls stream does not revive provider-visible content in host reprojection', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockResolvedValueOnce({
      body: {
        id: 'chatcmpl_direct_toolcall_strip_1',
        object: 'chat.completion',
        model: 'glm-5.2',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_direct_strip_1',
                  type: 'function',
                  function: {
                    name: 'search_content',
                    arguments: '{"glob":"**/*.rs","pattern":"build_client_exec_cli_projection","context":5}'
                  }
                }
              ]
            }
          }
        ]
      },
      sseStream: PassThrough.from([
        'data: {"id":"chatcmpl_direct_toolcall_strip_1","object":"chat.completion.chunk","created":1,"model":"glm-5.2","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl_direct_toolcall_strip_1","object":"chat.completion.chunk","created":1,"model":"glm-5.2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_direct_strip_1","type":"function","function":{"name":"search_content","arguments":""}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl_direct_toolcall_strip_1","object":"chat.completion.chunk","created":1,"model":"glm-5.2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"glob\\":\\"**/*.rs\\",\\"pattern\\":\\"build_client_exec_cli_projection\\",\\"context\\":5}"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl_direct_toolcall_strip_1","object":"chat.completion.chunk","created":1,"model":"glm-5.2","choices":[{"index":0,"delta":{"content":""},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n'
      ]),
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const result = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        providerType: 'openai',
        requestId: 'req_direct_chat_toolcall_strip_1',
        wantsStream: true,
        requestSemantics: {} as any,
        response: {
          body: {},
          sseStream: new EventEmitter(),
          continuationOwner: 'direct',
        } as any,
        pipelineMetadata: buildPipelineMetadata('openai-chat')
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    const stream = result.sseStream as AsyncIterable<Buffer | string>;
    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    }
    const text = chunks.join('');
    expect(text).toContain('"tool_calls"');
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text).not.toContain('现在真相清楚了');
    expect(text).not.toContain('让我读最后一块关键证据');
  });

  it('RED: direct chat tool_calls start chunk must include empty function.arguments for client tool recognition', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockResolvedValueOnce({
      body: {
        id: 'chatcmpl_direct_toolcall_args_seed_1',
        object: 'chat.completion',
        model: 'glm-5.2',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_direct_args_seed_1',
                  type: 'function',
                  function: {
                    name: 'search_content',
                    arguments: '{"glob":"**/*.rs","pattern":"ClientExecCliProjectionOutput","context":5}'
                  }
                }
              ]
            }
          }
        ]
      },
      sseStream: PassThrough.from([
        'data: {"id":"chatcmpl_direct_toolcall_args_seed_1","object":"chat.completion.chunk","created":1,"model":"glm-5.2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_direct_args_seed_1","type":"function","function":{"name":"search_content","arguments":""}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl_direct_toolcall_args_seed_1","object":"chat.completion.chunk","created":1,"model":"glm-5.2","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"glob\\":\\"**/*.rs\\",\\"pattern\\":\\"ClientExecCliProjectionOutput\\",\\"context\\":5}"}}]},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl_direct_toolcall_args_seed_1","object":"chat.completion.chunk","created":1,"model":"glm-5.2","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n'
      ]),
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const result = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        providerType: 'openai',
        requestId: 'req_direct_chat_toolcall_args_seed_1',
        wantsStream: true,
        requestSemantics: {} as any,
        response: {
          body: {},
          sseStream: new EventEmitter(),
          continuationOwner: 'direct',
        } as any,
        pipelineMetadata: buildPipelineMetadata('openai-chat')
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    const stream = result.sseStream as AsyncIterable<Buffer | string>;
    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    }
    const text = chunks.join('');
    expect(text).toContain('"function":{"name":"search_content","arguments":""}');
  });

  it('does not forward executor-local continuation/audit semantics into bridge conversion', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementation(async ({ requestSemantics, context }) => ({
      body: {
        object: 'response',
        id: 'resp_client_converter_1',
        previous_response_id:
          (requestSemantics as any)?.continuation?.resumeFrom?.previousResponseId ?? null,
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'provider-response-converter ok' }]
          }
        ],
        observed_chain_id: (requestSemantics as any)?.continuation?.chainId,
        observed_unsupported_count:
          Array.isArray((requestSemantics as any)?.audit?.protocolMapping?.unsupported)
            ? (requestSemantics as any).audit.protocolMapping.unsupported.length
            : 0,
        observed_captured_has_messages: Array.isArray((context as any)?.capturedChatRequest?.messages)
      }
    }));

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const requestSemantics = {
      continuation: {
        chainId: 'req_chain_converter_1',
        stickyScope: 'request_chain',
        stateOrigin: 'openai-responses',
        resumeFrom: {
          protocol: 'openai-responses',
          requestId: 'req_chain_converter_1',
          previousResponseId: 'resp_prev_converter_1'
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
    };

    const result = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_converter_semantics_1',
        wantsStream: false,
        requestSemantics: requestSemantics as any,
        originalRequest: {
          model: 'claude-sonnet-4-5',
          input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行 converter 语义链' }] }]
        },
        response: {
          body: {
            id: 'msg_provider_converter_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            stop_reason: 'end_turn'
          }
        } as any,
        pipelineMetadata: buildPipelineMetadata('anthropic-messages', {
          capturedChatRequest: {
            model: 'claude-sonnet-4-5',
            messages: [{ role: 'user', content: '继续执行 converter 语义链' }]
          }
        })
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
    const bridgeArgs = mockConvertProviderResponse.mock.calls[0]?.[0] as Record<string, any>;
    expect(bridgeArgs?.providerProtocol).toBe('anthropic-messages');
    expect(bridgeArgs?.entryEndpoint).toBe('/v1/responses');
    expect(bridgeArgs?.requestSemantics).toBeUndefined();

    expect((result as any).body).toMatchObject({
      object: 'response',
      previous_response_id: null,
      observed_unsupported_count: 0,
      observed_captured_has_messages: true
    });
  });

  it('unwraps snapshot-style anthropic provider-response body.data before bridge conversion', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementationOnce(async ({ providerResponse }) => ({
      body: {
        object: 'response',
        id: 'resp_unwrapped_1',
        output: [
          {
            type: 'function_call',
            name: 'apply_patch',
            arguments: JSON.stringify({ patch: '*** Begin Patch\\n*** End Patch' }),
            call_id: 'toolu_1'
          }
        ]
      }
    }));

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const result = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_converter_unwrap_1',
        wantsStream: false,
        requestSemantics: {
          tools: {
            clientToolsRaw: [
              {
                type: 'function',
                function: {
                  name: 'apply_patch',
                  parameters: { type: 'object' }
                }
              }
            ]
          }
        } as any,
        originalRequest: {
          model: 'deepseek-v4-flash',
          input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行' }] }]
        },
        response: {
          body: {
            body: {
              data: {
                id: 'msg_provider_wrapped_1',
                type: 'message',
                role: 'assistant',
                stop_reason: 'tool_use',
                content: [
                  {
                    id: 'toolu_1',
                    type: 'tool_use',
                    name: 'apply_patch',
                    input: {
                      patch: '*** Begin Patch\n*** End Patch'
                    }
                  }
                ]
              }
            },
            headers: {
              'content-type': 'application/json'
            },
            meta: {
              stage: 'provider-response'
            }
          }
        } as any,
        pipelineMetadata: buildPipelineMetadata('anthropic-messages')
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
    const bridgeArgs = mockConvertProviderResponse.mock.calls[0]?.[0] as Record<string, any>;
    expect(bridgeArgs?.providerResponse).toMatchObject({
      id: 'msg_provider_wrapped_1',
      stop_reason: 'tool_use',
      content: [
        expect.objectContaining({
          type: 'tool_use',
          name: 'apply_patch'
        })
      ]
    });
    expect((result as any).body).toMatchObject({
      object: 'response',
      id: 'resp_unwrapped_1',
      output: [
        expect.objectContaining({
          type: 'function_call',
          name: 'apply_patch'
        })
      ]
    });
  });

  it('unwraps provider PipelineExecutionResult.data before bridge conversion for openai-chat responses', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementationOnce(async ({ providerResponse }) => ({
      body: {
        object: 'response',
        id: 'resp_openai_chat_data_unwrapped_1',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'call_exec_data_1',
            arguments: JSON.stringify({ cmd: 'git status --short' })
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_exec_data_1',
                type: 'function',
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: 'git status --short' })
              }
            ]
          }
        },
        observed_provider_response: providerResponse
      }
    }));

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const result = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-chat',
        requestId: 'req_converter_openai_chat_root_data_1',
        wantsStream: true,
        requestSemantics: {} as any,
        response: {
          data: {
            id: 'chatcmpl_root_data_1',
            object: 'chat.completion',
            model: '@cf/zai-org/glm-5.2',
            choices: [
              {
                index: 0,
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_exec_data_1',
                      type: 'function',
                      function: {
                        name: 'exec_command',
                        arguments: JSON.stringify({ cmd: 'git status --short' })
                      }
                    }
                  ]
                }
              }
            ]
          },
          headers: {
            'content-type': 'application/json'
          },
          sseStream: new EventEmitter(),
          status: 200,
          statusText: 'OK'
        } as any,
        pipelineMetadata: buildPipelineMetadata('openai-chat')
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
    const bridgeArgs = mockConvertProviderResponse.mock.calls[0]?.[0] as Record<string, any>;
    expect(bridgeArgs?.providerResponse).toMatchObject({
      id: 'chatcmpl_root_data_1',
      object: 'chat.completion',
      model: '@cf/zai-org/glm-5.2',
      choices: [
        expect.objectContaining({
          finish_reason: 'tool_calls',
          message: expect.objectContaining({
            tool_calls: [
              expect.objectContaining({
                function: expect.objectContaining({
                  name: 'exec_command'
                })
              })
            ]
          })
        })
      ]
    });
    expect((result as any).body).toMatchObject({
      object: 'response',
      id: 'resp_openai_chat_data_unwrapped_1',
      required_action: {
        type: 'submit_tool_outputs'
      }
    });
  });

  it('RED: preserves top-level data payload for SSE openai-chat responses before bridge conversion', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementationOnce(async ({ providerResponse }) => ({
      body: {
        object: 'response',
        id: 'resp_openai_chat_sse_data_unwrapped_1',
        status: 'requires_action',
        observed_provider_response: providerResponse
      }
    }));

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const sseStream = new PassThrough();
    sseStream.end('data: [DONE]\n\n');

    const result = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-chat',
        requestId: 'req_converter_openai_chat_sse_data_1',
        wantsStream: true,
        requestSemantics: {} as any,
        response: {
          data: {
            id: 'chatcmpl_sse_data_1',
            object: 'chat.completion',
            model: '@cf/zai-org/glm-5.2',
            choices: [
              {
                index: 0,
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_exec_sse_data_1',
                      type: 'function',
                      function: {
                        name: 'exec_command',
                        arguments: JSON.stringify({ cmd: 'git status --short' })
                      }
                    }
                  ]
                }
              }
            ]
          },
          headers: {
            'content-type': 'application/json'
          },
          sseStream,
          status: 200,
          statusText: 'OK'
        } as any,
        pipelineMetadata: buildPipelineMetadata('openai-chat')
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
    const bridgeArgs = mockConvertProviderResponse.mock.calls[0]?.[0] as Record<string, any>;
    expect(bridgeArgs?.providerResponse).toMatchObject({
      id: 'chatcmpl_sse_data_1',
      object: 'chat.completion',
      choices: [
        expect.objectContaining({
          finish_reason: 'tool_calls'
        })
      ]
    });
    expect((result as any).body).toMatchObject({
      object: 'response',
      id: 'resp_openai_chat_sse_data_unwrapped_1'
    });
  });

  it('normalizes responses required_action exec_command arguments through rust ssot before host validation', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockResolvedValueOnce({
      body: {
        object: 'response',
        id: 'resp_tool_args_repaired_1',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'call_exec_1',
            arguments: JSON.stringify({ cmd: 'pwd' }),
            function: {
              name: 'exec_command',
              arguments: JSON.stringify({ cmd: 'pwd' })
            }
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_exec_1',
                type: 'function',
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: 'pwd' }),
                function: {
                  name: 'exec_command',
                  arguments: JSON.stringify({ cmd: 'pwd' })
                }
              }
            ]
          }
        }
      }
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const result = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_responses_tool_args_repaired_1',
        wantsStream: false,
        requestSemantics: {
          tools: {
            clientToolsRaw: [
              {
                type: 'function',
                function: {
                  name: 'exec_command',
                  parameters: {
                    type: 'object',
                    properties: {
                      cmd: { type: 'string' }
                    },
                    required: ['cmd'],
                    additionalProperties: false
                  }
                }
              }
            ]
          }
        } as any,
        originalRequest: {
          model: 'gpt-5.4',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'run pwd' }] }]
        },
        response: {
          body: {
            id: 'provider_resp_repaired_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'done' }],
            stop_reason: 'tool_use'
          }
        } as any,
        pipelineMetadata: buildPipelineMetadata('anthropic-messages', {
          capturedChatRequest: {
            model: 'gpt-5.4',
            tools: [
              {
                type: 'function',
                function: {
                  name: 'exec_command',
                  parameters: {
                    type: 'object',
                    properties: {
                      cmd: { type: 'string' }
                    },
                    required: ['cmd'],
                    additionalProperties: false
                  }
                }
              }
            ]
          }
        })
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    const toolCall = (result.body as any)?.required_action?.submit_tool_outputs?.tool_calls?.[0];
    expect(toolCall?.arguments).toBe(JSON.stringify({ cmd: 'pwd' }));
    expect(toolCall?.function?.arguments).toBe(JSON.stringify({ cmd: 'pwd' }));
    expect((result.body as any)?.output?.[0]?.arguments).toBe(JSON.stringify({ cmd: 'pwd' }));
  });

  it('preserves anthropic tool_use on real reasoning_stop_guard followup sample instead of collapsing to empty tool_calls', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const sampleDir = path.join(
      '/Volumes/extension/.rcc/codex-samples/openai-responses/mimo.key1.mimo-v2.5-pro',
      'openai-responses-mimo.key1-mimo-v2.5-pro-20260507T220242798-168767-1436_reasoning_stop_guard'
    );
    if (!fs.existsSync(sampleDir)) {
      return;
    }

    const { convertProviderResponse: coreConvertProviderResponse } = await import(
      '../../../../../src/modules/llmswitch/bridge/provider-response-converter-host.js'
    );
    mockConvertProviderResponse.mockImplementation(async (args) => coreConvertProviderResponse(args as any));

    const providerResponseDoc = JSON.parse(
      fs.readFileSync(path.join(sampleDir, 'provider-response.json'), 'utf8')
    ) as Record<string, any>;

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const result = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_converter_real_reasoning_stop_guard_followup',
        wantsStream: false,
        requestSemantics: {
          tools: {
            clientToolsRaw: [
              {
                type: 'function',
                function: {
                  name: 'exec_command',
                  parameters: {
                    type: 'object',
                    properties: { cmd: { type: 'string' } },
                    required: ['cmd']
                  }
                }
              }
            ]
          },
          __routecodex: {}
        } as any,
        originalRequest: {
          model: 'mimo-v2.5-pro',
          input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行' }] }]
        },
        response: providerResponseDoc as any,
        pipelineMetadata: buildPipelineMetadata('anthropic-messages', {
          capturedChatRequest: {
            model: 'mimo-v2.5-pro',
            messages: [{ role: 'user', content: '继续执行' }],
            tools: [
              {
                type: 'function',
                function: {
                  name: 'exec_command',
                  parameters: { type: 'object' }
                }
              }
            ]
          },
          __rt: {
            clientProtocol: 'openai-responses'
          }
        })
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    const body = (result as any).body;
    const toolCalls = body?.choices?.[0]?.message?.tool_calls;
    expect(Array.isArray(toolCalls)).toBe(true);
    expect(toolCalls?.[0]?.function?.name).toBe('exec_command');
    expect(body?.choices?.[0]?.finish_reason).toBe('tool_calls');
  });

  it('replays exact 5520 GLM body.data chat sample through host converter without dropping choices before bridge handoff', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const samplePath = path.join(
      process.env.HOME || '',
      '.rcc/codex-samples/openai-responses/ports/5520/XLC.key1.glm-5.2/req_1782124799816_fe2dd785/provider-response.json'
    );
    if (!fs.existsSync(samplePath)) {
      return;
    }

    const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8')) as Record<string, any>;
    mockConvertProviderResponse.mockImplementationOnce(async ({ providerResponse }) => ({
      body: {
        object: 'response',
        id: 'resp_glm_5520_sample_1',
        status: 'requires_action',
        output: [
          {
            type: 'function_call',
            name: 'exec_command',
            call_id: 'call_glm_sample_1',
            arguments: JSON.stringify({ cmd: 'pwd' })
          }
        ],
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [
              {
                id: 'call_glm_sample_1',
                type: 'function',
                name: 'exec_command',
                arguments: JSON.stringify({ cmd: 'pwd' })
              }
            ]
          }
        },
        observed_provider_response: providerResponse
      }
    }));

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const result = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-chat',
        requestId: 'req_glm_5520_sample_replay_1',
        wantsStream: true,
        requestSemantics: {} as any,
        response: sample.body as any,
        pipelineMetadata: buildPipelineMetadata('openai-chat')
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
    const bridgeArgs = mockConvertProviderResponse.mock.calls[0]?.[0] as Record<string, any>;
    expect(bridgeArgs?.providerProtocol).toBe('openai-chat');
    expect(bridgeArgs?.providerResponse).toMatchObject({
      object: 'chat.completion',
      model: 'glm-5.2',
      choices: [
        expect.objectContaining({
          finish_reason: 'tool_calls',
          message: expect.objectContaining({
            tool_calls: expect.arrayContaining([
              expect.objectContaining({
                function: expect.objectContaining({
                  name: 'exec_command'
                })
              })
            ])
          })
        })
      ]
    });
    expect((result as any).body).toMatchObject({
      object: 'response',
      id: 'resp_glm_5520_sample_1',
      required_action: {
        type: 'submit_tool_outputs'
      }
    });
  });

  it('failing-shape replay: preserves empty completed payload for downstream response-contract gate', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockResolvedValueOnce({
      body: {
        object: 'response',
        id: 'resp_empty_output_contract_1',
        status: 'completed',
        output: []
      }
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const converted = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        requestId: 'req_empty_output_contract_1',
        wantsStream: false,
        requestSemantics: {} as any,
        originalRequest: { model: 'gpt-5', input: 'hello' } as any,
        response: { body: { status: 'completed', output: [] } } as any,
        pipelineMetadata: buildPipelineMetadata('openai-responses')
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined
        },
        executeNested: async () => ({ body: { ok: true } } as any)
      }
    );

    expect((converted as any).body).toMatchObject({
      object: 'response',
      id: 'resp_empty_output_contract_1',
      status: 'completed',
      output: []
    });
    expect(Array.isArray((converted as any).body?.output)).toBe(true);
    expect((converted as any).body?.output).toHaveLength(0);
  });

  it('preserves explicit providerProtocol on /v1/responses instead of remapping from providerType', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementationOnce(async ({ providerProtocol, entryEndpoint }) => ({
      sseStream:
        providerProtocol === 'openai-responses' && entryEndpoint === '/v1/responses'
          ? ({ pipe: () => undefined } as any)
          : undefined,
      body: {
        id: 'resp_protocol_preserved_1',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: `protocol=${String(providerProtocol)}` }],
          },
        ],
      },
    }));

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const result = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        providerType: 'openai',
        requestId: 'req_converter_protocol_preserve_1',
        wantsStream: true,
        response: {
          body: {
            id: 'chatcmpl_protocol_preserve_1',
            object: 'chat.completion',
            model: 'gpt-5.4-medium',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'hello' },
                finish_reason: 'stop',
              },
            ],
          },
        } as any,
        pipelineMetadata: buildPipelineMetadata('openai-responses'),
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined,
        },
        executeNested: async () => ({ body: { ok: true } } as any),
      },
    );

    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
    const bridgeArgs = mockConvertProviderResponse.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(bridgeArgs?.providerProtocol).toBe('openai-responses');
    expect((result as any).sseStream).toBeDefined();
  });

  it('preserves provider inbound protocol truth on /v1/responses even when wrapper payload looks like responses output', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementationOnce(async ({ providerProtocol }) => ({
      body: {
        id: 'resp_protocol_truth_bridge_1',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: `protocol=${String(providerProtocol)}` }],
          },
        ],
      },
    }));

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const result = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-chat',
        providerType: 'deepseek',
        requestId: 'req_converter_protocol_truth_bridge_1',
        wantsStream: false,
        response: {
          body: {
            clientStream: false,
            mode: 'sse',
            payload: {
              id: 'resp_protocol_truth_bridge_1',
              object: 'response',
              status: 'completed',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'wrapped payload' }]
                }
              ]
            }
          },
          continuationOwner: 'relay'
        } as any,
        pipelineMetadata: buildPipelineMetadata('openai-chat'),
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined,
        },
        executeNested: async () => ({ body: { ok: true } } as any),
      },
    );

    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
    const bridgeArgs = mockConvertProviderResponse.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(bridgeArgs?.providerProtocol).toBe('openai-chat');
    expect(bridgeArgs?.providerResponse).toMatchObject({
      id: 'resp_protocol_truth_bridge_1',
      object: 'response',
      status: 'completed'
    });
    expect((result as any).body).toMatchObject({
      id: 'resp_protocol_truth_bridge_1',
      object: 'response',
      status: 'completed',
    });
  });

  it('does not forward requestSemantics or backfill clientToolsRaw from entryOriginRequest in host converter', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockImplementationOnce(async ({ requestSemantics }) => ({
      body: {
        id: 'resp_request_semantics_passthrough_1',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: JSON.stringify(requestSemantics ?? null) }]
          }
        ]
      }
    }));

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const requestSemantics = {
      tools: {
        explicitEmpty: true
      }
    } as any;

    await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_request_semantics_passthrough_1',
        wantsStream: false,
        requestSemantics,
        entryOriginRequest: {
          tools: [
            {
              type: 'function',
              function: {
                name: 'exec_command',
                parameters: { type: 'object' }
              }
            }
          ]
        } as any,
        response: {
          body: {
            id: 'msg_request_semantics_passthrough_1',
            type: 'message',
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'done' }]
          }
        } as any,
        pipelineMetadata: buildPipelineMetadata('anthropic-messages')
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined,
        },
        executeNested: async () => ({ body: { ok: true } } as any),
      },
    );

    const bridgeArgs = mockConvertProviderResponse.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(bridgeArgs?.requestSemantics).toBeUndefined();
    expect((bridgeArgs?.requestSemantics as any)?.tools?.clientToolsRaw).toBeUndefined();
  });

  it('leaves direct chat tool-call SSE projection to the bridge owner', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const providerSse = Readable.from([
      'data: {"id":"chatcmpl_direct_reproject_1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"visible text"},"finish_reason":null}]}\n\n',
      'data: [DONE]\n\n'
    ]);

    mockConvertProviderResponse.mockImplementationOnce(async () => ({
      sseStream: providerSse,
      body: {
        id: 'chatcmpl_direct_reproject_1',
        object: 'chat.completion',
        model: 'test-model',
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_exec_1',
                  type: 'function',
                  function: {
                    name: 'exec_command',
                    arguments: '{"cmd":"pwd"}'
                  }
                }
              ]
            }
          }
        ]
      }
    }));

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const converted = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/chat/completions',
        providerProtocol: 'openai-chat',
        requestId: 'req_direct_reproject_no_backfill_1',
        wantsStream: true,
        response: {
          body: {
            id: 'chatcmpl_direct_reproject_1',
            object: 'chat.completion'
          },
          continuationOwner: 'direct'
        } as any,
        pipelineMetadata: buildPipelineMetadata('openai-chat')
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined,
        },
        executeNested: async () => ({ body: { ok: true } } as any),
      },
    );

    expect(converted.sseStream).toBe(providerSse);
    expect((converted.body as any)?.choices?.[0]?.message?.content).toBeNull();
  });

  it('fails marker-only provider SSE wrapper before Rust bridge conversion on live executor converter path', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    await expect(convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages',
        providerType: 'anthropic',
        providerFamily: 'anthropic',
        providerKey: 'mimo.key2.mimo-v2.5',
        requestId: 'req_live_marker_only_wrapper_240540',
        wantsStream: true,
        response: {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            body: { captureSse: true, mode: 'sse', transport: 'prepared-request-executor' }
          }
        } as any,
        pipelineMetadata: buildPipelineMetadata('anthropic-messages')
      },
      {
        runtimeManager: {
          resolveRuntimeKey: () => undefined,
          getHandleByRuntimeKey: () => undefined,
        },
        executeNested: async () => ({ body: { ok: true } } as any),
      },
    )).rejects.toThrow('sseStream');
    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
  });
});
