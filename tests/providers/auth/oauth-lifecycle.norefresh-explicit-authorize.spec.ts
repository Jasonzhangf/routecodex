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

describe('ensureValidOAuthToken respects noRefresh only for background flows', () => {
  test('norefresh blocks auto refresh, but forceReauthorize can still reacquire', async () => {
    const prevFetch = globalThis.fetch;
    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-oauth-norefresh-'));
    process.env.HOME = tmpHome;

    const tokenFile = path.join(tmpHome, '.routecodex', 'auth', 'qwen-oauth-1-default.json');
    writeJson(tokenFile, {
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      token_type: 'bearer',
      expires_at: Date.now() - 10_000,
      norefresh: true
    });

    let deviceIssued = false;
    let tokenIssued = false;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      if (url.includes('/oauth2/device/code')) {
        deviceIssued = true;
        return new Response(
          JSON.stringify({
            device_code: 'dev-1',
            user_code: 'UCODE',
            verification_uri: 'https://chat.qwen.ai/authorize',
            verification_uri_complete: 'https://chat.qwen.ai/authorize?user_code=UCODE',
            expires_in: 600,
            interval: 1
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/oauth2/token')) {
        tokenIssued = true;
        return new Response(
          JSON.stringify({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            token_type: 'Bearer',
            expires_in: 21600,
            scope: 'openid profile email model.completion',
            resource_url: 'portal.qwen.ai'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ error: `unexpected fetch: ${url}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }) as any;

    try {
      // Without force, norefresh should cause a no-op.
      await ensureValidOAuthToken(
        'qwen',
        { type: 'qwen-oauth', tokenFile: 'default' } as any,
        { openBrowser: false, forceReauthorize: false, forceReacquireIfRefreshFails: true }
      );
      const unchanged = readJson(tokenFile);
      expect(unchanged.access_token).toBe('old-access');
      expect(deviceIssued).toBe(false);
      expect(tokenIssued).toBe(false);

      // With forceReauthorize, we must be able to reacquire even if norefresh is present.
      await ensureValidOAuthToken(
        'qwen',
        { type: 'qwen-oauth', tokenFile: 'default' } as any,
        { openBrowser: false, forceReauthorize: true, forceReacquireIfRefreshFails: true }
      );

      const updated = readJson(tokenFile);
      expect(updated.access_token).toBe('new-access');
      expect(deviceIssued).toBe(true);
      expect(tokenIssued).toBe(true);
    } finally {
      globalThis.fetch = prevFetch as any;
      process.env.HOME = prevHome;
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});

