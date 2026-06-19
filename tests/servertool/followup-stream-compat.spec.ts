import { describe, expect, test } from '@jest/globals';

import { reenterServerToolBackend } from '../../sharedmodule/llmswitch-core/src/servertool/backend-route-backend.js';

describe('servertool followup stream compatibility', () => {
  test('reenter backend does not force stream=false when metadata stream is not provided', async () => {
    const reenterPipeline = async (options: {
      entryEndpoint: string;
      requestId: string;
      body: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    }) => ({ body: { ok: true, metadata: options.metadata } });

    const result = await reenterServerToolBackend({
      reenterPipeline,
      entryEndpoint: '/v1/responses',
      requestId: 'req_followup_stream_compat_1',
      body: { model: 'gpt-5.3-codex', input: [{ role: 'user', content: [{ type: 'input_text', text: '继续执行' }] }] },
      providerProtocol: 'openai-responses',
      metadata: {}
    });

    const metadata = (result.body as Record<string, unknown>).metadata as Record<string, unknown>;
    expect(metadata.stream).toBeUndefined();
    expect((metadata.__rt as Record<string, unknown> | undefined)?.serverToolFollowup).toBeUndefined();
    expect(metadata.serverToolFollowup).toBeUndefined();
  });
});
