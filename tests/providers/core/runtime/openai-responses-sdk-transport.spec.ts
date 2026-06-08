import {
  deriveResponsesSdkBaseUrl,
  OpenAiResponsesSdkTransport
} from '../../../../src/providers/core/runtime/openai-responses-sdk-transport.js';

describe('deriveResponsesSdkBaseUrl', () => {
  it('keeps the v1 prefix and trims the trailing /responses endpoint', () => {
    expect(deriveResponsesSdkBaseUrl('https://example.com/openai/v1/responses')).toBe(
      'https://example.com/openai/v1'
    );
  });
});

describe('OpenAiResponsesSdkTransport', () => {
  it('sends a non-stream responses request through the OpenAI SDK transport and preserves payload fields', async () => {
    const originalFetch = global.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          object: 'response',
          status: 'completed',
          output: []
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-request-id': 'sdk_resp_1' }
        }
      );
    }) as typeof fetch;

    try {
      const transport = new OpenAiResponsesSdkTransport();
      const response = await transport.executePreparedRequest(
        {
          endpoint: '/v1/responses',
          headers: {
            authorization: 'Bearer test-key',
            'content-type': 'application/json',
            'x-trace-id': 'trace-1'
          },
          targetUrl: 'https://example.com/openai/v1/responses',
          body: {
            model: 'gpt-5.4',
            input: 'hello',
            text: { verbosity: 'high' }
          },
          wantsSse: false
        },
        { requestId: 'req_1' } as any
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://example.com/openai/v1/responses');
      const requestBody = JSON.parse(String(calls[0].init?.body));
      expect(requestBody).toMatchObject({
        model: 'gpt-5.4',
        input: 'hello',
        text: { verbosity: 'high' }
      });
      expect(response).toMatchObject({
        status: 200,
        data: {
          id: 'resp_1',
          status: 'completed'
        },
        headers: {
          'x-request-id': 'sdk_resp_1'
        }
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('forces stream=true for SSE responses requests', async () => {
    const originalFetch = global.fetch;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response('event: response.completed\n\ndata: {}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      });
    }) as typeof fetch;

    try {
      const transport = new OpenAiResponsesSdkTransport();
      const response = await transport.executePreparedRequest(
        {
          endpoint: '/v1/responses',
          headers: {
            authorization: 'Bearer test-key',
            'content-type': 'application/json'
          },
          targetUrl: 'https://example.com/v1/responses',
          body: {
            model: 'gpt-5.4',
            input: 'hello',
            stream: false
          },
          wantsSse: true
        },
        { requestId: 'req_stream' } as any
      );

      const requestBody = JSON.parse(String(calls[0].init?.body));
      expect(requestBody.stream).toBe(true);
      expect((response as any).__sse_responses).toBeDefined();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('surfaces early upstream Responses SSE concurrency errors as retryable provider 429', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () => {
      const body = [
        ': keepalive',
        '',
        'event: error',
        `data: ${JSON.stringify({
          type: 'error',
          code: 'rate_limit_error',
          message: 'Concurrency limit exceeded for user, please retry later'
        })}`,
        '',
        'event: response.failed',
        `data: ${JSON.stringify({
          type: 'response.failed',
          response: {
            status: 'failed',
            error: {
              code: 'rate_limit_error',
              message: 'Concurrency limit exceeded for user, please retry later'
            }
          }
        })}`,
        ''
      ].join('\n');
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      });
    }) as typeof fetch;

    try {
      const transport = new OpenAiResponsesSdkTransport();
      await expect(transport.executePreparedRequest(
        {
          endpoint: '/v1/responses',
          headers: {
            authorization: 'Bearer test-key',
            'content-type': 'application/json'
          },
          targetUrl: 'https://example.com/v1/responses',
          body: {
            model: 'gpt-5.5',
            input: 'hello'
          },
          wantsSse: true
        },
        { requestId: 'req_stream_error' } as any
      )).rejects.toMatchObject({
        statusCode: 429,
        code: 'PROVIDER_TRAFFIC_SATURATED',
        upstreamCode: 'rate_limit_error',
        retryable: true,
        requestExecutorProviderErrorStage: 'provider.http'
      });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('replays buffered normal SSE frames when no early upstream error is present', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async () => new Response('event: response.created\n' +
      `data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_buffered', status: 'in_progress' } })}\n\n` +
      'event: response.completed\n' +
      `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_buffered', status: 'completed' } })}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })) as typeof fetch;

    try {
      const transport = new OpenAiResponsesSdkTransport();
      const response = await transport.executePreparedRequest(
        {
          endpoint: '/v1/responses',
          headers: {
            authorization: 'Bearer test-key',
            'content-type': 'application/json'
          },
          targetUrl: 'https://example.com/v1/responses',
          body: {
            model: 'gpt-5.5',
            input: 'hello'
          },
          wantsSse: true
        },
        { requestId: 'req_stream_success' } as any
      );
      const chunks: Buffer[] = [];
      for await (const chunk of (response as any).__sse_responses) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const text = Buffer.concat(chunks).toString('utf8');
      expect(text).toContain('event: response.created');
      expect(text).toContain('event: response.completed');
      expect(text).toContain('resp_buffered');
    } finally {
      global.fetch = originalFetch;
    }
  });
});
