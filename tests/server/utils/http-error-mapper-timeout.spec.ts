import { mapErrorToHttp } from '../../../src/server/utils/http-error-mapper.js';

describe('http-error-mapper timeout handling', () => {
  it('maps upstream timeout-style errors to 504', () => {
    const payload = mapErrorToHttp({
      message: 'UPSTREAM_HEADERS_TIMEOUT',
      code: 'UPSTREAM_HEADERS_TIMEOUT',
      requestId: 'req_test',
      providerKey: 'tab.default.gpt-5.1'
    });
    expect(payload.status).toBe(504);
    expect(payload.body.error.code).toBe('UPSTREAM_HEADERS_TIMEOUT');
  });
});

