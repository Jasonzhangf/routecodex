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

  it('extracts nested upstream 400 message and code from wrapped provider error text', () => {
    const upstreamReason = "400: {'upstream_status': 400, 'upstream_request_id': '61d6fab5-e187-4a17-8c03-508042424fbd', 'error': {'error': {'message': \"Missing required parameter: 'input[2].content[0].text'.\", 'type': 'invalid_request_error', 'param': 'input[2].content[0].text', 'code': 'missing_required_parameter'}}}";
    const snapshot = __requestExecutorTestables.extractRetryErrorSnapshot({
      statusCode: 400,
      message: `HTTP 400: ${JSON.stringify({
        error: {
          code: null,
          message: upstreamReason,
          param: null,
          type: 'server_error'
        }
      })}`
    });

    expect(snapshot.statusCode).toBe(400);
    expect(snapshot.errorCode).toBe('missing_required_parameter');
    expect(snapshot.reason).toBe("Missing required parameter: 'input[2].content[0].text'.");
  });
});
