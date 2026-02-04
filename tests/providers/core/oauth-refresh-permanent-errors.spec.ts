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
});
