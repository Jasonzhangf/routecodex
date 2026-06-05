import { describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

function countNamespace(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countNamespace(item), 0);
  if (!value || typeof value !== 'object') return 0;
  const row = value as Record<string, unknown>;
  return (row.type === 'namespace' ? 1 : 0) + Object.values(row).reduce((sum, item) => sum + countNamespace(item), 0);
}

function latestOpencodeNamespaceBody(): Record<string, unknown> {
  const sample = path.join(
    process.env.HOME ?? '',
    '.rcc/codex-samples/openai-responses/port-5555/req_1780579571498_771573aa/provider-request.json',
  );
  if (fs.existsSync(sample)) {
    return JSON.parse(fs.readFileSync(sample, 'utf8')).body;
  }
  return {
    model: 'minimax-m3-free',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{
      type: 'custom',
      name: 'apply_patch',
      description: 'Use the `apply_patch` tool to edit files.',
    }],
  };
}

describe('HttpRequestExecutor provider wire sanitize', () => {
  it('uses target outboundProfile openai-chat to convert custom apply_patch into provider function tool', async () => {
    const { HttpRequestExecutor } = await import('../../../../src/providers/core/runtime/http-request-executor.js');
    const sentBodies: unknown[] = [];
    const executor = new HttpRequestExecutor({
      post: jest.fn(async (_url: string, body: unknown) => {
        sentBodies.push(body);
        return { choices: [{ message: { role: 'assistant', content: 'ok' } }] };
      }),
      postStream: jest.fn(),
    } as any, {
      wantsUpstreamSse: () => false,
      getEffectiveEndpoint: () => '/chat/completions',
      resolveRequestEndpoint: (_request: any, endpoint: string) => endpoint,
      buildRequestHeaders: async () => ({}),
      finalizeRequestHeaders: async (headers: Record<string, string>) => headers,
      applyStreamModeHeaders: (headers: Record<string, string>) => headers,
      getEffectiveBaseUrl: () => 'https://opencode.ai/zen/v1',
      buildHttpRequestBody: () => latestOpencodeNamespaceBody(),
      prepareSseRequestBody: () => undefined,
      getEntryEndpointFromPayload: () => '/v1/responses',
      getClientRequestIdFromContext: () => 'client_req',
      wrapUpstreamSseResponse: async () => ({}),
      getHttpRetryLimit: () => 1,
      shouldRetryHttpError: () => false,
      delayBeforeHttpRetry: async () => undefined,
      resolveBusinessResponseError: () => undefined,
      normalizeHttpError: async (error: unknown) => error as any,
    });

    await executor.execute({}, {
      requestId: 'req_http_wire_sanitize_opencode',
      providerType: 'openai',
      startTime: Date.now(),
      providerId: 'opencode-zen-free',
      providerKey: 'opencode-zen-free.key1.minimax-m3-free',
      runtimeMetadata: {
        target: {
          outboundProfile: 'openai-chat',
          compatibilityProfile: 'compat:passthrough',
        } as any,
      },
    } as any);

    expect(sentBodies).toHaveLength(1);
    expect(countNamespace(sentBodies[0])).toBe(0);
    expect((sentBodies[0] as any).tools).toEqual([
      expect.objectContaining({
        type: 'function',
        function: expect.objectContaining({
          name: 'apply_patch',
          parameters: expect.objectContaining({
            required: ['filePath', 'patch'],
          }),
        }),
      }),
    ]);
  });
});
