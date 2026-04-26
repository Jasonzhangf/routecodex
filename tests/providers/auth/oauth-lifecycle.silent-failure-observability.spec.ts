import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

describe('oauth-lifecycle silent failure observability', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.ROUTECODEX_OAUTH_DEBUG;
  });

  it('logs qwen 404 fallback cause before reusing access_token as api_key', async () => {
    jest.resetModules();
    process.env.ROUTECODEX_OAUTH_DEBUG = '1';

    const prevFetch = globalThis.fetch;
    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-oauth-qwen-obsv-'));
    process.env.HOME = tmpHome;

    const tokenFile = path.join(tmpHome, '.rcc', 'auth', 'qwen-oauth-1-default.json');
    writeJson(tokenFile, {
      status: 'success',
      access_token: 'access-test',
      refresh_token: 'refresh-test',
      token_type: 'bearer',
      expires_in: 21600,
      scope: 'openid profile email model.completion',
      resource_url: 'portal.qwen.ai',
      expires_at: Date.now() + 60 * 60 * 1000
    });

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      if (
        url.startsWith('https://chat.qwen.ai/api/v1/user/info') ||
        url.startsWith('https://portal.qwen.ai/api/v1/user/info')
      ) {
        return new Response('', { status: 404, statusText: 'Not Found' });
      }
      return new Response(JSON.stringify({ error: `unexpected fetch: ${url}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }) as any;

    try {
      const { ensureValidOAuthToken } = await import('../../../src/providers/auth/oauth-lifecycle.js');

      await ensureValidOAuthToken(
        'qwen',
        { type: 'qwen-oauth', tokenFile } as any,
        { openBrowser: false, forceReauthorize: false, forceReacquireIfRefreshFails: true }
      );

      const updated = readJson(tokenFile);
      expect(updated.api_key || updated.apiKey).toBe('access-test');
      expect(
        logSpy.mock.calls.some(([message]) =>
          String(message).includes('maybeEnrichToken.qwenUserInfo404Fallback failed (non-blocking)')
        )
      ).toBe(true);
    } finally {
      globalThis.fetch = prevFetch as any;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('logs parse failures but still infers glm client creds from earlier valid line', async () => {
    jest.resetModules();
    process.env.ROUTECODEX_OAUTH_DEBUG = '1';

    const prevHome = process.env.HOME;
    const prevRccHome = process.env.RCC_HOME;
    const prevRouteUserDir = process.env.ROUTECODEX_USER_DIR;
    const prevRouteHome = process.env.ROUTECODEX_HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-oauth-glm-obsv-'));
    process.env.HOME = tmpHome;
    process.env.RCC_HOME = path.join(tmpHome, '.rcc');
    process.env.ROUTECODEX_USER_DIR = path.join(tmpHome, '.rcc');
    process.env.ROUTECODEX_HOME = path.join(tmpHome, '.rcc');
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const logFile = path.join(tmpHome, '.rcc', 'auth', 'glm-oauth.log');
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(
        logFile,
        [
          JSON.stringify({ decoded: 'client-id:client-secret' }),
          '{"decoded"',
          ''
        ].join('\n'),
        'utf8'
      );

      const { __oauthLifecycleTestables } = await import('../../../src/providers/auth/oauth-lifecycle.js');
      const creds = await __oauthLifecycleTestables.inferGlmClientCredsFromLog();

      expect(creds).toEqual({ clientId: 'client-id', clientSecret: 'client-secret' });
      expect(
        logSpy.mock.calls.some(([message]) =>
          String(message).includes('inferGlmClientCredsFromLog.parseLine failed (non-blocking)')
        )
      ).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevRccHome === undefined) delete process.env.RCC_HOME;
      else process.env.RCC_HOME = prevRccHome;
      if (prevRouteUserDir === undefined) delete process.env.ROUTECODEX_USER_DIR;
      else process.env.ROUTECODEX_USER_DIR = prevRouteUserDir;
      if (prevRouteHome === undefined) delete process.env.ROUTECODEX_HOME;
      else process.env.ROUTECODEX_HOME = prevRouteHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('throttles isProcessAlive probe failures instead of silently collapsing forever', async () => {
    jest.resetModules();
    process.env.ROUTECODEX_OAUTH_DEBUG = '1';

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const killSpy = jest.spyOn(process, 'kill').mockImplementation((() => {
      throw new Error('EPERM');
    }) as any);

    try {
      const { __oauthLifecycleTestables } = await import('../../../src/providers/auth/oauth-lifecycle.js');

      expect(__oauthLifecycleTestables.isProcessAlive(43210)).toBe(false);
      expect(__oauthLifecycleTestables.isProcessAlive(43210)).toBe(false);

      const matchedLogs = logSpy.mock.calls.filter(([message]) =>
        String(message).includes('isProcessAlive failed (non-blocking)')
      );
      expect(matchedLogs).toHaveLength(1);
      expect(killSpy).toHaveBeenCalledTimes(2);
    } finally {
      killSpy.mockRestore();
    }
  });
});
