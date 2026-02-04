import { describe, expect, test } from '@jest/globals';

import { shouldTriggerInteractiveOAuthRepair } from '../../../src/providers/auth/oauth-lifecycle.js';

describe('oauth-lifecycle: google verify 403 detection', () => {
  test('detects 403 verify-your-account when statusCode is nested in response.status', () => {
    const err = {
      message:
        'HTTP 403: { "error": { "code": 403, "message": "To continue, verify your account at https://accounts.google.com/signin/continue?..."} }',
      response: { status: 403 }
    };
    expect(shouldTriggerInteractiveOAuthRepair('antigravity', err)).toBe(true);
  });
});

