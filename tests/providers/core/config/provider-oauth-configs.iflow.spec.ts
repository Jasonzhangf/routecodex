import { describe, expect, test } from '@jest/globals';

import { OAuthFlowType } from '../../../../src/providers/core/config/oauth-flows.js';
import { getProviderOAuthConfig } from '../../../../src/providers/core/config/provider-oauth-configs.js';

describe('provider-oauth-configs iflow defaults', () => {
  test('uses authorization code flow for default iflow OAuth', () => {
    const config = getProviderOAuthConfig('iflow');
    expect(config.flowType).toBe(OAuthFlowType.AUTHORIZATION_CODE);
    expect(config.endpoints.authorizationUrl).toBe('https://iflow.cn/oauth');
    expect(config.endpoints.tokenUrl).toBe('https://iflow.cn/oauth/token');
    expect(config.client.clientId).toBe('10009311001');
    expect(config.client.clientSecret).toBe('4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW');
  });

  test('keeps iflow-device as explicit device-code fallback', () => {
    const config = getProviderOAuthConfig('iflow-device');
    expect(config.flowType).toBe(OAuthFlowType.DEVICE_CODE);
    expect(config.endpoints.deviceCodeUrl).toBe('https://iflow.cn/api/oauth2/device/code');
    expect(config.endpoints.tokenUrl).toBe('https://iflow.cn/api/oauth2/token');
  });
});
