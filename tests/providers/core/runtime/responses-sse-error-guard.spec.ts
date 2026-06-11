import { describe, expect, it } from '@jest/globals';

import {
  inspectResponsesSseBlockForProviderRateLimit,
  isResponsesSseAdvisoryRateLimitsBlock
} from '../../../../src/providers/core/runtime/responses-sse-error-guard.js';

describe('responses SSE error guard', () => {
  it('maps codex.rate_limits limit_reached frames to provider rate limit', () => {
    const result = inspectResponsesSseBlockForProviderRateLimit([
      'event: codex.rate_limits',
      'data: {"type":"codex.rate_limits","limit_reached":true}',
      '',
    ].join('\n'));

    expect(result).toEqual({
      code: 'codex.rate_limits',
      message: 'upstream Responses SSE rate limit reached'
    });
  });

  it('does not treat codex.rate_limits advisory frames as provider rate limit when limit is not reached', () => {
    const block = [
      'event: codex.rate_limits',
      'data: {"type":"codex.rate_limits","limit_reached":false}',
      '',
    ].join('\n');
    const result = inspectResponsesSseBlockForProviderRateLimit(block);

    expect(result).toBeNull();
    expect(isResponsesSseAdvisoryRateLimitsBlock(block)).toBe(true);
  });
});
