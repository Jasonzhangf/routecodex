import {
  captureClientHeaders,
  captureRawRequestBodyForMetadata
} from '../../../src/server/handlers/handler-utils.js';

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

describe('captureRawRequestBodyForMetadata', () => {
  it('captures the full raw request body for direct passthrough replay', () => {
    const payload = {
      model: 'qwen3.6-plus',
      metadata: { sessionId: 'sid-1', nested: { a: 1 } },
      messages: Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `m-${i}` }))
    };
    const captured = captureRawRequestBodyForMetadata(payload) as Record<string, unknown>;
    expect(captured).not.toBe(payload);
    expect(captured.model).toBe('qwen3.6-plus');
    expect(Array.isArray(captured.messages)).toBe(true);
    expect((captured.messages as unknown[]).length).toBe(40);
    expect(captured.metadata).toEqual({ sessionId: 'sid-1', nested: { a: 1 } });
  });
});
