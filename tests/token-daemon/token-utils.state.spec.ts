import { describe, expect, it } from '@jest/globals';
import { Buffer } from 'node:buffer';

import { evaluateTokenState } from '../../src/token-daemon/token-utils.js';

function createJwtPayload(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'jwtv1' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

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

  it('does not treat glm api_key as perpetual valid credential', () => {
    const now = Date.now();
    const state = evaluateTokenState(
      {
        access_token: 'expired-token',
        api_key: 'stable-glm-key',
        expires_at: now - 60_000
      },
      now,
      'glm'
    );
    expect(state.status).toBe('expired');
  });

  it('treats glm non-expired access_token as valid', () => {
    const now = Date.now();
    const state = evaluateTokenState(
      {
        access_token: 'valid-token',
        api_key: 'glm-key',
        expires_at: now + 3_600_000
      },
      now,
      'glm'
    );
    expect(state.status).toBe('valid');
  });

  it('does not honor qwen noRefresh flag when token lacks stable api_key', () => {
    const now = Date.now();
    const state = evaluateTokenState(
      {
        access_token: 'valid-qwen-token',
        expires_at: now + 3_600_000,
        noRefresh: true,
        norefresh: true
      },
      now,
      'qwen'
    );
    expect(state.status).toBe('valid');
    expect(state.noRefresh).toBe(false);
  });

  it('honors qwen noRefresh flag only when stable api_key exists', () => {
    const now = Date.now();
    const state = evaluateTokenState(
      {
        access_token: 'valid-qwen-token',
        api_key: 'stable-qwen-key',
        expires_at: now - 60_000,
        noRefresh: true,
        norefresh: true
      },
      now,
      'qwen'
    );
    expect(state.status).toBe('valid');
    expect(state.noRefresh).toBe(true);
  });

  it('reads ecodev refresh token and expiry from jwt_token payload for legacy token files', () => {
    const now = Date.now();
    const expSeconds = Math.floor((now + 3_600_000) / 1000);
    const state = evaluateTokenState(
      {
        access_token: 'valid-ecodev-token',
        refresh_token: '',
        jwt_token: createJwtPayload({
          refresh_token: 'jwt-refresh',
          exp: expSeconds
        })
      },
      now,
      'ecodev'
    );
    expect(state.status).toBe('valid');
    expect(state.hasRefreshToken).toBe(true);
    expect(state.expiresAt).toBe(expSeconds * 1000);
  });
});
