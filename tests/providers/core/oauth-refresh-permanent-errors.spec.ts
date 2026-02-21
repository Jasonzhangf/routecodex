import { describe, expect, test, jest } from '@jest/globals';

import { OAuthDeviceFlowStrategy } from '../../../src/providers/core/strategies/oauth-device-flow.js';
import { OAuthAuthCodeFlowStrategy } from '../../../src/providers/core/strategies/oauth-auth-code-flow.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('OAuth refreshToken aborts early on permanent errors', () => {
  test('device flow stops retrying on invalid refresh token/client_id', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    const httpClient = async (url: string, _init?: RequestInit) => {
      calls.push(url);
      return jsonResponse(400, {
        error: 'invalid_request',
        error_description: 'Invalid refresh token or client_id'
      });
    };

    const strategy = new OAuthDeviceFlowStrategy(
      {
        flowType: 'device_code' as any,
        endpoints: { deviceCodeUrl: 'https://x/device', tokenUrl: 'https://x/token' },
        client: { clientId: 'qwen-code' },
        retry: { maxAttempts: 3, backoffMs: 1 }
      } as any,
      httpClient as any,
      '/tmp/unused.json'
    );

    await expect(strategy.refreshToken('bad')).rejects.toThrow('Token refresh failed (permanent)');
    expect(calls).toHaveLength(1);
    warn.mockRestore();
  });

  test('auth-code flow stops retrying on invalid refresh token/client_id', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    const httpClient = async (url: string, _init?: RequestInit) => {
      calls.push(url);
      return jsonResponse(400, {
        error: 'invalid_request',
        error_description: 'Invalid refresh token or client_id'
      });
    };

    const strategy = new OAuthAuthCodeFlowStrategy(
      {
        flowType: 'authorization_code' as any,
        endpoints: { deviceCodeUrl: 'https://x/device', tokenUrl: 'https://x/token' },
        client: { clientId: 'qwen-code', redirectUri: 'http://localhost:8080/oauth2callback' },
        retry: { maxAttempts: 3, backoffMs: 1 }
      } as any,
      httpClient as any,
      '/tmp/unused.json'
    );

    await expect(strategy.refreshToken('bad')).rejects.toThrow('Token refresh failed (permanent)');
    expect(calls).toHaveLength(1);
    warn.mockRestore();
  });

  test('iflow auth-code flow does not retry refresh on token endpoint errors', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    const strategy = new OAuthAuthCodeFlowStrategy(
      {
        flowType: 'authorization_code' as any,
        endpoints: { deviceCodeUrl: 'https://x/device', tokenUrl: 'https://iflow.cn/oauth/token' },
        client: { clientId: 'iflow-code', redirectUri: 'http://localhost:8080/oauth2callback' },
        retry: { maxAttempts: 3, backoffMs: 1 }
      } as any,
      (async (url: string) => {
        calls.push(url);
        return jsonResponse(200, {
          code: 500,
          message: '当前找我聊的人太多了，可以晚点再来问我哦。'
        });
      }) as any,
      '/tmp/unused.json'
    );

    await expect(strategy.refreshToken('bad-refresh')).rejects.toThrow('after 1 attempts');
    expect(calls).toHaveLength(1);
    warn.mockRestore();
  });

  test('auth-code refresh tolerates missing expires_in and does not throw Invalid time value', async () => {
    const strategy = new OAuthAuthCodeFlowStrategy(
      {
        flowType: 'authorization_code' as any,
        endpoints: { deviceCodeUrl: 'https://x/device', tokenUrl: 'https://x/token' },
        client: { clientId: 'iflow-code', redirectUri: 'http://localhost:8080/oauth2callback' },
        retry: { maxAttempts: 1, backoffMs: 1 }
      } as any,
      (async () =>
        jsonResponse(200, {
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          token_type: 'bearer'
        })) as any,
      '/tmp/unused.json'
    );

    const refreshed = await strategy.refreshToken('old-refresh') as Record<string, unknown>;
    expect(typeof refreshed.expires_in).toBe('number');
    expect((refreshed.expires_in as number) > 0).toBe(true);
    expect(typeof refreshed.expires_at).toBe('number');
  });

  test('iflow auth-code defaults to official web auth URL shape', async () => {
    const prev = process.env.IFLOW_AUTH_STYLE;
    delete process.env.IFLOW_AUTH_STYLE;
    try {
      const strategy = new OAuthAuthCodeFlowStrategy(
        {
          flowType: 'authorization_code' as any,
          endpoints: {
            deviceCodeUrl: 'https://iflow.cn/api/oauth2/device/code',
            tokenUrl: 'https://iflow.cn/oauth/token',
            authorizationUrl: 'https://iflow.cn/oauth'
          },
          client: {
            clientId: '10009311001',
            clientSecret: 'secret',
            redirectUri: 'http://localhost:11451/oauth2callback'
          },
          retry: { maxAttempts: 1, backoffMs: 1 }
        } as any,
        (async () => jsonResponse(200, {})) as any,
        '/tmp/unused.json'
      );

      const authCodeData = await (strategy as any).initiateAuthCodeFlow() as Record<string, string>;
      expect(authCodeData.flowStyle).toBe('web');
      const url = new URL(authCodeData.authUrl);
      expect(url.origin + url.pathname).toBe('https://iflow.cn/oauth');
      expect(url.searchParams.get('loginMethod')).toBe('phone');
      expect(url.searchParams.get('type')).toBe('phone');
      expect(url.searchParams.get('client_id')).toBe('10009311001');
      expect(url.searchParams.get('state')).toBe(authCodeData.state);
      const redirect = url.searchParams.get('redirect') ?? '';
      expect(redirect).toBe('http://localhost:11451/oauth2callback');
    } finally {
      if (prev === undefined) {
        delete process.env.IFLOW_AUTH_STYLE;
      } else {
        process.env.IFLOW_AUTH_STYLE = prev;
      }
    }
  });

  test('auth-code refresh uses minimal token headers without provider default headers', async () => {
    const calls: RequestInit[] = [];
    const strategy = new OAuthAuthCodeFlowStrategy(
      {
        flowType: 'authorization_code' as any,
        endpoints: { deviceCodeUrl: 'https://x/device', tokenUrl: 'https://iflow.cn/oauth/token' },
        client: {
          clientId: '10009311001',
          clientSecret: 'secret',
          redirectUri: 'http://localhost:11451/oauth2callback'
        },
        headers: {
          'Origin': 'https://iflow.cn',
          'Referer': 'https://iflow.cn/oauth',
          'X-Requested-With': 'XMLHttpRequest'
        },
        retry: { maxAttempts: 1, backoffMs: 1 }
      } as any,
      (async (_url: string, init?: RequestInit) => {
        calls.push(init ?? {});
        return jsonResponse(200, {
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          token_type: 'bearer',
          expires_in: 3600
        });
      }) as any,
      '/tmp/unused.json'
    );

    await strategy.refreshToken('old-refresh');
    expect(calls).toHaveLength(1);
    const headers = (calls[0].headers as Record<string, string>) ?? {};
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(typeof headers.Authorization).toBe('string');
    expect(headers.Origin).toBeUndefined();
    expect(headers.Referer).toBeUndefined();
    expect(headers['X-Requested-With']).toBeUndefined();
  });
});
