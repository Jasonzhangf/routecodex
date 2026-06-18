import { describe, expect, it } from '@jest/globals';
import { PassThrough } from 'node:stream';
import { buildBridgeProviderResponseSeed } from '../../../../../src/server/runtime/http-server/executor/provider-response-converter.js';

describe('provider-response-converter bridge seed', () => {
  it('RED: stream-only relay provider response materializes a bridge seed without response metadata payload', () => {
    const rawSse = new PassThrough();

    const seed = buildBridgeProviderResponseSeed(
      {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'x-upstream-request-id': 'upstream_1'
        },
        metadata: {
          providerKey: 'minimax.key1.MiniMax-M2.7'
        },
        sseStream: rawSse
      } as any,
      undefined
    );

    expect(seed).toBeDefined();
    expect(seed).toMatchObject({
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'x-upstream-request-id': 'upstream_1'
      }
    });
    expect(seed).not.toHaveProperty('metadata');
    expect(seed?.sseStream).toBe(rawSse);
  });

  it('keeps the standardized body when one already exists', () => {
    const existingBody = {
      id: 'resp_existing_1',
      object: 'response',
      status: 'completed',
      output: [],
      output_text: 'ok'
    };

    const seed = buildBridgeProviderResponseSeed(
      {
        sseStream: new PassThrough()
      } as any,
      existingBody
    );

    expect(seed).toBe(existingBody);
  });

  it('returns undefined when neither body nor sse stream exists', () => {
    expect(buildBridgeProviderResponseSeed({ status: 204 } as any, undefined)).toBeUndefined();
  });
});
