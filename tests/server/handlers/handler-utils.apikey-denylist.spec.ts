import { captureClientHeaders } from '../../../src/server/handlers/handler-utils.js';

describe('captureClientHeaders denylist', () => {
  it('drops api key headers to avoid leaking secrets', () => {
    const captured = captureClientHeaders({
      'x-api-key': 'secret',
      'x-routecodex-api-key': 'secret2',
      authorization: 'Bearer secret3',
      'user-agent': 'jest'
    });

    expect(captured).toEqual({ 'user-agent': 'jest' });
  });
});

