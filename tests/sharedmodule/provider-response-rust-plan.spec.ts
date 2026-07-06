import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Readable } from 'node:stream';
import type { StageRecorder } from '../../sharedmodule/llmswitch-core/src/conversion/hub/format-adapters/index.js';
import { MetadataCenter } from '../../src/server/runtime/http-server/metadata-center/metadata-center.js';

const recordResponsesResponseMock = jest.fn();
const captureResponsesRequestContextMock = jest.fn();

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js', () => ({
  captureResponsesRequestContext: captureResponsesRequestContextMock,
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

const TEST_METADATA_WRITER = {
  module: 'tests/sharedmodule/provider-response-rust-plan.spec.ts',
  symbol: 'withMetadataCenter',
  stage: 'test_req_inbound_metadata_center'
};

function withMetadataCenter<T extends Record<string, unknown>>(context: T): T {
  const center = MetadataCenter.attach(context);
  if (typeof context.requestId === 'string') {
    center.writeRequestTruth('requestId', context.requestId, TEST_METADATA_WRITER, 'test-request-truth');
  }
  if (typeof context.entryEndpoint === 'string') {
    center.writeRequestTruth('entryEndpoint', context.entryEndpoint, TEST_METADATA_WRITER, 'test-request-truth');
  }
  if (typeof context.sessionId === 'string') {
    center.writeRequestTruth('sessionId', context.sessionId, TEST_METADATA_WRITER, 'test-request-truth');
  }
  if (typeof context.providerProtocol === 'string') {
    center.writeRuntimeControl('providerProtocol', context.providerProtocol, TEST_METADATA_WRITER, 'test-runtime-control');
  }
  if (typeof context.stopMessageEnabled === 'boolean') {
    center.writeRuntimeControl('stopMessageEnabled', context.stopMessageEnabled, TEST_METADATA_WRITER, 'test-runtime-control');
  }
  return context;
}

