import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('response SSE wrapper contract', () => {
  it('does not use body.sseStream as a response stream source', () => {
    const source = readRepoFile('src/server/handlers/handler-response-sse.ts');

    expect(source).toContain('const streamSource = result.sseStream;');
    expect(source).not.toContain('bodyRecord?.sseStream');
    expect(source).not.toMatch(/result\.sseStream\s*\?\?/);
  });

  it('does not expose a body-level sseStream predicate as a canonical bridge builder', () => {
    const responseBridge = readRepoFile('src/modules/llmswitch/bridge/responses-response-bridge.ts');
    const sseBridge = readRepoFile('src/modules/llmswitch/bridge/responses-sse-bridge.ts');
    const bridgeIndex = readRepoFile('src/modules/llmswitch/bridge/index.ts');

    for (const source of [responseBridge, sseBridge, bridgeIndex]) {
      expect(source).not.toContain('hasResponsesSsePayloadForHttp');
      expect(source).not.toContain('hasSsePayload:');
      expect(source).not.toContain('args.hasSsePayload');
    }
  });

  it('fails client JSON projection if an internal sseStream wrapper reaches normal payload', async () => {
    const { assertClientResponseHasNoInternalCarriers, sendPipelineResponse } = await import(
      '../../../src/server/handlers/handler-response-utils.js'
    );

    expect(() => assertClientResponseHasNoInternalCarriers(
      {
        id: 'resp_illegal_sse_wrapper',
        object: 'response',
        status: 'completed',
        sseStream: { pipe: () => undefined },
      },
      'req-illegal-sse-wrapper',
    )).toThrow('sseStream');

    await expect(sendPipelineResponse(
      {
        setHeader: () => undefined,
        status: () => ({
          json: () => undefined,
          end: () => undefined,
        }),
        json: () => undefined,
        end: () => undefined,
      } as any,
      {
        status: 200,
        body: {
          id: 'resp_illegal_body_sse_stream',
          object: 'response',
          status: 'completed',
          sseStream: { pipe: () => undefined },
        },
      } as any,
      'req-illegal-body-sse-stream',
      { entryEndpoint: '/v1/responses' },
    )).rejects.toThrow('sseStream');
  });
});
