import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Readable } from 'node:stream';
import type { StageRecorder } from '../../sharedmodule/llmswitch-core/src/conversion/hub/format-adapters/index.js';

const recordResponsesResponseMock = jest.fn();

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js', () => ({
  finalizeResponsesConversationRequestRetention: jest.fn(),
  recordResponsesResponse: recordResponsesResponseMock,
}));

const { convertProviderResponse } = await import(
  '../../sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.js'
);

class StubStageRecorder implements StageRecorder {
  public entries: Array<{ stage: string; payload: object }> = [];

  record(stage: string, payload: object): void {
    this.entries.push({ stage, payload });
  }
}

async function readStreamBody(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function buildMimoAnthropicStopSse(): string {
  return [
    ': PROCESSING',
    '',
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_mimo_stop_sse","type":"message","role":"assistant","model":"mimo-v2.5","content":[],"usage":{"input_tokens":0,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"Need continue."},"index":0}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"signature_delta","signature":""},"index":0}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Stopped without schema."},"index":1}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":1}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":97,"output_tokens":13}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    ''
  ].join('\n');
}

function buildOpenAiResponsesCompletedStopSse(): string {
  const response = {
    id: 'resp_openai_responses_stop_sse',
    object: 'response',
    status: 'completed',
    model: 'gpt-test',
    output: [{
      id: 'msg_openai_responses_stop_sse',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'I stopped without schema.' }]
    }],
    output_text: 'I stopped without schema.',
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
  };
  return [
    'event: response.completed',
    `data: ${JSON.stringify({ type: 'response.completed', response })}`,
    '',
    'event: response.done',
    `data: ${JSON.stringify({ type: 'response.done', response })}`,
    '',
    ''
  ].join('\n');
}

