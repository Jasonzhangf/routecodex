import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { TokenFileAuthProvider } from '../../../src/providers/auth/tokenfile-auth.js';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

describe('TokenFileAuthProvider (iflow CLI settings.json compatibility)', () => {
  test('reads ~/.iflow/settings.json apiKey and uses it as Authorization Bearer', async () => {
    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-tokenfile-iflow-'));
    process.env.HOME = tmpHome;

    try {
      writeJson(path.join(tmpHome, '.iflow', 'settings.json'), {
        selectedAuthType: 'oauth-iflow',
        baseUrl: 'https://apis.iflow.cn/v1',
        apiKey: 'sk-test-iflow-settings',
        modelName: 'glm-4.7'
      });

      // Ensure unrelated fallbacks exist; iflow path should still win.
      writeJson(path.join(tmpHome, '.routecodex', 'tokens', 'qwen-default.json'), {
        api_key: 'sk-should-not-be-used'
      });

      const provider = new TokenFileAuthProvider({ type: 'iflow-oauth', oauthProviderId: 'iflow' } as any);
      await provider.initialize();
      expect(provider.getStatus().isAuthenticated).toBe(true);
      const headers = provider.buildHeaders();
      expect(headers.Authorization).toBe('Bearer sk-test-iflow-settings');
    } finally {
      process.env.HOME = prevHome;
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test('falls back to ~/.iflow/oauth_creds.json when it contains api_key', async () => {
    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-tokenfile-iflow-'));
    process.env.HOME = tmpHome;

    try {
      writeJson(path.join(tmpHome, '.iflow', 'oauth_creds.json'), {
        access_token: 'access-should-not-be-used',
        api_key: 'sk-test-iflow-creds'
      });

      const provider = new TokenFileAuthProvider({ type: 'iflow-oauth', oauthProviderId: 'iflow' } as any);
      await provider.initialize();
      const headers = provider.buildHeaders();
      expect(headers.Authorization).toBe('Bearer sk-test-iflow-creds');
    } finally {
      process.env.HOME = prevHome;
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test('does not accept iflow oauth_creds.json when it has only access_token (no apiKey)', async () => {
    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-tokenfile-iflow-'));
    process.env.HOME = tmpHome;

    try {
      writeJson(path.join(tmpHome, '.iflow', 'oauth_creds.json'), {
        access_token: 'access-only'
      });

      const provider = new TokenFileAuthProvider({ type: 'iflow-oauth', oauthProviderId: 'iflow' } as any);
      await provider.initialize();
      const status = provider.getStatus();
      expect(status.isAuthenticated).toBe(false);
      expect(status.error).toBe('token_file_missing');
      expect(() => provider.buildHeaders()).toThrow('TokenFileAuthProvider not initialized');
    } finally {
      process.env.HOME = prevHome;
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
