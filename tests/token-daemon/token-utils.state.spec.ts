import { describe, expect, it } from '@jest/globals';

import { evaluateTokenState } from '../../src/token-daemon/token-utils.js';

describe('token-daemon token-utils evaluateTokenState', () => {
  it('treats qwen api_key==access_token fallback as expirable token', () => {
    const now = Date.now();
    const state = evaluateTokenState(
      {
        access_token: 'same-token',
        api_key: 'same-token',
        expires_at: now - 60_000
      },
      now,
      'qwen'
    );
    expect(state.status).toBe('expired');
  });

  it('does not treat iflow api_key as perpetual valid credential', () => {
    const now = Date.now();
    const state = evaluateTokenState(
      {
        access_token: 'expired-token',
        api_key: 'stable-iflow-key',
        expires_at: now - 60_000
      },
      now,
      'iflow'
    );
    expect(state.status).toBe('expired');
  });

  it('treats iflow non-expired access_token as valid', () => {
    const now = Date.now();
    const state = evaluateTokenState(
      {
        access_token: 'valid-token',
        api_key: 'iflow-key',
        expires_at: now + 3_600_000
      },
      now,
      'iflow'
    );
    expect(state.status).toBe('valid');
  });
});
