import { describe, expect, it } from '@jest/globals';
import { convertProviderResponse } from '../../sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.js';
import type { StageRecorder } from '../../sharedmodule/llmswitch-core/src/conversion/hub/format-adapters/index.js';

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

describe('provider response Rust native plan', () => {
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

    await expect(convertProviderResponse({
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
    })).rejects.toThrow('[servertool] followup requires reenter pipeline');

    expect(context.__nativeResponsePlan).toEqual(expect.objectContaining({
      effectPlan: expect.objectContaining({
        effects: expect.arrayContaining([
          expect.objectContaining({
            kind: 'servertoolRuntimeAction',
            payload: expect.objectContaining({
              action: 'requireReenterPipeline',
              reason: 'stop_eligible_followup',
              requestId: 'req_provider_response_servertool_stop_guard_1'
            })
          })
        ])
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

  it('uses Rust servertoolRuntimeAction effect for tool_call callback path', async () => {
    const recorder = new StubStageRecorder();
    const context: Record<string, unknown> = {
      requestId: 'req_provider_response_servertool_tool_call_guard_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat'
    };

    await expect(convertProviderResponse({
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
    })).rejects.toThrow('Rust HubPipeline servertoolRuntimeAction requires runtime executor');

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
