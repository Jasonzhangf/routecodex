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

describe('ensureValidOAuthToken (iflow) token source fallback', () => {
  test('adopts fresh token from IFLOW_OAUTH_TOKEN_FILE when alias token is expired', async () => {
    const prevFetch = globalThis.fetch;
    const prevHome = process.env.HOME;
    const prevIflowTokenFile = process.env.IFLOW_OAUTH_TOKEN_FILE;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-oauth-iflow-'));

    process.env.HOME = tmpHome;
    const externalTokenFile = path.join(tmpHome, 'external', 'iflow-creds.json');
    process.env.IFLOW_OAUTH_TOKEN_FILE = externalTokenFile;

    const routeTokenFile = path.join(tmpHome, '.routecodex', 'auth', 'iflow-oauth-3-138.json');
    writeJson(routeTokenFile, {
      access_token: 'expired-access',
      refresh_token: 'expired-refresh',
      apiKey: 'expired-api-key',
      expires_at: Date.now() - 3600_000,
      expired: new Date(Date.now() - 3600_000).toISOString(),
      token_type: 'Bearer',
      type: 'iflow-oauth'
    });

    writeJson(externalTokenFile, {
      access_token: 'fresh-access-token',
      refresh_token: 'fresh-refresh-token',
      apiKey: 'fresh-api-key',
      expires_at: Date.now() + 2 * 3600_000,
      token_type: 'Bearer',
      expiry_date: Date.now() + 2 * 3600_000
    });

    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('unexpected network call');
    }) as unknown as typeof fetch;

    try {
      await ensureValidOAuthToken(
        'iflow',
        {
          type: 'iflow-oauth',
          tokenFile: routeTokenFile
        } as any,
        { openBrowser: false, forceReauthorize: false, forceReacquireIfRefreshFails: true }
      );

      const updated = readJson(routeTokenFile);
      expect(updated.access_token).toBe('fresh-access-token');
      expect(updated.refresh_token).toBe('fresh-refresh-token');
      expect(updated.apiKey || updated.api_key).toBe('fresh-api-key');
      expect(updated.expires_at || updated.expiry_date).toBeDefined();
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = prevFetch as typeof fetch;
      process.env.HOME = prevHome;
      process.env.IFLOW_OAUTH_TOKEN_FILE = prevIflowTokenFile;
      try {
        fs.rmSync(tmpHome, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });
});
