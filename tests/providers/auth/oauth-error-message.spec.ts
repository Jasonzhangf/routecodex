import { describe, expect, test } from '@jest/globals';

import { formatOAuthErrorMessage } from '../../../src/providers/auth/oauth-error-message.js';

describe('formatOAuthErrorMessage', () => {
  test('includes cause details when present', () => {
    const err = new Error('fetch failed') as Error & { cause?: unknown };
    err.cause = {
      code: 'ENOTFOUND',
      syscall: 'getaddrinfo',
      hostname: 'oauth2.googleapis.com',
      message: 'getaddrinfo ENOTFOUND oauth2.googleapis.com'
    };

    const msg = formatOAuthErrorMessage(err);
    expect(msg).toContain('fetch failed');
    expect(msg).toContain('code=ENOTFOUND');
    expect(msg).toContain('syscall=getaddrinfo');
    expect(msg).toContain('hostname=oauth2.googleapis.com');
  });

  test('handles non-error values', () => {
    expect(formatOAuthErrorMessage('plain failure')).toBe('plain failure');
  });
});
