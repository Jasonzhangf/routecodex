import { describe, expect, it, jest } from '@jest/globals';
import { PassThrough, Readable } from 'node:stream';
import { MetadataCenter } from '../../../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

async function readStreamBody(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string | Uint8Array>) {
    if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
      continue;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const mockConvertProviderResponse = jest.fn();
const mockCreateSnapshotRecorder = jest.fn(async () => ({ record: () => {} }));

jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/provider-response-converter-host.js', () => ({
  convertProviderResponse: mockConvertProviderResponse
}));
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/snapshot-recorder.js', () => ({
  createSnapshotRecorder: mockCreateSnapshotRecorder
}));
jest.unstable_mockModule('../../../../../src/modules/llmswitch/bridge/snapshot-recorder.ts', () => ({
  createSnapshotRecorder: mockCreateSnapshotRecorder
}));

const TEST_METADATA_WRITER = {
  module: 'tests/server/runtime/http-server/executor/provider-response-converter.prebuilt-sse-passthrough.spec.ts',
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

describe('provider-response-converter prebuilt SSE passthrough gate', () => {
  it('does not bridge openai responses prebuilt SSE through stopless in the converter', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const prebuiltSse = new PassThrough();
    prebuiltSse.end(
      'event: response.completed\n'
      + 'data: {"type":"response.completed","response":{"id":"resp_prebuilt_stop_1","status":"completed","output_text":"阶段完成"}}\n\n'
    );
    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const converted = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        providerType: 'openai',
        requestId: 'req_prebuilt_sse_default_stopless_no_goal',
        wantsStream: true,
        serverToolsEnabled: true,
        entryOriginRequest: {
          model: 'gpt-test',
          input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行当前目标' }] }]
        },
        response: {
          body: {
            status: 'completed',
            output_text: '阶段完成'
          },
          sseStream: prebuiltSse,
          continuationOwner: 'direct',
        } as any,
        pipelineMetadata: buildPipelineMetadata('openai-responses', {
          routecodexPortStopMessageEnabled: true,
          stopMessageEnabled: true
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

    expect(mockConvertProviderResponse).not.toHaveBeenCalled();

    expect(converted.sseStream).toBe(prebuiltSse);
    expect(JSON.stringify(converted.body)).not.toContain('__routecodex_');
  });

  it('RED: relay /v1/responses prebuilt SSE must re-enter bridge instead of passthrough', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const relaySse = new PassThrough();
    relaySse.end(
      'event: response.completed\n'
      + 'data: {"type":"response.completed","response":{"id":"resp_relay_prebuilt_1","status":"completed","output_text":"relay body"}}\n\n'
    );

    mockConvertProviderResponse.mockResolvedValue({
      sseStream: Readable.from([
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"id":"resp_relay_bridge_1","status":"completed","output_text":"relay body"}}\n\n',
        'event: response.done\n',
        'data: {"type":"response.done","response":{"id":"resp_relay_bridge_1","status":"completed","output_text":"relay body"}}\n\n',
      ]),
      body: {
        id: 'resp_relay_bridge_1',
        object: 'response',
        status: 'completed',
        output: [],
        output_text: 'relay body'
      }
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const converted = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses',
        providerType: 'openai',
        requestId: 'req_relay_prebuilt_sse_must_bridge',
        wantsStream: true,
        response: {
          body: {
            id: 'resp_relay_upstream_1',
            object: 'response',
            status: 'completed',
            output: [],
            output_text: 'relay upstream'
          },
          sseStream: relaySse,
          continuationOwner: 'relay',
        } as any,
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

    expect(mockConvertProviderResponse).toHaveBeenCalledTimes(1);
    expect(converted.sseStream).toBeDefined();
    expect(converted.sseStream).not.toBe(relaySse);
    const sseBody = await readStreamBody(converted.sseStream as NodeJS.ReadableStream);
    expect(sseBody).toContain('event: response.completed');
    expect(sseBody).toContain('event: response.done');
    expect((converted as any).body).toMatchObject({
      id: 'resp_relay_bridge_1',
      object: 'response',
      status: 'completed'
    });
  });

  it('RED: relay wrapped SSE payload response must re-enter bridge instead of collapsing to empty body', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    mockConvertProviderResponse.mockResolvedValue({
      body: {
        id: 'resp_relay_wrapped_bridge_1',
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'relay wrapped body' }]
          }
        ],
        output_text: 'relay wrapped body'
      }
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const converted = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-chat',
        providerType: 'openai',
        requestId: 'req_relay_wrapped_sse_payload_must_bridge',
        wantsStream: true,
        response: {
          body: {
            clientStream: false,
            mode: 'sse',
            payload: {
              id: 'resp_relay_wrapped_upstream_1',
              object: 'response',
              status: 'completed',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'relay wrapped body' }]
                }
              ]
            }
          },
          continuationOwner: 'relay'
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
    expect((converted as any).body).toMatchObject({
      id: 'resp_relay_wrapped_bridge_1',
      object: 'response',
      status: 'completed',
      output_text: 'relay wrapped body'
    });
  });

  it('RED: does not passthrough anthropic raw SSE directly on /v1/responses', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const anthropicRawSse = new PassThrough();
    anthropicRawSse.end(
      'event: message_start\n'
      + 'data: {"type":"message_start","message":{"id":"msg_1","type":"message"}}\n\n'
      + 'event: message_stop\n'
      + 'data: {"type":"message_stop"}\n\n'
    );

    mockConvertProviderResponse.mockResolvedValue({
      sseStream: Readable.from([
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"id":"resp_from_anthropic_stream_1","status":"completed","output_text":"ok"}}\n\n',
        'event: response.done\n',
        'data: {"type":"response.done","response":{"id":"resp_from_anthropic_stream_1","status":"completed","output_text":"ok"}}\n\n',
      ]),
      body: {
        id: 'resp_from_anthropic_stream_1',
        object: 'response',
        status: 'completed',
        output: [
          {
            id: 'msg_out_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'ok' }]
          }
        ],
        output_text: 'ok'
      }
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const converted = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_anthropic_raw_sse_must_wrap_for_responses',
        wantsStream: true,
        response: {
          body: {},
          sseStream: anthropicRawSse,
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
    expect(converted.sseStream).toBeDefined();
    expect(converted.sseStream).not.toBe(anthropicRawSse);
    const sseBody = await readStreamBody(converted.sseStream as NodeJS.ReadableStream);
    expect(sseBody).toContain('event: response.completed');
    expect(sseBody).toContain('event: response.done');
    expect(sseBody).not.toContain('event: message_stop');
    expect(sseBody).not.toContain('event: message_start');
    expect(JSON.stringify(converted.body)).not.toContain('__routecodex_');
  });

  it('RED: stream-only relay /v1/responses must still enter bridge conversion', async () => {
    jest.resetModules();
    mockConvertProviderResponse.mockReset();
    mockCreateSnapshotRecorder.mockClear();

    const anthropicRawSse = new PassThrough();
    anthropicRawSse.end(
      'event: message_start\n'
      + 'data: {"type":"message_start","message":{"id":"msg_stream_only_1","type":"message"}}\n\n'
      + 'event: message_stop\n'
      + 'data: {"type":"message_stop"}\n\n'
    );

    mockConvertProviderResponse.mockResolvedValue({
      sseStream: Readable.from([
        'event: response.completed\n',
        'data: {"type":"response.completed","response":{"id":"resp_stream_only_bridge_1","status":"completed","output_text":"stream-only relay body"}}\n\n',
        'event: response.done\n',
        'data: {"type":"response.done","response":{"id":"resp_stream_only_bridge_1","status":"completed","output_text":"stream-only relay body"}}\n\n',
      ]),
      body: {
        id: 'resp_stream_only_bridge_1',
        object: 'response',
        status: 'completed',
        output: [],
        output_text: 'stream-only relay body'
      }
    });

    const { convertProviderResponseIfNeeded } = await import(
      '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js'
    );

    const converted = await convertProviderResponseIfNeeded(
      {
        entryEndpoint: '/v1/responses',
        providerProtocol: 'anthropic-messages',
        requestId: 'req_stream_only_relay_must_bridge',
        wantsStream: true,
        response: {
          sseStream: anthropicRawSse,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8'
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
    expect(converted.sseStream).toBeDefined();
    expect(converted.sseStream).not.toBe(anthropicRawSse);
    const sseBody = await readStreamBody(converted.sseStream as NodeJS.ReadableStream);
    expect(sseBody).toContain('event: response.completed');
    expect(sseBody).toContain('event: response.done');
    expect(sseBody).not.toContain('event: message_stop');
    expect((converted as any).body).toMatchObject({
      id: 'resp_stream_only_bridge_1',
      object: 'response',
      status: 'completed'
    });
  });

});
