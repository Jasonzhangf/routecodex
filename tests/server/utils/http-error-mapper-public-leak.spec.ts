import { mapErrorToHttp } from '../../../src/server/utils/http-error-mapper.js';

describe('http-error-mapper public payload leak guard', () => {
  it('masks provider diagnostics from upstream 400 payloads', () => {
    const mapped = mapErrorToHttp({
      message: 'HTTP 400: {"error":{"message":"{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"bad_request_error\\",\\"message\\":\\"Error from provider (MiniMax): invalid params, tool result id not found (2013)\\",\\"http_code\\":\\"400\\"},\\"request_id\\":\\"066c94854d8da9b51651e2d687289e42\\"}","code":"HTTP_400"}}',
      code: 'HTTP_400',
      status: 400,
      requestId: 'openai-responses-opencode-zen-free.key1-minimax-m3-free-20260601T184003969-246178-1902',
      providerKey: 'opencode-zen-free.key1.minimax-m3-free',
      providerType: 'openai',
      routeName: 'search',
      details: {
        providerKey: 'opencode-zen-free.key1.minimax-m3-free',
        providerType: 'openai',
        routeName: 'search',
        upstreamMessage: 'Error from provider (MiniMax): invalid params, tool result id not found (2013)',
        status: 400
      }
    });

    const publicJson = JSON.stringify(mapped.body);
    expect(mapped.status).toBe(400);
    expect(mapped.body.error).toMatchObject({
      message: 'Upstream rejected the request',
      code: 'HTTP_400',
      request_id: 'openai-responses-provider-20260601T184003969-246178-1902'
    });
    expect(publicJson).not.toContain('MiniMax');
    expect(publicJson).not.toContain('minimax');
    expect(publicJson).not.toContain('provider_key');
    expect(publicJson).not.toContain('upstream_message');
    expect(publicJson).not.toContain('tool result id not found');
  });
});
