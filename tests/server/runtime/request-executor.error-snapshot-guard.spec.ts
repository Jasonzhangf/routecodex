import { jest } from '@jest/globals';
import { __requestExecutorTestables } from '../../../src/server/runtime/http-server/request-executor.js';

describe('request-executor retry snapshot guard', () => {
  it('skips oversized json parse candidate and still extracts status from regex', () => {
    const hugeMessage = `${'x'.repeat(300_000)} HTTP 429: quota exhausted`;
    const snapshot = __requestExecutorTestables.extractRetryErrorSnapshot({
      message: hugeMessage
    });
    expect(snapshot.statusCode).toBe(429);
  });

  it('skips html 504 bodies without parseCandidate warning noise and still extracts status', () => {
    __requestExecutorTestables.resetRequestExecutorInternalStateForTests();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const snapshot = __requestExecutorTestables.extractRetryErrorSnapshot({
        message: 'HTTP 504: <!DOCTYPE html><html lang="en-US"><head><style>body{color:red}</style></head><body>gateway timeout</body></html>'
      });
      expect(snapshot.statusCode).toBe(504);
      expect(snapshot.reason).toContain('HTTP 504');
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('parseJsonRecordFromText.parseCandidate'));
    } finally {
      warnSpy.mockRestore();
    }
  });
});