describe('provider response Rust native plan', () => {
  beforeEach(() => {
    recordResponsesResponseMock.mockClear();
  });

  it('uses Rust HubPipeline native response plan for non-side-effect response path', async () => {
    const recorder = new StubStageRecorder();
    const context: Record<string, unknown> = {
      requestId: 'req_provider_response_native_plan_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    };

    const result = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: {
        id: 'chatcmpl_native_plan_1',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'native ok' },
          finish_reason: 'stop'
        }]
      },
      context: context as any,
      entryEndpoint: '/v1/chat/completions',
      wantsStream: false,
      stageRecorder: recorder
    });

    expect(result.body?.choices?.[0]?.message?.content).toBe('native ok');
    expect(result.__sse_responses).toBeUndefined();
    expect(context.__nativeResponsePlan).toEqual(expect.objectContaining({
      effectPlan: {
        effects: [expect.objectContaining({
          kind: 'runtimeStateWrite',
          payload: expect.objectContaining({
            requestId: 'req_provider_response_native_plan_1',
            clientProtocol: 'openai-chat',
            payload: result.body,
            keepForSubmitToolOutputs: false
          })
        })]
      },
      diagnostics: expect.any(Array)
    }));
    expect(recorder.entries.map((entry) => entry.stage)).toContain('chat_process.resp.stage9.client_remap');
    expect(recorder.entries.map((entry) => entry.stage)).toContain('chat_process.resp.stage10.sse_stream');
  });

  it('does not record Responses conversation before handler captures request context', async () => {
    const context: Record<string, unknown> = {
      requestId: 'openai-responses-mimo.key2-mimo-v2.5-20260531T215233443-242655-2116',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'anthropic-messages'
    };

    await convertProviderResponse({
      providerProtocol: 'anthropic-messages',
      providerResponse: {
        id: 'msg_059b419d6ffe4fd7a726432c',
        type: 'message',
        role: 'assistant',
        model: 'mimo-v2.5',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      context: context as any,
      entryEndpoint: '/v1/responses',
      wantsStream: false
    });

    expect(recordResponsesResponseMock).not.toHaveBeenCalled();
  });

  it('projects stopless CLI command instead of reentering followup for Anthropic relay stop', async () => {
    const suffix = `anthropic_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const context: Record<string, unknown> = {
      requestId: `req_provider_response_stopless_followup_projection_${suffix}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'anthropic-messages',
      sessionId: `provider-response-stopless-followup-projection-${suffix}`,
      __rt: {
        stopMessageEnabled: true,
        routecodexPortStopMessageEnabled: true
      },
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'continue' }]
      }
    };
    const reenterPipeline = jest.fn(async () => ({
      body: {
        id: 'chatcmpl_stopless_followup_projection',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'continued' },
          finish_reason: 'stop'
        }]
      }
    }));

    const result = await convertProviderResponse({
      providerProtocol: 'anthropic-messages',
      providerResponse: {
        id: 'msg_stopless_followup_projection',
        type: 'message',
        role: 'assistant',
        model: 'MiniMax-M3',
        content: [{ type: 'text', text: 'I stopped without schema.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      context: context as any,
      entryEndpoint: '/v1/responses',
      wantsStream: false,
      reenterPipeline: reenterPipeline as any
    });

    expect(reenterPipeline).toHaveBeenCalledTimes(0);
    expect(result.body?.object).toBe('response');
    expect(result.body?.output).toEqual(expect.any(Array));
    const bodyText = JSON.stringify(result.body);
    expect(bodyText).toContain('exec_command');
    expect(bodyText).toContain('routecodex servertool run stop_message_auto');
    expect(bodyText).toContain('stop_message_flow');
  });

  it('projects stopless CLI command for captured mimo Anthropic SSE stop shape', async () => {
    const suffix = `mimo_sse_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const context: Record<string, unknown> = {
      requestId: `req_provider_response_mimo_sse_stopless_${suffix}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'anthropic-messages',
      sessionId: `provider-response-mimo-sse-stopless-${suffix}`
    };

    const result = await convertProviderResponse({
      providerProtocol: 'anthropic-messages',
      providerResponse: { __sse_responses: Readable.from([buildMimoAnthropicStopSse()]) },
      context: context as any,
      entryEndpoint: '/v1/responses',
      wantsStream: false,
      clientInjectDispatch: jest.fn(async () => ({ ok: true })) as any
    });

    expect(result.body?.object).toBe('response');
    expect(result.body?.status).toBe('requires_action');
    const bodyText = JSON.stringify(result.body);
    expect(bodyText).toContain('exec_command');
    expect(bodyText).toContain('routecodex servertool run stop_message_auto');
    expect(bodyText).toContain('stop_message_flow');
    expect(context.__nativeResponsePlan).toEqual(expect.objectContaining({
      runtimeEffects: expect.objectContaining({
        servertoolRuntimeActions: expect.arrayContaining([
          expect.objectContaining({
            reason: 'stop_eligible_followup',
            stopGateway: expect.objectContaining({
              eligible: true,
              reason: 'finish_reason_stop'
            })
          })
        ])
      })
    }));
  });

  it('projects stopless CLI command for relay OpenAI Responses completed stop', async () => {
    const suffix = `responses_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const context: Record<string, unknown> = {
      requestId: `req_provider_response_responses_stopless_cli_projection_${suffix}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      sessionId: `provider-response-responses-stopless-cli-projection-${suffix}`,
      stopMessageEnabled: true,
      routecodexPortStopMessageEnabled: true,
      capturedEntryRequest: {
        model: 'gpt-test',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'continue' }] }]
      }
    };

    const result = await convertProviderResponse({
      providerProtocol: 'openai-responses',
      providerResponse: {
        id: 'resp_stopless_cli_projection',
        object: 'response',
        status: 'completed',
        model: 'gpt-test',
        output: [{
          id: 'msg_stopless_cli_projection',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'I stopped without schema.' }]
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      },
      context: context as any,
      entryEndpoint: '/v1/responses',
      wantsStream: false,
      clientInjectDispatch: jest.fn(async () => ({ ok: true })) as any
    });

    expect(result.body?.object).toBe('response');
    const outputText = JSON.stringify(result.body);
    expect(outputText).toContain('exec_command');
    expect(outputText).toContain('routecodex servertool run stop_message_auto');
    expect(outputText).toContain('stop_message_flow');
    const output = Array.isArray((result.body as any)?.output) ? (result.body as any).output : [];
    const reasoning = output.find((item: any) => item?.type === 'reasoning');
    expect(reasoning).toBeDefined();
  });

  it('projects stopless CLI command for relay OpenAI Responses completed stop without session scope', async () => {
    const suffix = `responses_scope_free_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const context: Record<string, unknown> = {
      requestId: `req_provider_response_responses_stopless_cli_projection_scope_free_${suffix}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      stopMessageEnabled: true,
      routecodexPortStopMessageEnabled: true,
      capturedEntryRequest: {
        model: 'gpt-test',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'continue' }] }]
      }
    };

    const result = await convertProviderResponse({
      providerProtocol: 'openai-responses',
      providerResponse: {
        id: 'resp_stopless_cli_projection_scope_free',
        object: 'response',
        status: 'completed',
        model: 'gpt-test',
        output: [{
          id: 'msg_stopless_cli_projection_scope_free',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'I stopped without schema.' }]
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      },
      context: context as any,
      entryEndpoint: '/v1/responses',
      wantsStream: false,
      clientInjectDispatch: jest.fn(async () => ({ ok: true })) as any
    });

    expect(result.body?.object).toBe('response');
    const outputText = JSON.stringify(result.body);
    expect(outputText).toContain('exec_command');
    expect(outputText).toContain('routecodex servertool run stop_message_auto');
    expect(outputText).toContain('stop_message_flow');
    expect(outputText).toContain('"status":"requires_action"');
  });

  it('does not project stopless CLI command for relay OpenAI Responses completed stop when stop message is disabled', async () => {
    const suffix = `responses_scope_free_disabled_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const context: Record<string, unknown> = {
      requestId: `req_provider_response_responses_stopless_cli_projection_scope_free_disabled_${suffix}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      stopMessageEnabled: false,
      routecodexPortStopMessageEnabled: false,
      capturedEntryRequest: {
        model: 'gpt-test',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'continue' }] }]
      }
    };

    const result = await convertProviderResponse({
      providerProtocol: 'openai-responses',
      providerResponse: {
        id: 'resp_stopless_cli_projection_scope_free_disabled',
        object: 'response',
        status: 'completed',
        model: 'gpt-test',
        output: [{
          id: 'msg_stopless_cli_projection_scope_free_disabled',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'I stopped without schema.' }]
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      },
      context: context as any,
      entryEndpoint: '/v1/responses',
      wantsStream: false,
      clientInjectDispatch: jest.fn(async () => ({ ok: true })) as any
    });

    const outputText = JSON.stringify(result.body);
    expect(outputText).not.toContain('exec_command');
    expect(outputText).not.toContain('stop_message_flow');
    expect((result.body as any)?.status).toBe('completed');
  });

  it('streams stopless CLI command for relay OpenAI Responses completed stop', async () => {
    const suffix = `responses_stream_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const context: Record<string, unknown> = {
      requestId: `req_provider_response_responses_stopless_cli_projection_stream_${suffix}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      sessionId: `provider-response-responses-stopless-cli-projection-stream-${suffix}`,
      stopMessageEnabled: true,
      routecodexPortStopMessageEnabled: true,
      capturedEntryRequest: {
        model: 'gpt-test',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'continue' }] }]
      }
    };

    const result = await convertProviderResponse({
      providerProtocol: 'openai-responses',
      providerResponse: {
        id: 'resp_stopless_cli_projection_stream',
        object: 'response',
        status: 'completed',
        model: 'gpt-test',
        output: [{
          id: 'msg_stopless_cli_projection_stream',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'I stopped without schema.' }]
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
      },
      context: context as any,
      entryEndpoint: '/v1/responses',
      wantsStream: true,
      clientInjectDispatch: jest.fn(async () => ({ ok: true })) as any
    });

    expect(result.__sse_responses).toBeDefined();
    const sseBody = await readStreamBody(result.__sse_responses!);
    expect(sseBody).toContain('exec_command');
    expect(sseBody).toContain('routecodex servertool run stop_message_auto');
    expect(sseBody).toContain('stop_message_flow');
    expect(sseBody).toContain('event: response.done');
    expect(sseBody).toContain('"status":"requires_action"');
  });

  it('streams stopless CLI command for relay OpenAI Responses SSE completed stop', async () => {
    const suffix = `responses_sse_stream_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const context: Record<string, unknown> = {
      requestId: `req_provider_response_responses_sse_stopless_cli_projection_stream_${suffix}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      sessionId: `provider-response-responses-sse-stopless-cli-projection-stream-${suffix}`,
      stopMessageEnabled: true,
      routecodexPortStopMessageEnabled: true,
      capturedEntryRequest: {
        model: 'gpt-test',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'continue' }] }]
      }
    };

    const result = await convertProviderResponse({
      providerProtocol: 'openai-responses',
      providerResponse: {
        __sse_responses: Readable.from([buildOpenAiResponsesCompletedStopSse()])
      },
      context: context as any,
      entryEndpoint: '/v1/responses',
      wantsStream: true,
      clientInjectDispatch: jest.fn(async () => ({ ok: true })) as any
    });

    expect(result.body?.object).toBe('response');
    expect(result.body?.status).toBe('requires_action');
    expect(JSON.stringify(result.body)).toContain('exec_command');
    expect(JSON.stringify(result.body)).toContain('routecodex hook run reasoning_stop');
    expect(result.__sse_responses).toBeDefined();
    const sseBody = await readStreamBody(result.__sse_responses!);
    expect(sseBody).toContain('exec_command');
    expect(sseBody).toContain('routecodex hook run reasoning_stop');
    expect(sseBody).toContain('event: response.done');
    expect(sseBody).toContain('"status":"requires_action"');
    expect(sseBody).not.toContain('resp_openai_responses_stop_sse');
  });

  it('uses Rust streamPipe effect plan for streaming response path', async () => {
    const recorder = new StubStageRecorder();
    const context: Record<string, unknown> = {
      requestId: 'req_provider_response_native_stream_plan_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    };

    const result = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: {
        id: 'chatcmpl_native_stream_plan_1',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'native stream ok' },
          finish_reason: 'stop'
        }]
      },
      context: context as any,
      entryEndpoint: '/v1/chat/completions',
      wantsStream: true,
      stageRecorder: recorder
    });

    expect(result.body?.choices?.[0]?.message?.content).toBe('native stream ok');
    expect(result.__sse_responses).toBeDefined();
    const sseBody = await readStreamBody(result.__sse_responses!);
    expect(sseBody).toContain('data:');
    expect(sseBody).toContain('native stream ok');
    expect(sseBody).toContain('[DONE]');
    expect(context.__nativeResponsePlan).toEqual(expect.objectContaining({
      effectPlan: expect.objectContaining({
        effects: expect.arrayContaining([
          expect.objectContaining({
            kind: 'streamPipe',
            payload: expect.objectContaining({
              codec: 'openai-chat',
              requestId: 'req_provider_response_native_stream_plan_1',
              payload: result.body
            })
          }),
          expect.objectContaining({
            kind: 'runtimeStateWrite',
            payload: expect.objectContaining({
              requestId: 'req_provider_response_native_stream_plan_1',
              clientProtocol: 'openai-chat',
              payload: result.body,
              keepForSubmitToolOutputs: false
            })
          })
        ])
      }),
      diagnostics: expect.any(Array)
    }));
    expect(recorder.entries.map((entry) => entry.stage)).toEqual([
      'chat_process.resp.stage9.client_remap',
      'chat_process.resp.stage10.sse_stream'
    ]);
  });

  it('does not bypass Rust native response plan for clock runtime metadata', async () => {
    const recorder = new StubStageRecorder();
    const context: Record<string, unknown> = {
      requestId: 'req_provider_response_native_clock_plan_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      __rt: { clock: { enabled: true, dataDir: '/tmp/rcc-clock-native-plan-test' } }
    };

    const result = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: {
        id: 'chatcmpl_native_clock_plan_1',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'native clock ok' },
          finish_reason: 'stop'
        }]
      },
      context: context as any,
      entryEndpoint: '/v1/chat/completions',
      wantsStream: false,
      stageRecorder: recorder
    });

    expect(result.body?.choices?.[0]?.message?.content).toBe('native clock ok');
    expect(context.__nativeResponsePlan).toEqual(expect.objectContaining({
      effectPlan: expect.objectContaining({
        effects: expect.arrayContaining([
          expect.objectContaining({
            kind: 'runtimeStateWrite',
            payload: expect.objectContaining({
              requestId: 'req_provider_response_native_clock_plan_1',
              clientProtocol: 'openai-chat',
              payload: result.body
            })
          })
        ])
      })
    }));
    expect(recorder.entries.map((entry) => entry.stage)).toEqual([
      'chat_process.resp.stage9.client_remap',
      'chat_process.resp.stage10.sse_stream'
    ]);
  });

  it('does not bypass Rust native response plan for webSearch runtime config without executors', async () => {
    const recorder = new StubStageRecorder();
    const context: Record<string, unknown> = {
      requestId: 'req_provider_response_native_websearch_plan_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      __rt: { webSearch: { enabled: true, engines: [] } }
    };

    const result = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: {
        id: 'chatcmpl_native_websearch_plan_1',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'native websearch ok' },
          finish_reason: 'stop'
        }]
      },
      context: context as any,
      entryEndpoint: '/v1/chat/completions',
      wantsStream: false,
      stageRecorder: recorder
    });

    expect(result.body?.choices?.[0]?.message?.content).toBe('native websearch ok');
    expect(context.__nativeResponsePlan).toEqual(expect.objectContaining({
      effectPlan: expect.objectContaining({
        effects: expect.arrayContaining([
          expect.objectContaining({
            kind: 'runtimeStateWrite',
            payload: expect.objectContaining({
              requestId: 'req_provider_response_native_websearch_plan_1',
              clientProtocol: 'openai-chat',
              payload: result.body
            })
          })
        ])
      })
    }));
    expect(recorder.entries.map((entry) => entry.stage)).toEqual([
      'chat_process.resp.stage9.client_remap',
      'chat_process.resp.stage10.sse_stream'
    ]);
  });

  it('does not bypass Rust native response plan when executor callbacks exist but response has no runnable servertool action', async () => {
    const recorder = new StubStageRecorder();
    const context: Record<string, unknown> = {
      requestId: 'req_provider_response_native_callbacks_no_tool_plan_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    };

    const result = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: {
        id: 'chatcmpl_native_callbacks_no_tool_plan_1',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'native callbacks no tool ok' },
          finish_reason: 'length'
        }]
      },
      context: context as any,
      entryEndpoint: '/v1/chat/completions',
      wantsStream: false,
      stageRecorder: recorder,
      providerInvoker: async () => ({ response: {} as any })
    });

    expect(result.body?.choices?.[0]?.message?.content).toBe('native callbacks no tool ok');
    expect(context.__nativeResponsePlan).toEqual(expect.objectContaining({
      effectPlan: expect.objectContaining({
        effects: expect.arrayContaining([
          expect.objectContaining({ kind: 'runtimeStateWrite' })
        ])
      })
    }));
    expect(recorder.entries.map((entry) => entry.stage)).toEqual([
      'chat_process.resp.stage9.client_remap',
      'chat_process.resp.stage10.sse_stream'
    ]);
  });

  it('uses Rust servertoolRuntimeAction effect for stop eligible callback path', async () => {
    const recorder = new StubStageRecorder();
    const context: Record<string, unknown> = {
      requestId: 'req_provider_response_servertool_stop_guard_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    };

    const result = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: {
        id: 'chatcmpl_servertool_stop_guard_1',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'stop needs servertool' },
          finish_reason: 'stop'
        }]
      },
      context: context as any,
      entryEndpoint: '/v1/chat/completions',
      wantsStream: false,
      stageRecorder: recorder,
      providerInvoker: async () => ({ response: {} as any })
    });

    expect(result.body?.choices?.[0]?.finish_reason).toBe('tool_calls');
    const bodyText = JSON.stringify(result.body);
    expect(bodyText).toContain('exec_command');
    expect(bodyText).toContain('routecodex servertool run stop_message_auto');
    expect(context.__nativeResponsePlan).toEqual(expect.objectContaining({
      effectPlan: expect.objectContaining({
        effects: expect.arrayContaining([
          expect.objectContaining({
            kind: 'servertoolRuntimeAction',
            payload: expect.objectContaining({
              action: 'requireRuntimeExecutor',
              reason: 'stop_eligible_followup',
              requestId: 'req_provider_response_servertool_stop_guard_1',
              stopGateway: expect.objectContaining({
                observed: true,
                eligible: true,
                source: 'chat',
                reason: 'finish_reason_stop',
                choice_index: 0,
                has_tool_calls: false
              })
            })
          })
        ])
      })
    }));
    expect(context.__rt).toEqual(expect.objectContaining({
      stopGatewayContext: expect.objectContaining({
        observed: true,
        eligible: true,
        source: 'chat',
        reason: 'finish_reason_stop',
        choiceIndex: 0,
        hasToolCalls: false
      })
    }));
  });

  it('does not bypass Rust native response plan for inert servertool runtime config', async () => {
    const recorder = new StubStageRecorder();
    const context: Record<string, unknown> = {
      requestId: 'req_provider_response_native_servertool_config_plan_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      __rt: { servertool: { enabled: true } }
    };

    const result = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: {
        id: 'chatcmpl_native_servertool_config_plan_1',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'native servertool config ok' },
          finish_reason: 'length'
        }]
      },
      context: context as any,
      entryEndpoint: '/v1/chat/completions',
      wantsStream: false,
      stageRecorder: recorder
    });

    expect(result.body?.choices?.[0]?.message?.content).toBe('native servertool config ok');
    expect(context.__nativeResponsePlan).toEqual(expect.objectContaining({
      effectPlan: expect.objectContaining({
        effects: expect.arrayContaining([
          expect.objectContaining({ kind: 'runtimeStateWrite' })
        ])
      })
    }));
    expect(recorder.entries.map((entry) => entry.stage)).toEqual([
      'chat_process.resp.stage9.client_remap',
      'chat_process.resp.stage10.sse_stream'
    ]);
  });

  it('does not bypass Rust native response plan for inert serverToolFollowup metadata', async () => {
    const recorder = new StubStageRecorder();
    const context: Record<string, unknown> = {
      requestId: 'req_provider_response_native_followup_inert_plan_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      __rt: { serverToolFollowup: true, serverToolFollowupSource: 'servertool.reasoning_stop_continue' }
    };

    const result = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: {
        id: 'chatcmpl_native_followup_inert_plan_1',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'native followup inert ok' },
          finish_reason: 'length'
        }]
      },
      context: context as any,
      entryEndpoint: '/v1/chat/completions',
      wantsStream: false,
      stageRecorder: recorder
    });

    expect(result.body?.choices?.[0]?.message?.content).toBe('native followup inert ok');
    expect(context.__nativeResponsePlan).toEqual(expect.objectContaining({
      effectPlan: expect.objectContaining({
        effects: expect.arrayContaining([
          expect.objectContaining({ kind: 'runtimeStateWrite' })
        ])
      })
    }));
    expect(recorder.entries.map((entry) => entry.stage)).toEqual([
      'chat_process.resp.stage9.client_remap',
      'chat_process.resp.stage10.sse_stream'
    ]);
  });

  it('executes Rust servertoolRuntimeAction effect for tool_call callback path', async () => {
    const recorder = new StubStageRecorder();
    const context: Record<string, unknown> = {
      requestId: 'req_provider_response_servertool_tool_call_guard_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    };

    const result = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: {
        id: 'chatcmpl_servertool_tool_call_guard_1',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_servertool_apply_patch_1',
              type: 'function',
              function: { name: 'apply_patch', arguments: '{"patch":"*** Begin Patch\\n*** End Patch"}' }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      },
      context: context as any,
      entryEndpoint: '/v1/chat/completions',
      wantsStream: false,
      stageRecorder: recorder,
      providerInvoker: async () => ({ response: {} as any })
    });

    expect(result.body?.choices?.[0]?.message?.tool_calls?.[0]?.function?.name).toBe('apply_patch');

    expect(context.__nativeResponsePlan).toEqual(expect.objectContaining({
      effectPlan: expect.objectContaining({
        effects: expect.arrayContaining([
          expect.objectContaining({
            kind: 'servertoolRuntimeAction',
            payload: expect.objectContaining({
              action: 'requireRuntimeExecutor',
              reason: 'tool_call_dispatch',
              requestId: 'req_provider_response_servertool_tool_call_guard_1'
            })
          })
        ])
      })
    }));
  });

  it('fails fast instead of falling back to TS path when callback response shape is not Rust-observable', async () => {
    const recorder = new StubStageRecorder();
    const context: Record<string, unknown> = {
      requestId: 'req_provider_response_unobservable_callback_plan_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    };

    await expect(convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: { id: 'raw_unobservable_shape' },
      context: context as any,
      entryEndpoint: '/v1/chat/completions',
      wantsStream: false,
      stageRecorder: recorder,
      providerInvoker: async () => ({ response: {} as any })
    })).rejects.toThrow('Rust HubPipeline response path');

    expect(context.__nativeResponsePlan).toBeUndefined();
  });
});
