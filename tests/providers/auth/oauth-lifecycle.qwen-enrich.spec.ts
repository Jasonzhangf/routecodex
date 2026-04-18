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
  test('forceRefresh refreshes qwen token even when local expiry is still valid', async () => {
    const prevFetch = globalThis.fetch;
    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-oauth-qwen-'));
    process.env.HOME = tmpHome;

    const tokenFile = path.join(tmpHome, '.routecodex', 'auth', 'qwen-oauth-1-default.json');
    writeJson(tokenFile, {
      status: 'success',
      access_token: 'access-old',
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
      if (url === 'https://chat.qwen.ai/api/v1/oauth2/token') {
        return new Response(
          JSON.stringify({
            access_token: 'access-new',
            refresh_token: 'refresh-new',
            token_type: 'Bearer',
            expires_in: 21600,
            resource_url: 'portal.qwen.ai'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url === 'https://portal.qwen.ai/v1/chat/completions' || url === 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions') {
        return new Response(
          JSON.stringify({ id: 'resp_1', choices: [{ message: { role: 'assistant', content: 'OK' } }] }),
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
        { openBrowser: false, forceReauthorize: false, forceReacquireIfRefreshFails: false, forceRefresh: true }
      );

      const updated = readJson(tokenFile);
      expect(updated.access_token).toBe('access-new');
      expect(updated.refresh_token).toBe('refresh-new');
      expect(updated.resource_url).toBeUndefined();
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

  test('forceRefresh rejects qwen refreshed token when business validation fails', async () => {
    const prevFetch = globalThis.fetch;
    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-oauth-qwen-invalid-'));
    process.env.HOME = tmpHome;

    const tokenFile = path.join(tmpHome, '.routecodex', 'auth', 'qwen-oauth-1-default.json');
    writeJson(tokenFile, {
      status: 'success',
      access_token: 'access-old',
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
          JSON.stringify({ error: 'userinfo temporarily unavailable' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url === 'https://chat.qwen.ai/api/v1/oauth2/token') {
        return new Response(
          JSON.stringify({
            access_token: 'access-invalid-new',
            refresh_token: 'refresh-new',
            token_type: 'Bearer',
            expires_in: 21600,
            resource_url: 'portal.qwen.ai'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url === 'https://portal.qwen.ai/v1/chat/completions' || url === 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions') {
        return new Response(
          JSON.stringify({ error: { message: 'invalid access token or token expired' } }),
          { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ error: `unexpected fetch: ${url}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }) as any;

    try {
      await expect(
        ensureValidOAuthToken(
          'qwen',
          {
            type: 'qwen-oauth',
            tokenFile
          } as any,
          { openBrowser: false, forceReauthorize: false, forceReacquireIfRefreshFails: false, forceRefresh: true }
        )
      ).rejects.toThrow('Qwen token validation failed after refresh/acquire');

      const updated = readJson(tokenFile);
      expect(updated.access_token).toBe('access-old');
      expect(updated.refresh_token).toBe('refresh-test');
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

  test('does not synthesize api_key when userInfo returns 404', async () => {
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
      expect(updated.api_key || updated.apiKey).toBeUndefined();
      expect(updated.access_token).toBe('access-test');
      expect(updated.norefresh || updated.noRefresh).toBeUndefined();
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

  test('qwen strict validation defaults to dashscope runtime when auth response omits resource_url', async () => {
    const prevFetch = globalThis.fetch;
    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-oauth-qwen-default-runtime-'));
    process.env.HOME = tmpHome;

    const tokenFile = path.join(tmpHome, '.routecodex', 'auth', 'qwen-oauth-1-default.json');
    writeJson(tokenFile, {
      status: 'success',
      access_token: 'access-old',
      refresh_token: 'refresh-test',
      token_type: 'bearer',
      expires_in: 21600,
      expires_at: Date.now() - 10_000,
      resource_url: 'portal.qwen.ai',
      norefresh: true,
      noRefresh: true,
      api_key: 'stale-api-key',
      apiKey: 'stale-api-key'
    });

    const seenUrls: string[] = [];
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      seenUrls.push(url);
      if (url === 'https://chat.qwen.ai/api/v1/oauth2/token') {
        return new Response(
          JSON.stringify({
            access_token: 'access-new',
            refresh_token: 'refresh-new',
            token_type: 'Bearer',
            expires_in: 21600
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url === 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions') {
        return new Response(
          JSON.stringify({ id: 'resp_1', choices: [{ message: { role: 'assistant', content: 'OK' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.startsWith('https://chat.qwen.ai/api/v1/user/info')) {
        return new Response(
          JSON.stringify({ data: { email: 'jason@example.com' } }),
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
        { openBrowser: false, forceReauthorize: false, forceReacquireIfRefreshFails: false, forceRefresh: true }
      );

      expect(seenUrls).toContain('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
      const updated = readJson(tokenFile);
      expect(updated.access_token).toBe('access-new');
      expect(updated.refresh_token).toBe('refresh-new');
      expect(updated.resource_url).toBeUndefined();
      expect(updated.norefresh).toBeUndefined();
      expect(updated.noRefresh).toBeUndefined();
      expect(updated.api_key || updated.apiKey).toBeUndefined();
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

  test('fills qwen status/type/alias from token file when existing file is sparse', async () => {
    const prevFetch = globalThis.fetch;
    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-oauth-qwen-'));
    process.env.HOME = tmpHome;

    const tokenFile = path.join(tmpHome, '.routecodex', 'auth', 'qwen-oauth-6-xfour8605.json');
    writeJson(tokenFile, {
      expires_in: 21600,
      access_token: 'access-test',
      refresh_token: 'refresh-test',
      token_type: 'bearer',
      expires_at: Date.now() + 60 * 60 * 1000
    });

    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      if (url.startsWith('https://chat.qwen.ai/api/v1/user/info')) {
        return new Response(
          JSON.stringify({ data: { apiKey: 'sk-qwen-test', email: 'xfour8605@gmail.com' } }),
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
      expect(updated.status).toBe('success');
      expect(updated.type).toBe('qwen');
      expect(updated.alias).toBe('xfour8605');
      expect(updated.access_token).toBe('access-test');
      expect(updated.api_key || updated.apiKey).toBe('sk-qwen-test');
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
