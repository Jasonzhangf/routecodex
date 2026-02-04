import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ensureValidOAuthToken } from '../../../src/providers/auth/oauth-lifecycle.js';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

describe('ensureValidOAuthToken (qwen) enriches api_key', () => {
  test('adds api_key when token has only access_token', async () => {
    const prevFetch = globalThis.fetch;
    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-oauth-qwen-'));
    process.env.HOME = tmpHome;

    const tokenFile = path.join(tmpHome, '.routecodex', 'auth', 'qwen-oauth-1-default.json');
    writeJson(tokenFile, {
      status: 'success',
      access_token: 'access-test',
      refresh_token: 'refresh-test',
      token_type: 'bearer',
      expires_in: 21600,
      scope: 'openid profile email model.completion',
      resource_url: 'portal.qwen.ai',
      // keep it valid so ensureValidOAuthToken must enrich without forcing refresh
      expires_at: Date.now() + 60 * 60 * 1000
    });

    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      if (url.startsWith('https://chat.qwen.ai/api/v1/user/info')) {
        return new Response(
          JSON.stringify({
            data: {
              apiKey: 'sk-qwen-test',
              email: 'qwen@example.com'
            }
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
      await ensureValidOAuthToken(
        'qwen',
        {
          type: 'qwen-oauth',
          tokenFile
        } as any,
        { openBrowser: false, forceReauthorize: false, forceReacquireIfRefreshFails: true }
      );

      const updated = readJson(tokenFile);
      expect(updated.api_key || updated.apiKey).toBe('sk-qwen-test');
      expect(updated.norefresh || updated.noRefresh).toBe(true);
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

  test('falls back to access_token as api_key when userInfo returns 404', async () => {
    const prevFetch = globalThis.fetch;
    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-oauth-qwen-'));
    process.env.HOME = tmpHome;

    const tokenFile = path.join(tmpHome, '.routecodex', 'auth', 'qwen-oauth-1-default.json');
    writeJson(tokenFile, {
      status: 'success',
      access_token: 'access-test',
      refresh_token: 'refresh-test',
      token_type: 'bearer',
      expires_in: 21600,
      scope: 'openid profile email model.completion',
      resource_url: 'portal.qwen.ai',
      // keep it valid so ensureValidOAuthToken must enrich without forcing refresh
      expires_at: Date.now() + 60 * 60 * 1000
    });

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
      await ensureValidOAuthToken(
        'qwen',
        {
          type: 'qwen-oauth',
          tokenFile
        } as any,
        { openBrowser: false, forceReauthorize: false, forceReacquireIfRefreshFails: true }
      );

      const updated = readJson(tokenFile);
      expect(updated.api_key || updated.apiKey).toBe('access-test');
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

  test('treats api_key==access_token as non-stable and re-enriches when userInfo is available', async () => {
    const prevFetch = globalThis.fetch;
    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-oauth-qwen-'));
    process.env.HOME = tmpHome;

    const tokenFile = path.join(tmpHome, '.routecodex', 'auth', 'qwen-oauth-1-default.json');
    writeJson(tokenFile, {
      status: 'success',
      access_token: 'access-test',
      api_key: 'access-test',
      refresh_token: 'refresh-test',
      token_type: 'bearer',
      expires_in: 21600,
      scope: 'openid profile email model.completion',
      resource_url: 'portal.qwen.ai',
      expires_at: Date.now() + 60 * 60 * 1000
    });

    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      if (url.startsWith('https://chat.qwen.ai/api/v1/user/info')) {
        return new Response(
          JSON.stringify({ data: { apiKey: 'sk-qwen-test' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ error: `unexpected fetch: ${url}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }) as any;

    try {
      await ensureValidOAuthToken(
        'qwen',
        {
          type: 'qwen-oauth',
          tokenFile
        } as any,
        { openBrowser: false, forceReauthorize: false, forceReacquireIfRefreshFails: true }
      );

      const updated = readJson(tokenFile);
      expect(updated.api_key || updated.apiKey).toBe('sk-qwen-test');
      expect(updated.norefresh || updated.noRefresh).toBe(true);
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
