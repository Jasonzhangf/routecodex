import { __requestExecutorTestables } from '../../../src/server/runtime/http-server/request-executor.js';

describe('request-executor retry snapshot guard', () => {
  it('skips oversized json parse candidate and still extracts status from regex', () => {
    const hugeMessage = `${'x'.repeat(300_000)} HTTP 429: quota exhausted`;
    const snapshot = __requestExecutorTestables.extractRetryErrorSnapshot({
      message: hugeMessage
    });
    expect(snapshot.statusCode).toBe(429);
  });
});

