import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureValidOAuthToken } from '../../../src/providers/auth/oauth-lifecycle.js';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

describe('ensureValidOAuthToken (iflow) aligns refresh-failure handling', () => {
  test('clears token file when refresh endpoint fails in non-interactive flow', async () => {
    const prevFetch = globalThis.fetch;
    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-oauth-iflow-refresh-'));
    process.env.HOME = tmpHome;

    const tokenFile = path.join(tmpHome, '.routecodex', 'auth', 'iflow-oauth-1-default.json');
    writeJson(tokenFile, {
      access_token: 'expired-access',
      refresh_token: 'expired-refresh',
      token_type: 'bearer',
      expires_at: Date.now() - 3600_000,
      expiry_date: Date.now() - 3600_000
    });

    let tokenRefreshCalls = 0;
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      if (url.includes('https://iflow.cn/oauth/token')) {
        tokenRefreshCalls += 1;
        return new Response('server busy', { status: 500, statusText: 'Internal Server Error' });
      }
      return new Response(JSON.stringify({ error: `unexpected fetch: ${url}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }) as any;

    try {
      await ensureValidOAuthToken(
        'iflow',
        {
          type: 'iflow-oauth',
          tokenFile
        } as any,
        { openBrowser: false, forceReauthorize: false, forceReacquireIfRefreshFails: false }
      );

      const cleared = readJson(tokenFile);
      expect(cleared.access_token).toBeUndefined();
      expect(cleared.refresh_token).toBeUndefined();
      expect(tokenRefreshCalls).toBe(1);
    } finally {
      globalThis.fetch = prevFetch as typeof fetch;
      process.env.HOME = prevHome;
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
