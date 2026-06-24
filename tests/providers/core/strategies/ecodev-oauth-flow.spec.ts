import fs from 'fs';
import os from 'os';
import path from 'path';
import { Buffer } from 'node:buffer';

import { describe, expect, test } from '@jest/globals';
import {
  EcoDevOAuthFlowStrategy,
  parseEcoDevCallbackParams
} from '../../../../src/providers/core/strategies/ecodev-oauth-flow.js';
import {
  createProviderOAuthStrategy,
  getProviderOAuthConfig
} from '../../../../src/providers/core/config/provider-oauth-configs.js';
import {
  OAuthActivationType,
  OAuthFlowType,
  type OAuthFlowConfig
} from '../../../../src/providers/core/config/oauth-flows.js';

function createConfig(): OAuthFlowConfig {
  return {
    flowType: OAuthFlowType.AUTHORIZATION_CODE,
    activationType: OAuthActivationType.AUTO_BROWSER,
    endpoints: {
      authorizationUrl: 'https://cn.devecostudio.huawei.com/console/DevEcoIDE/apply',
      deviceCodeUrl: 'ecodev-local-callback',
      tokenUrl: 'https://cn.devecostudio.huawei.com/authrouter/auth/api/temptoken/check',
      userInfoUrl: 'https://cn.devecostudio.huawei.com/authrouter/auth/api/jwToken/check'
    },
    client: {
      clientId: '1008',
      scopes: []
    }
  };
}

function createJwtPayload(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'jwtv1' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

describe('EcoDev OAuth flow', () => {
  test('provider oauth config creates EcoDev strategy', () => {
    expect(getProviderOAuthConfig('ecodev', {}).client.clientId).toBe('1008');
    expect(createProviderOAuthStrategy('ecodev', {}, '/tmp/ecodev-oauth.json')).toBeInstanceOf(EcoDevOAuthFlowStrategy);
  });

  test('rejects callback without tempToken', () => {
    expect(() => parseEcoDevCallbackParams('/callback?code=expected&siteId=1', '', 'expected')).toThrow(/Missing tempToken/);
  });

  test('rejects callback code mismatch', () => {
    expect(() => parseEcoDevCallbackParams('/callback?code=actual&tempToken=temp&siteId=1', '', 'expected')).toThrow(/code mismatch/);
  });

  test('rejects unsupported siteId', () => {
    expect(() => parseEcoDevCallbackParams('/callback?code=expected&tempToken=temp&siteId=2', '', 'expected')).toThrow(/Unsupported region/);
  });

  test('rejects invalid JWT during token exchange', async () => {
    const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-ecodev-oauth-')), 'ecodev-oauth-1-default.json');
    const strategy = new EcoDevOAuthFlowStrategy(
      createConfig(),
      (async (url: string) => {
        if (url.includes('/temptoken/check')) {
          return new Response('invalid-jwt', { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch,
      tokenFile
    );

    await expect(strategy.exchangeTempTokenForToken('temp-token')).rejects.toThrow(/Invalid JWT format/);
  });

  test('saves access token payload as bearer-readable token file', async () => {
    const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-ecodev-oauth-')), 'ecodev-oauth-1-default.json');
    const payload = {
      access_token: 'access-1',
      refresh_token: '',
      jwt_token: 'header.payload.sig',
      token_type: 'Bearer',
      provider: 'ecodev',
      site_id: '1'
    };
    const strategy = new EcoDevOAuthFlowStrategy(createConfig(), fetch, tokenFile);

    await strategy.saveToken(payload);

    expect(JSON.parse(fs.readFileSync(tokenFile, 'utf8'))).toEqual(payload);
  });

  test('extracts refresh token and expiry from jwt payload during login exchange', async () => {
    const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-ecodev-oauth-')), 'ecodev-oauth-1-default.json');
    const jwtToken = createJwtPayload({
      access_token: 'jwt-access',
      refresh_token: 'jwt-refresh',
      exp: 1784529816
    });
    const strategy = new EcoDevOAuthFlowStrategy(
      createConfig(),
      (async (url: string) => {
        if (url.includes('/temptoken/check')) {
          return new Response(jwtToken, { status: 200 });
        }
        if (url.includes('/jwToken/check')) {
          return new Response(JSON.stringify({
            status: true,
            userInfo: {
              accessToken: 'wire-access',
              refreshToken: ''
            }
          }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as typeof fetch,
      tokenFile
    );

    const token = await strategy.exchangeTempTokenForToken('temp-token');

    expect(token).toMatchObject({
      access_token: 'wire-access',
      refresh_token: 'jwt-refresh',
      jwt_token: jwtToken,
      expires_at: 1784529816000
    });
  });

  test('refreshes EcoDev token non-interactively via existing jwt_token', async () => {
    const tokenFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-ecodev-oauth-')), 'ecodev-oauth-1-default.json');
    const jwtToken = createJwtPayload({
      refresh_token: 'jwt-refresh',
      exp: 1784529816
    });
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const strategy = new EcoDevOAuthFlowStrategy(
      createConfig(),
      (async (url: string, init?: RequestInit) => {
        requests.push({
          url,
          headers: Object.fromEntries(new Headers(init?.headers).entries())
        });
        return new Response(JSON.stringify({
          status: true,
          userInfo: {
            accessToken: 'refreshed-access',
            refreshToken: ''
          }
        }), { status: 200 });
      }) as typeof fetch,
      tokenFile
    );
    await strategy.saveToken({
      access_token: 'old-access',
      refresh_token: 'jwt-refresh',
      jwt_token: jwtToken,
      token_type: 'Bearer',
      provider: 'ecodev',
      site_id: '1',
      expires_at: Date.now() - 1000
    });

    const refreshed = await strategy.refreshToken('jwt-refresh');

    expect(refreshed).toMatchObject({
      access_token: 'refreshed-access',
      refresh_token: 'jwt-refresh',
      jwt_token: jwtToken,
      expires_at: 1784529816000
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('/jwToken/check');
    expect(requests[0]?.headers).toMatchObject({
      refresh: 'true',
      jwttoken: jwtToken
    });
  });
});
