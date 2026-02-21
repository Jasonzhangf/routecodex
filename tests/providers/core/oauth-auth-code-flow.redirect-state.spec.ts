import { describe, expect, test } from '@jest/globals';

import { OAuthAuthCodeFlowStrategy } from '../../../src/providers/core/strategies/oauth-auth-code-flow.js';

describe('OAuth auth-code redirect rewrite', () => {
  test('preserves state for standard flow when redirect_uri is updated', () => {
    const strategy = new OAuthAuthCodeFlowStrategy(
      {
        flowType: 'authorization_code' as any,
        endpoints: {
          authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          tokenUrl: 'https://oauth2.googleapis.com/token'
        },
        client: {
          clientId: 'test-client-id',
          scopes: ['openid'],
          redirectUri: 'http://localhost:8080/oauth2callback'
        },
        features: {
          supportsPKCE: true
        }
      } as any
    );

    const authUrl = new URL(
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=test-client-id&state=old-state' +
      '&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Foauth2callback&redirect=http%3A%2F%2Fold.example'
    );

    (strategy as any).applyAuthRedirectParams(
      authUrl,
      'standard',
      'http://localhost:43123/oauth2callback',
      'new-state'
    );

    expect(authUrl.searchParams.get('redirect')).toBeNull();
    expect(authUrl.searchParams.get('redirect_uri')).toBe('http://localhost:43123/oauth2callback');
    expect(authUrl.searchParams.get('state')).toBe('new-state');
  });

  test('continues waiting after mismatched state callback and accepts the valid callback', async () => {
    const strategy = new OAuthAuthCodeFlowStrategy(
      {
        flowType: 'authorization_code' as any,
        endpoints: {
          authorizationUrl: 'https://iflow.cn/oauth',
          tokenUrl: 'https://iflow.cn/oauth/token'
        },
        client: {
          clientId: 'iflow-client-id',
          scopes: ['openid'],
          redirectUri: 'http://localhost:8080/oauth2callback'
        },
        features: {
          supportsPKCE: false
        }
      } as any
    );

    const expectedState = 'expected-state-value';
    const verifier = 'expected-verifier';
    const serverResult = await (strategy as any).startCallbackServer(expectedState, verifier);
    const callbackUrl = new URL(serverResult.redirectUri);
    const callbackEndpoint = `${callbackUrl.origin}${callbackUrl.pathname}`;

    const mismatchResponse = await fetch(`${callbackEndpoint}?code=stale-code&state=wrong-state`);
    expect(mismatchResponse.status).toBe(400);
    await mismatchResponse.text();

    const successResponse = await fetch(`${callbackEndpoint}?code=valid-code&state=${expectedState}`);
    expect(successResponse.status).toBe(200);
    await successResponse.text();

    await expect(serverResult.callbackPromise).resolves.toEqual({
      code: 'valid-code',
      verifier
    });
  });
});
