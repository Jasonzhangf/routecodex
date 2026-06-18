import { describe, expect, it } from '@jest/globals';

import { normalizeProviderHttpError } from '../../../../src/providers/core/runtime/provider-http-executor-utils.js';

describe('normalizeProviderHttpError', () => {
  it('projects transport fetch failures with canonical network code instead of HTTP_HANDLER_ERROR fallback', async () => {
    const error = new TypeError('fetch failed');

    const normalized = await normalizeProviderHttpError({
      error,
      processedRequest: {},
      requestInfo: {
        endpoint: '/chat/completions',
        headers: {},
        targetUrl: 'https://xlapis.com/v1/chat/completions',
        body: {},
        wantsSse: false
      },
      context: {
        requestId: 'req_provider_http_error_fetch_failed',
        providerKey: 'XLC.key1.glm-5.2',
        providerId: 'XLC'
      } as any
    });

    expect(normalized.code).toBe('ECONNRESET');
    expect(normalized.statusCode).toBe(502);
    expect(normalized.status).toBe(502);
    expect(normalized.response?.data?.error?.code).toBe('ECONNRESET');
    expect(normalized.response?.data?.error?.message).toBe('fetch failed');
  });
});
