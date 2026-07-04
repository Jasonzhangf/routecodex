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

  it('projects model capacity text without status as retryable HTTP_429', async () => {
    const error = new Error('Selected model is at capacity. Please try a different model.');

    const normalized = await normalizeProviderHttpError({
      error,
      processedRequest: {},
      requestInfo: {
        endpoint: '/responses',
        headers: {},
        targetUrl: 'https://example.invalid/v1/responses',
        body: {},
        wantsSse: true
      },
      context: {
        requestId: 'req_provider_http_error_model_capacity',
        providerKey: 'openai-responses-minimax.key1.MiniMax-M3',
        providerId: 'openai-responses-minimax'
      } as any
    });

    expect(normalized.code).toBe('HTTP_429');
    expect(normalized.statusCode).toBe(429);
    expect(normalized.status).toBe(429);
    expect(normalized.response?.data?.error?.code).toBe('HTTP_429');
    expect(normalized.response?.data?.error?.message).toBe('Selected model is at capacity. Please try a different model.');
    expect(normalized.response?.data?.error?.status).toBe(429);
  });

  it('applies provider-configured error mapping to raw upstream error bodies before catalog projection', async () => {
    const error = new Error('HTTP 400: {"error":{"message":"All available accounts exhausted","type":"server_error","param":"","code":null}}') as any;
    error.status = 400;
    error.statusCode = 400;
    error.code = 'HTTP_400';
    error.response = {
      raw: '{"error":{"message":"All available accounts exhausted","type":"server_error","param":"","code":null}}'
    };

    const normalized = await normalizeProviderHttpError({
      error,
      processedRequest: {},
      requestInfo: {
        endpoint: '/responses',
        headers: {},
        targetUrl: 'https://xlapis.com/v1/responses',
        body: {},
        wantsSse: true
      },
      context: {
        requestId: 'req_provider_http_error_mapped_exhausted',
        providerKey: 'XLC.key2.deepseek-v4-pro',
        providerId: 'XLC',
        runtimeMetadata: {
          extensions: {
            errorMapping: {
              rules: [
                {
                  origin: {
                    status: 400,
                    error: {
                      messageContains: 'All available accounts exhausted',
                      type: 'server_error'
                    }
                  },
                  to: {
                    status: 429,
                    code: 'HTTP_429',
                    message: 'All available accounts exhausted'
                  }
                }
              ]
            }
          }
        }
      } as any
    });

    expect(normalized.statusCode).toBe(429);
    expect(normalized.status).toBe(429);
    expect(normalized.code).toBe('HTTP_429');
    expect(normalized.response?.data?.error?.code).toBe('HTTP_429');
    expect(normalized.response?.data?.error?.message).toBe('All available accounts exhausted');
    expect(normalized.response?.data?.error?.status).toBe(429);
    expect((normalized as any).details?.providerErrorMapping?.originalStatus).toBe(400);
  });

  it('applies provider-configured error mapping when upstream error JSON is only embedded in Error.message', async () => {
    const error = new Error('HTTP 400: {"error":{"message":"All available accounts exhausted","type":"server_error","param":"","code":null}}') as any;
    error.status = 400;
    error.statusCode = 400;
    error.code = 'HTTP_400';
    error.response = {
      data: {
        error: {
          code: 'HTTP_400',
          status: 400
        }
      }
    };

    const normalized = await normalizeProviderHttpError({
      error,
      processedRequest: {},
      requestInfo: {
        endpoint: '/responses',
        headers: {},
        targetUrl: 'https://xlapis.com/v1/responses',
        body: {},
        wantsSse: true
      },
      context: {
        requestId: 'req_provider_http_error_mapped_exhausted_from_message',
        providerKey: 'XLC.key2.deepseek-v4-pro',
        providerId: 'XLC',
        runtimeMetadata: {
          extensions: {
            errorMapping: {
              rules: [
                {
                  origin: {
                    status: 400,
                    error: {
                      messageContains: 'All available accounts exhausted',
                      type: 'server_error'
                    }
                  },
                  to: {
                    status: 429,
                    code: 'HTTP_429',
                    message: 'All available accounts exhausted'
                  }
                }
              ]
            }
          }
        }
      } as any
    });

    expect(normalized.statusCode).toBe(429);
    expect(normalized.status).toBe(429);
    expect(normalized.code).toBe('HTTP_429');
    expect(normalized.response?.data?.error?.code).toBe('HTTP_429');
    expect(normalized.response?.data?.error?.status).toBe(429);
    expect((normalized as any).details?.providerErrorMapping?.originalStatus).toBe(400);
  });
});
