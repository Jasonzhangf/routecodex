import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { TokenFileAuthProvider } from '../../../src/providers/auth/tokenfile-auth.js';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

describe('TokenFileAuthProvider (qwen) resolves tokenFile alias and auth dir fallbacks', () => {
  test('tokenFile="default" prefers pinned qwen-oauth-1-default.json when multiple exist', async () => {
    const prevHome = process.env.HOME;
    const prevAuthDir = process.env.ROUTECODEX_AUTH_DIR;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-tokenfile-qwen-'));
    process.env.HOME = tmpHome;
    delete process.env.ROUTECODEX_AUTH_DIR;

    // both exist, but "default" should prefer the pinned seq=1 file
    const token1 = path.join(tmpHome, '.routecodex', 'auth', 'qwen-oauth-1-default.json');
    const token2 = path.join(tmpHome, '.routecodex', 'auth', 'qwen-oauth-2-default.json');
    writeJson(token1, { access_token: 'access-1', expires_at: Date.now() + 60 * 60 * 1000 });
    writeJson(token2, { access_token: 'access-2', expires_at: Date.now() + 60 * 60 * 1000 });

    const provider = new TokenFileAuthProvider({ type: 'qwen-oauth', tokenFile: 'default', oauthProviderId: 'qwen' } as any);
    await provider.initialize();
    expect(provider.buildHeaders()).toHaveProperty('Authorization', 'Bearer access-1');

    process.env.HOME = prevHome;
    if (prevAuthDir === undefined) {
      delete process.env.ROUTECODEX_AUTH_DIR;
    } else {
      process.env.ROUTECODEX_AUTH_DIR = prevAuthDir;
    }
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('tokenFile="default" resolves ~/.routecodex/auth/qwen-oauth-<seq>-default.json', async () => {
    const prevHome = process.env.HOME;
    const prevAuthDir = process.env.ROUTECODEX_AUTH_DIR;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-tokenfile-qwen-'));
    process.env.HOME = tmpHome;
    delete process.env.ROUTECODEX_AUTH_DIR;

    const tokenFile = path.join(tmpHome, '.routecodex', 'auth', 'qwen-oauth-2-default.json');
    writeJson(tokenFile, {
      access_token: 'access-test',
      expires_at: Date.now() + 60 * 60 * 1000
    });

    const provider = new TokenFileAuthProvider({ type: 'qwen-oauth', tokenFile: 'default', oauthProviderId: 'qwen' } as any);
    await provider.initialize();
    expect(provider.getStatus().isValid).toBe(true);
    expect(provider.buildHeaders()).toHaveProperty('Authorization', 'Bearer access-test');

    process.env.HOME = prevHome;
    if (prevAuthDir === undefined) {
      delete process.env.ROUTECODEX_AUTH_DIR;
    } else {
      process.env.ROUTECODEX_AUTH_DIR = prevAuthDir;
    }
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('can pick up token file created after initialize()', async () => {
    const prevHome = process.env.HOME;
    const prevAuthDir = process.env.ROUTECODEX_AUTH_DIR;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-tokenfile-qwen-'));
    process.env.HOME = tmpHome;
    delete process.env.ROUTECODEX_AUTH_DIR;

    const provider = new TokenFileAuthProvider({ type: 'qwen-oauth', tokenFile: 'default', oauthProviderId: 'qwen' } as any);
    await provider.initialize();
    expect(provider.getStatus().isValid).toBe(false);

    const tokenFile = path.join(tmpHome, '.routecodex', 'auth', 'qwen-oauth-1-default.json');
    writeJson(tokenFile, {
      access_token: 'access-late',
      expires_at: Date.now() + 60 * 60 * 1000
    });

    expect(provider.buildHeaders()).toHaveProperty('Authorization', 'Bearer access-late');
    expect(provider.getStatus().isValid).toBe(true);

    process.env.HOME = prevHome;
    if (prevAuthDir === undefined) {
      delete process.env.ROUTECODEX_AUTH_DIR;
    } else {
      process.env.ROUTECODEX_AUTH_DIR = prevAuthDir;
    }
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('explicit legacy tokenFile qwen-oauth.json falls back to latest qwen-oauth-*.json when missing', async () => {
    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-tokenfile-qwen-'));
    process.env.HOME = tmpHome;

    // Do NOT create qwen-oauth.json
    const tokenFile = path.join(tmpHome, '.routecodex', 'auth', 'qwen-oauth-1-default.json');
    writeJson(tokenFile, {
      access_token: 'access-fallback',
      expires_at: Date.now() + 60 * 60 * 1000
    });

    const provider = new TokenFileAuthProvider({
      type: 'qwen-oauth',
      tokenFile: '~/.routecodex/auth/qwen-oauth.json',
      oauthProviderId: 'qwen'
    } as any);
    await provider.initialize();
    expect(provider.getStatus().isValid).toBe(true);
    expect(provider.buildHeaders()).toHaveProperty('Authorization', 'Bearer access-fallback');

    process.env.HOME = prevHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
});
