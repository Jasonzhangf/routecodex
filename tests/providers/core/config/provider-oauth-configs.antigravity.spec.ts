import { describe, expect, test } from '@jest/globals';

import { OAuthFlowType } from '../../../../src/providers/core/config/oauth-flows.js';
import { getProviderOAuthConfig } from '../../../../src/providers/core/config/provider-oauth-configs.js';

describe('provider-oauth-configs antigravity defaults', () => {
  test('uses authorization code flow and provides client credentials fields', () => {
    const config = getProviderOAuthConfig('antigravity');
    expect(config.flowType).toBe(OAuthFlowType.AUTHORIZATION_CODE);
    expect(config.endpoints.authorizationUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(config.endpoints.tokenUrl).toBe('https://oauth2.googleapis.com/token');
    expect(typeof config.client.clientId).toBe('string');
    expect(config.client.clientId.length).toBeGreaterThan(0);
    expect(typeof config.client.clientSecret).toBe('string');
    expect(config.client.clientSecret.length).toBeGreaterThan(0);
  });

  test('gemini-cli keeps authorization code flow with client credentials fields', () => {
    const config = getProviderOAuthConfig('gemini-cli');
    expect(config.flowType).toBe(OAuthFlowType.AUTHORIZATION_CODE);
    expect(config.endpoints.authorizationUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(config.endpoints.tokenUrl).toBe('https://oauth2.googleapis.com/token');
    expect(typeof config.client.clientId).toBe('string');
    expect(config.client.clientId.length).toBeGreaterThan(0);
    expect(typeof config.client.clientSecret).toBe('string');
    expect(config.client.clientSecret.length).toBeGreaterThan(0);
  });
});
