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
});
