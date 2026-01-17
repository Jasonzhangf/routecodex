import { mapErrorToHttp } from '../../../src/server/utils/http-error-mapper.js';

describe('http-error-mapper malformed request handling', () => {
  it('maps MALFORMED_REQUEST to 400', () => {
    const payload = mapErrorToHttp({
      message: 'Responses payload produced no chat messages',
      code: 'MALFORMED_REQUEST',
      requestId: 'req_test',
      providerType: 'responses',
      providerKey: 'tabglm.key1.glm-4.7'
    });
    expect(payload.status).toBe(400);
    expect(payload.body.error.code).toBe('MALFORMED_REQUEST');
  });
});

