import { describe, expect, it, jest } from '@jest/globals';
import { PassThrough, Readable } from 'node:stream';
import * as responsesSseBridge from '../../../../../src/modules/llmswitch/bridge/responses-sse-bridge.js';

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

describe('provider-response relay responses SSE projection', () => {
  it('keeps direct /v1/responses SSE passthrough untouched', async () => {
    const directSse = new PassThrough();
    directSse.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
    const createConverter = jest.fn(async () => ({
      convertResponseToJsonToSse: async () => Readable.from([]),
    }));

    const stream = await responsesSseBridge.resolveRelayResponsesClientSseStreamForHttp({
      entryEndpoint: '/v1/responses',
      continuationOwner: 'direct',
      sseStream: directSse,
      body: { id: 'resp_direct_1', object: 'response', status: 'completed' },
      requestId: 'req_direct_passthrough_1',
      createConverter,
    });

    expect(stream).toBe(directSse);
    expect(createConverter).not.toHaveBeenCalled();
  });

  it('RED: relay /v1/responses SSE must be rebuilt from standardized response body', async () => {
    const rawRelaySse = new PassThrough();
    rawRelaySse.end(
      'event: message_start\n'
      + 'data: {"type":"message_start"}\n\n'
      + 'event: message_stop\n'
      + 'data: {"type":"message_stop"}\n\n'
    );
    const createConverter = jest.fn(async () => ({
      convertResponseToJsonToSse: async (payload: any) => Readable.from([
        `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: payload })}\n\n`,
        `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response: payload })}\n\n`,
      ]),
    }));

    const stream = await responsesSseBridge.resolveRelayResponsesClientSseStreamForHttp({
      entryEndpoint: '/v1/responses',
      continuationOwner: 'relay',
      sseStream: rawRelaySse,
      body: {
        id: 'resp_relay_body_1',
        object: 'response',
        status: 'completed',
        output: [],
        output_text: 'ok',
      },
      requestId: 'req_relay_reproject_1',
      createConverter,
    });

    expect(createConverter).toHaveBeenCalledTimes(1);
    expect(stream).toBeDefined();
    expect(stream).not.toBe(rawRelaySse);
    const body = await readStreamBody(stream as NodeJS.ReadableStream);
    expect(body).toContain('event: response.completed');
    expect(body).toContain('event: response.done');
    expect(body).not.toContain('event: message_start');
    expect(body).not.toContain('event: message_stop');
  });

  it('throws when relay /v1/responses SSE has no standardized response body', async () => {
    await expect(responsesSseBridge.resolveRelayResponsesClientSseStreamForHttp({
      entryEndpoint: '/v1/responses',
      continuationOwner: 'relay',
      sseStream: new PassThrough(),
      requestId: 'req_relay_missing_body_1',
      createConverter: async () => ({
        convertResponseToJsonToSse: async () => Readable.from([]),
      }),
    })).rejects.toThrow('relay /v1/responses SSE requires standardized response body');
  });

  it('recognizes only relay responses endpoints as reproject candidates', () => {
    expect(responsesSseBridge.shouldReprojectRelayResponsesSseForHttp({
      entryEndpoint: '/v1/responses',
      continuationOwner: 'relay',
      hasSseStream: true,
    })).toBe(true);
    expect(responsesSseBridge.shouldReprojectRelayResponsesSseForHttp({
      entryEndpoint: '/v1/responses.submit_tool_outputs',
      continuationOwner: undefined,
      hasSseStream: true,
    })).toBe(true);
    expect(responsesSseBridge.shouldReprojectRelayResponsesSseForHttp({
      entryEndpoint: '/v1/chat/completions',
      continuationOwner: 'relay',
      hasSseStream: true,
    })).toBe(false);
    expect(responsesSseBridge.shouldReprojectRelayResponsesSseForHttp({
      entryEndpoint: '/v1/responses',
      continuationOwner: 'direct',
      hasSseStream: true,
    })).toBe(false);
  });
});
