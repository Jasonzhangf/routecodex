import { describe, expect, test, jest } from '@jest/globals';
import os from 'node:os';
import path from 'node:path';

import { OAuthDeviceFlowStrategy } from '../../../src/providers/core/strategies/oauth-device-flow.js';
import { getProviderOAuthConfig } from '../../../src/providers/core/config/provider-oauth-configs.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('OAuth device flow polling interval normalization', () => {
  test('treats polling.interval=5000 as milliseconds (not seconds*1000)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const capturedDelays: number[] = [];
    const originalSetTimeout = global.setTimeout;

    const timeoutSpy = jest
      .spyOn(global, 'setTimeout')
      .mockImplementation(((callback: TimerHandler, delay?: number, ...args: any[]) => {
        capturedDelays.push(Number(delay ?? 0));
        if (typeof callback === 'function') {
          callback(...args);
        }
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);

    let tokenPollCount = 0;
    const httpClient = async (url: string) => {
      if (url.includes('/device')) {
        return jsonResponse(200, {
          device_code: 'device-code-1',
          user_code: 'USER-CODE-1',
          verification_uri: 'https://chat.qwen.ai/authorize',
          expires_in: 600,
          interval: 5
        });
      }
      if (url.includes('/token')) {
        tokenPollCount += 1;
        if (tokenPollCount === 1) {
          return jsonResponse(400, {
            error: 'authorization_pending',
            error_description: 'pending'
          });
        }
        return jsonResponse(200, {
          access_token: 'access-token-1',
          refresh_token: 'refresh-token-1',
          token_type: 'Bearer',
          expires_in: 3600
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const tokenFile = path.join(os.tmpdir(), `routecodex-qwen-device-${Date.now()}.json`);
    const strategy = new OAuthDeviceFlowStrategy(
      {
        flowType: 'device_code' as any,
        endpoints: {
          deviceCodeUrl: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
          tokenUrl: 'https://chat.qwen.ai/api/v1/oauth2/token'
        },
        client: {
          clientId: 'qwen-code',
          scopes: ['openid']
        },
        polling: {
          interval: 5000,
          maxAttempts: 3
        },
        retry: {
          maxAttempts: 1,
          backoffMs: 1
        },
        features: {
          supportsPKCE: false
        }
      } as any,
      httpClient as any,
      tokenFile
    );

    await strategy.authenticate({ openBrowser: false, forceReauthorize: true });

    expect(capturedDelays).toContain(5000);
    expect(capturedDelays).not.toContain(5000000);
    expect(tokenPollCount).toBe(2);

    timeoutSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
    global.setTimeout = originalSetTimeout;
  });

  test('qwen oauth device/token requests align with official qwen headers', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    let tokenPollCount = 0;
    const httpClient = async (input: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers || {});
      seen.push({
        url: input,
        headers: Object.fromEntries(headers.entries())
      });
      if (input.includes('/device/code')) {
        return jsonResponse(200, {
          device_code: 'device-code-2',
          user_code: 'USER-CODE-2',
          verification_uri: 'https://chat.qwen.ai/authorize',
          verification_uri_complete: 'https://chat.qwen.ai/authorize?user_code=USER-CODE-2&client=qwen-code',
          expires_in: 600,
          interval: 1
        });
      }
      if (input.includes('/oauth2/token')) {
        tokenPollCount += 1;
        if (tokenPollCount === 1) {
          return jsonResponse(400, {
            error: 'authorization_pending',
            error_description: 'pending'
          });
        }
        return jsonResponse(200, {
          access_token: 'access-token-2',
          refresh_token: 'refresh-token-2',
          token_type: 'Bearer',
          expires_in: 3600,
          resource_url: 'portal.qwen.ai'
        });
      }
      throw new Error(`Unexpected URL: ${input}`);
    };

    const tokenFile = path.join(os.tmpdir(), `routecodex-qwen-device-headers-${Date.now()}.json`);
    const strategy = new OAuthDeviceFlowStrategy(
      getProviderOAuthConfig('qwen'),
      httpClient as any,
      tokenFile
    );

    await strategy.authenticate({ openBrowser: false, forceReauthorize: true });

    const deviceRequest = seen.find((entry) => entry.url.includes('/device/code'));
    const tokenRequests = seen.filter((entry) => entry.url.includes('/oauth2/token'));

    expect(deviceRequest).toBeDefined();
    expect(deviceRequest?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(deviceRequest?.headers['accept']).toBe('application/json');
    expect(typeof deviceRequest?.headers['x-request-id']).toBe('string');
    expect(deviceRequest?.headers['user-agent']).toBeUndefined();
    expect(deviceRequest?.headers['x-goog-api-client']).toBeUndefined();
    expect(deviceRequest?.headers['client-metadata']).toBeUndefined();

    expect(tokenRequests.length).toBeGreaterThan(0);
    for (const request of tokenRequests) {
      expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded');
      expect(request.headers['accept']).toBe('application/json');
      expect(request.headers['user-agent']).toBeUndefined();
      expect(request.headers['x-goog-api-client']).toBeUndefined();
      expect(request.headers['client-metadata']).toBeUndefined();
    }

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });
});
