import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, jest } from '@jest/globals';

import { MetadataCenter } from '../../../src/server/runtime/http-server/metadata-center/metadata-center.js';

jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
  isSnapshotsEnabled: () => false,
  writeServerSnapshot: async () => undefined,
}));

class MockResponse extends PassThrough {
  public statusCode = 200;
  public headers = new Map<string, string>();
  public jsonBody: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(key: string, value: string): void {
    this.headers.set(key.toLowerCase(), value);
  }

  json(body: unknown): this {
    this.jsonBody = body;
    this.end(JSON.stringify(body));
    return this;
  }
}

function seedMetadataCenter(metadata: Record<string, unknown>, suffix: string) {
  const center = MetadataCenter.attach(metadata);
  center.writeRequestTruth('sessionId', `sess-${suffix}`, {
    module: 'tests/server/handlers/handler-response-utils.metadata-center-closeout.spec.ts',
    symbol: 'seedMetadataCenter',
    stage: 'MetaResp07ServertoolContextProjected',
  });
  center.writeContinuationContext('responseId', `resp-${suffix}`, {
    module: 'tests/server/handlers/handler-response-utils.metadata-center-closeout.spec.ts',
    symbol: 'seedMetadataCenter',
    stage: 'MetaResp07ServertoolContextProjected',
  });
  center.writeRuntimeControl('routeHint', `tools-${suffix}`, {
    module: 'tests/server/handlers/handler-response-utils.metadata-center-closeout.spec.ts',
    symbol: 'seedMetadataCenter',
    stage: 'MetaResp07ServertoolContextProjected',
  });
  return center;
}

describe('sendPipelineResponse metadata center closeout', () => {
  it('marks metadata center slots released after JSON closeout', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const res = new MockResponse();
    const metadata: Record<string, unknown> = {};
    const center = seedMetadataCenter(metadata, 'json-closeout');

    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        metadata,
        body: {
          id: 'chatcmpl_meta_center_closeout_json',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'ok',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        },
      } as any,
      'req-meta-center-json-closeout',
      { entryEndpoint: '/v1/chat/completions' },
    );

    const snapshot = center.snapshot();
    expect(snapshot.requestTruth.sessionId?.status).toBe('released');
    expect(snapshot.continuationContext.responseId?.status).toBe('released');
    expect(snapshot.runtimeControl.routeHint?.status).toBe('released');
    expect(snapshot.requestTruth.sessionId?.history.at(-1)?.reason).toBe('json_closeout');
    expect(snapshot.continuationContext.responseId?.history.at(-1)?.reason).toBe('json_closeout');
    expect(snapshot.runtimeControl.routeHint?.history.at(-1)?.reason).toBe('json_closeout');
  });

  it('marks metadata center slots released after SSE closeout', async () => {
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const res = new MockResponse();
    const finished = new Promise<void>((resolve) => {
      res.on('finish', () => resolve());
    });
    const metadata: Record<string, unknown> = {};
    const center = seedMetadataCenter(metadata, 'sse-closeout');

    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        metadata,
        sseStream: Readable.from([
          'data: {"id":"chatcmpl_meta_center_closeout_sse","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
        usage: {
          input_tokens: 2,
          output_tokens: 1,
        },
      } as any,
      'req-meta-center-sse-closeout',
      { entryEndpoint: '/v1/chat/completions', forceSSE: true },
    );
    await finished;

    const snapshot = center.snapshot();
    expect(snapshot.requestTruth.sessionId?.status).toBe('released');
    expect(snapshot.continuationContext.responseId?.status).toBe('released');
    expect(snapshot.runtimeControl.routeHint?.status).toBe('released');
    expect(snapshot.requestTruth.sessionId?.history.at(-1)?.reason).toBe('sse_finish_closeout');
    expect(snapshot.continuationContext.responseId?.history.at(-1)?.reason).toBe('sse_finish_closeout');
    expect(snapshot.runtimeControl.routeHint?.history.at(-1)?.reason).toBe('sse_finish_closeout');
  });
});