async function readStreamBody(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function extractExecCommandFromResponsesBody(body: unknown): string {
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const output = Array.isArray(record.output) ? record.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const itemRecord = item as Record<string, unknown>;
    if (itemRecord.type !== 'function_call' || itemRecord.name !== 'exec_command') {
      continue;
    }
    const argsText = typeof itemRecord.arguments === 'string' ? itemRecord.arguments : '';
    const args = JSON.parse(argsText) as { cmd?: unknown };
    if (typeof args.cmd === 'string') {
      return args.cmd;
    }
  }
  throw new Error('exec_command function_call not found in Responses body');
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
    const context: Record<string, unknown> = withMetadataCenter({
      requestId: 'req_provider_response_native_plan_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      stopMessageEnabled: false,
      routecodexPortStopMessageEnabled: false
    });

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
    expect(result.sseStream).toBeUndefined();
    expect(context.__nativeResponsePlan).toEqual(expect.objectContaining({
      effectPlan: expect.objectContaining({
        effects: expect.arrayContaining([
          expect.objectContaining({
            kind: 'runtimeStateWrite',
            payload: expect.objectContaining({
              requestId: 'req_provider_response_native_plan_1',
              clientProtocol: 'openai-chat',
              payload: expect.objectContaining({
                id: 'chatcmpl_native_plan_1',
                object: 'chat.completion',
                created: expect.any(Number)
              }),
              keepForSubmitToolOutputs: false
            })
          })
        ])
      }),
      diagnostics: expect.any(Array)
    }));
    expect(recorder.entries.map((entry) => entry.stage)).toContain('chat_process.resp.stage9.client_remap');
    expect(recorder.entries.map((entry) => entry.stage)).toContain('chat_process.resp.stage10.sse_stream');
  });

  it('fails fast when provider response context has no requestId instead of synthesizing unknown', async () => {
    const context: Record<string, unknown> = withMetadataCenter({
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      stopMessageEnabled: false,
      routecodexPortStopMessageEnabled: false
    });

    await expect(convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: {
        id: 'chatcmpl_missing_request_id',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'should not synthesize request id' },
          finish_reason: 'stop'
        }]
      },
      context: context as any,
      entryEndpoint: '/v1/chat/completions',
      wantsStream: false
    })).rejects.toThrow('Provider response conversion requires context.requestId');

    expect(context.__nativeResponsePlan).toBeUndefined();
  });

  it('does not record Responses conversation before handler captures request context', async () => {
    const context: Record<string, unknown> = withMetadataCenter({
      requestId: 'openai-responses-mimo.key2-mimo-v2.5-20260531T215233443-242655-2116',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'anthropic-messages',
      stopMessageEnabled: false,
      routecodexPortStopMessageEnabled: false
    });

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

  it('records Responses response capture under the active response request id when request truth was rebound', async () => {
    const context: Record<string, unknown> = {
      requestId: 'openai-responses-orangeai.key1-glm-5.2-20260629T203754219-423335-3618',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      sessionId: 'responses-rebound-request-context-session',
      stopMessageEnabled: false,
      routecodexPortStopMessageEnabled: false
    };
    const center = MetadataCenter.attach(context);
    center.writeRequestTruth('requestId', 'openai-responses-router-gpt-5.5-20260629T203754219-423335-3618', TEST_METADATA_WRITER, 'test-request-truth');
    center.writeRequestTruth('entryEndpoint', context.entryEndpoint, TEST_METADATA_WRITER, 'test-request-truth');
    center.writeRequestTruth('sessionId', context.sessionId, TEST_METADATA_WRITER, 'test-request-truth');
    center.writeRuntimeControl('providerProtocol', 'openai-chat', TEST_METADATA_WRITER, 'test-runtime-control');

    await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: {
        id: 'chatcmpl_rebound_request_context',
        object: 'chat.completion',
        model: 'glm-5.2',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      },
      context: context as any,
      entryEndpoint: '/v1/responses',
      wantsStream: false
    });

    expect(recordResponsesResponseMock).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'openai-responses-orangeai.key1-glm-5.2-20260629T203754219-423335-3618'
    }));
    expect(recordResponsesResponseMock).not.toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'openai-responses-router-gpt-5.5-20260629T203754219-423335-3618'
    }));
  });

  it('projects stopless CLI command instead of reentering followup for Anthropic relay stop', async () => {
    const suffix = `anthropic_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const context: Record<string, unknown> = withMetadataCenter({
      requestId: `req_provider_response_stopless_followup_projection_${suffix}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'anthropic-messages',
      sessionId: `provider-response-stopless-followup-projection-${suffix}`,
      stopMessageEnabled: true,
      routecodexPortStopMessageEnabled: true,
      __rt: {
        stopMessageEnabled: true,
        routecodexPortStopMessageEnabled: true
      },
      capturedChatRequest: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'continue' }]
      }
    });
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
    expect(bodyText).toContain('routecodex hook run reasoningStop');
    expect(bodyText).toContain('stop_message_flow');
  });

  it('projects stopless CLI command for OpenAI Chat stop schema continue response before client projection', async () => {
    const suffix = `openai_chat_schema_continue_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const context: Record<string, unknown> = withMetadataCenter({
      requestId: `req_provider_response_openai_chat_schema_continue_${suffix}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-chat',
      sessionId: `provider-response-openai-chat-schema-continue-${suffix}`,
      stopMessageEnabled: true,
      routecodexPortStopMessageEnabled: true
    });
    const center = MetadataCenter.attach(context);
    center.writeRuntimeControl('stopless', {
      active: true,
      flowId: 'stop_message_flow',
      repeatCount: 1,
      maxRepeats: 3,
      continuationPrompt: '请继续执行下一步：基于第二轮工具结果继续最终核对',
      triggerHint: 'stop_schema_continue_next_step',
      schemaFeedback: {
        reasonCode: 'stop_schema_continue_next_step',
        missingFields: []
      }
    }, TEST_METADATA_WRITER, 'test-stopless-runtime-control');

    const result = await convertProviderResponse({
      providerProtocol: 'openai-chat',
      providerResponse: {
        id: 'chatcmpl_openai_chat_schema_continue',
        object: 'chat.completion',
        model: 'glm-5.2',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '```json\n{\n  "stopreason": 2,\n  "reason": "第二轮还没做完",\n  "next_step": "基于第二轮工具结果继续最终核对"\n}\n```',
            reasoning_content: 'Let me output that schema.'
          }
        }],
        usage: { prompt_tokens: 585, completion_tokens: 128, total_tokens: 713 }
      },
      context: context as any,
      entryEndpoint: '/v1/responses',
      wantsStream: false,
      clientInjectDispatch: jest.fn(async () => ({ ok: true })) as any
    });

    expect(result.body?.object).toBe('response');
    expect(result.body?.status).toBe('requires_action');
    const bodyText = JSON.stringify(result.body);
    expect(bodyText).toContain('exec_command');
    const command = extractExecCommandFromResponsesBody(result.body);
    expect(command).toContain('routecodex hook run reasoningStop');
    expect(command).toContain('"repeatCount":1');
    expect(command).toContain('"triggerHint":"non_terminal_schema"');
    expect(bodyText).not.toContain('stopreason');
    expect(bodyText).not.toContain('第二轮还没做完');
  });

  it('projects stopless CLI command for captured mimo Anthropic SSE stop shape', async () => {
    const suffix = `mimo_sse_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const context: Record<string, unknown> = withMetadataCenter({
      requestId: `req_provider_response_mimo_sse_stopless_${suffix}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'anthropic-messages',
      sessionId: `provider-response-mimo-sse-stopless-${suffix}`,
      stopMessageEnabled: true,
      routecodexPortStopMessageEnabled: true
    });

    const result = await convertProviderResponse({
      providerProtocol: 'anthropic-messages',
      providerResponse: { sseStream: Readable.from([buildMimoAnthropicStopSse()]) },
      context: context as any,
      entryEndpoint: '/v1/responses',
      wantsStream: false,
      clientInjectDispatch: jest.fn(async () => ({ ok: true })) as any
    });

    expect(result.body?.object).toBe('response');
    expect(result.body?.status).toBe('requires_action');
    const bodyText = JSON.stringify(result.body);
    expect(bodyText).toContain('exec_command');
    expect(bodyText).toContain('routecodex hook run reasoningStop');
    expect(bodyText).toContain('stop_message_flow');
    expect(context.__nativeResponsePlan).toEqual(expect.objectContaining({
      runtimeEffects: expect.objectContaining({
        stoplessMetadataCenterWrite: expect.objectContaining({
          stopless: expect.objectContaining({
            active: true,
            sessionId: context.sessionId
          })
        }),
        servertoolRuntimeActions: []
      })
    }));
  });

  it('projects stopless CLI command for relay OpenAI Responses completed stop', async () => {
    const suffix = `responses_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const context: Record<string, unknown> = withMetadataCenter({
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
    });

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
    expect(outputText).toContain('routecodex hook run reasoningStop');
    expect(outputText).toContain('stop_message_flow');
    const output = Array.isArray((result.body as any)?.output) ? (result.body as any).output : [];
    expect(output.some((item: any) => item?.type === 'message')).toBe(true);
    expect(output.some((item: any) => item?.type === 'function_call' && item?.name === 'exec_command')).toBe(true);
  });

  it('projects stopless CLI command for relay OpenAI Responses completed stop without session scope', async () => {
    const suffix = `responses_scope_free_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const context: Record<string, unknown> = withMetadataCenter({
      requestId: `req_provider_response_responses_stopless_cli_projection_scope_free_${suffix}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      stopMessageEnabled: true,
      routecodexPortStopMessageEnabled: true,
      capturedEntryRequest: {
        model: 'gpt-test',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'continue' }] }]
      }
    });

    try {
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
      expect(outputText).not.toContain('exec_command');
      expect(outputText).not.toContain('stop_message_flow');
      expect(outputText).toContain('"status":"completed"');
      expect(warnSpy.mock.calls.some((call) => {
        return String(call[0] ?? '').includes('[hub-pipeline][alarm] stopless_missing_session_id');
      })).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not project stopless CLI command for relay OpenAI Responses completed stop when stop message is disabled', async () => {
    const suffix = `responses_scope_free_disabled_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const context: Record<string, unknown> = withMetadataCenter({
      requestId: `req_provider_response_responses_stopless_cli_projection_scope_free_disabled_${suffix}`,
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      stopMessageEnabled: false,
      routecodexPortStopMessageEnabled: false,
      capturedEntryRequest: {
        model: 'gpt-test',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'continue' }] }]
      }
    });

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
    const context: Record<string, unknown> = withMetadataCenter({
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
    });

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

    expect(result.sseStream).toBeDefined();
    const sseBody = await readStreamBody(result.sseStream!);
    expect(sseBody).toContain('exec_command');
    expect(sseBody).toContain('routecodex hook run reasoningStop');
    expect(sseBody).toContain('stop_message_flow');
    expect(sseBody).toContain('event: response.done');
    expect(sseBody).toContain('"status":"requires_action"');
  });

  it('streams stopless CLI command for relay OpenAI Responses SSE completed stop', async () => {
    const suffix = `responses_sse_stream_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const context: Record<string, unknown> = withMetadataCenter({
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
    });

    const result = await convertProviderResponse({
      providerProtocol: 'openai-responses',
      providerResponse: {
        sseStream: Readable.from([buildOpenAiResponsesCompletedStopSse()])
      },
      context: context as any,
      entryEndpoint: '/v1/responses',
      wantsStream: true,
      clientInjectDispatch: jest.fn(async () => ({ ok: true })) as any
    });

    expect(result.body?.object).toBe('response');
    expect(result.body?.status).toBe('requires_action');
    expect(JSON.stringify(result.body)).toContain('exec_command');
    expect(JSON.stringify(result.body)).toContain('routecodex hook run reasoningStop');
    expect(result.sseStream).toBeDefined();
    const sseBody = await readStreamBody(result.sseStream!);
    expect(sseBody).toContain('exec_command');
    expect(sseBody).toContain('routecodex hook run reasoningStop');
    expect(sseBody).toContain('event: response.done');
    expect(sseBody).toContain('"status":"requires_action"');
    expect(sseBody).not.toContain('resp_openai_responses_stop_sse');
  });

  it('uses Rust streamPipe effect plan for streaming response path', async () => {
    const recorder = new StubStageRecorder();
    const context: Record<string, unknown> = withMetadataCenter({
      requestId: 'req_provider_response_native_stream_plan_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      stopMessageEnabled: false,
      routecodexPortStopMessageEnabled: false
    });

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
    expect(result.sseStream).toBeDefined();
    const sseBody = await readStreamBody(result.sseStream!);
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
              payload: expect.objectContaining({
                id: 'chatcmpl_native_stream_plan_1',
                object: 'chat.completion',
                created: expect.any(Number)
              })
            })
          }),
          expect.objectContaining({
            kind: 'runtimeStateWrite',
            payload: expect.objectContaining({
              requestId: 'req_provider_response_native_stream_plan_1',
              clientProtocol: 'openai-chat',
              payload: expect.objectContaining({
                id: 'chatcmpl_native_stream_plan_1',
                object: 'chat.completion',
                created: expect.any(Number)
              }),
              keepForSubmitToolOutputs: false
            })
          })
        ])
      }),
      diagnostics: expect.any(Array)
    }));
    expect(recorder.entries.map((entry) => entry.stage)).toEqual(expect.arrayContaining([
      'chat_process.resp.stage9.client_remap',
      'chat_process.resp.stage10.sse_stream'
    ]));
  });

  it('does not bypass Rust native response plan for clock runtime metadata', async () => {
    const recorder = new StubStageRecorder();
    const context: Record<string, unknown> = withMetadataCenter({
      requestId: 'req_provider_response_native_clock_plan_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      stopMessageEnabled: false,
      routecodexPortStopMessageEnabled: false,
      __rt: { clock: { enabled: true, dataDir: '/tmp/rcc-clock-native-plan-test' } }
    });

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
              payload: expect.objectContaining({
                id: 'chatcmpl_native_clock_plan_1',
                object: 'chat.completion',
                created: expect.any(Number)
              })
            })
          })
        ])
      })
    }));
    expect(recorder.entries.map((entry) => entry.stage)).toEqual(expect.arrayContaining([
      'chat_process.resp.stage9.client_remap',
      'chat_process.resp.stage10.sse_stream'
    ]));
  });

  it('does not bypass Rust native response plan for webSearch runtime config without executors', async () => {
    const recorder = new StubStageRecorder();
    const context: Record<string, unknown> = withMetadataCenter({
      requestId: 'req_provider_response_native_websearch_plan_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      stopMessageEnabled: false,
      routecodexPortStopMessageEnabled: false,
      __rt: { webSearch: { enabled: true, engines: [] } }
    });

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
              payload: expect.objectContaining({
                id: 'chatcmpl_native_websearch_plan_1',
                object: 'chat.completion',
                created: expect.any(Number)
              })
            })
          })
        ])
      })
    }));
    expect(recorder.entries.map((entry) => entry.stage)).toEqual(expect.arrayContaining([
      'chat_process.resp.stage9.client_remap',
      'chat_process.resp.stage10.sse_stream'
    ]));
  });

  it('does not bypass Rust native response plan when executor callbacks exist but response has no runnable servertool action', async () => {
    const recorder = new StubStageRecorder();
    const context: Record<string, unknown> = withMetadataCenter({
      requestId: 'req_provider_response_native_callbacks_no_tool_plan_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      stopMessageEnabled: false,
      routecodexPortStopMessageEnabled: false
    });

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
    const context: Record<string, unknown> = withMetadataCenter({
      requestId: 'req_provider_response_servertool_stop_guard_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      stopMessageEnabled: true,
      routecodexPortStopMessageEnabled: true
    });

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

    expect(result.body?.choices?.[0]?.finish_reason).toBe('stop');
    const bodyText = JSON.stringify(result.body);
    expect(bodyText).not.toContain('exec_command');
    expect(context.__nativeResponsePlan).toEqual(expect.objectContaining({
      runtimeEffects: expect.objectContaining({
        servertoolRuntimeActions: [],
        stoplessMetadataCenterWrite: null
      })
    }));
  });

  it('does not bypass Rust native response plan for inert servertool runtime config', async () => {
    const recorder = new StubStageRecorder();
    const context: Record<string, unknown> = withMetadataCenter({
      requestId: 'req_provider_response_native_servertool_config_plan_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      stopMessageEnabled: false,
      routecodexPortStopMessageEnabled: false,
      __rt: { servertool: { enabled: true } }
    });

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

  it('does not bypass Rust native response plan for inert legacy runtime metadata', async () => {
    const recorder = new StubStageRecorder();
    const context: Record<string, unknown> = withMetadataCenter({
      requestId: 'req_provider_response_native_followup_inert_plan_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      stopMessageEnabled: false,
      routecodexPortStopMessageEnabled: false,
      __rt: { legacyRuntimeFlag: true }
    });

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

  it('does not require stopless runtime action for ordinary tool_call callback path', async () => {
    const recorder = new StubStageRecorder();
    const context: Record<string, unknown> = withMetadataCenter({
      requestId: 'req_provider_response_servertool_tool_call_guard_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      stopMessageEnabled: true,
      routecodexPortStopMessageEnabled: true
    });

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
      runtimeEffects: expect.objectContaining({
        servertoolRuntimeActions: []
      })
    }));
  });

  it('fails fast instead of falling back to TS path when callback response shape is not Rust-observable', async () => {
    const recorder = new StubStageRecorder();
    const context: Record<string, unknown> = withMetadataCenter({
      requestId: 'req_provider_response_unobservable_callback_plan_1',
      entryEndpoint: '/v1/chat/completions',
      providerProtocol: 'openai-chat',
      stopMessageEnabled: false,
      routecodexPortStopMessageEnabled: false
    });

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
