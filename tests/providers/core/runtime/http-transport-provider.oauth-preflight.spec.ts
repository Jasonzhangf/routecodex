import { jest } from '@jest/globals';

describe('OAuthHeaderPreflight', () => {
  test('throws auth error and triggers background repair when ensureValid detects invalid token', async () => {
    jest.resetModules();

    const ensureValidOAuthToken = jest.fn(async () => {
      throw new Error('Token refresh failed (permanent): OAuth error: invalid_grant - Token has been expired or revoked.');
    });
    const handleUpstreamInvalidOAuthToken = jest.fn(async () => false);
    const shouldTriggerInteractiveOAuthRepair = jest.fn(() => true);

    jest.unstable_mockModule('../../../../src/providers/auth/oauth-lifecycle.js', () => ({
      ensureValidOAuthToken,
      handleUpstreamInvalidOAuthToken,
      shouldTriggerInteractiveOAuthRepair
    }));

    const { OAuthHeaderPreflight } = await import(
      '../../../../src/providers/core/runtime/transport/oauth-header-preflight.js'
    );

    await expect(
      OAuthHeaderPreflight.ensureTokenReady({
        auth: {
          type: 'gemini-oauth',
          tokenFile: '/tmp/routecodex-oauth-preflight-token.json'
        } as any,
        authProvider: null,
        oauthProviderId: 'gemini'
      })
    ).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_INVALID_TOKEN'
    });

    expect(ensureValidOAuthToken).toHaveBeenCalledTimes(1);
    expect(shouldTriggerInteractiveOAuthRepair).toHaveBeenCalledTimes(1);
    expect(handleUpstreamInvalidOAuthToken).toHaveBeenCalledTimes(1);
    expect(handleUpstreamInvalidOAuthToken).toHaveBeenCalledWith(
      'gemini',
      expect.objectContaining({ type: 'gemini-oauth' }),
      expect.objectContaining({ code: 'AUTH_INVALID_TOKEN' }),
      expect.objectContaining({ allowBlocking: false })
    );
  });
});
