import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { OAuthAuthProvider } from '../../../src/providers/auth/oauth-auth.js';

describe('OAuthAuthProvider token file bootstrap', () => {
  test('creates configured token file when missing', async () => {
    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-oauth-auth-'));
    process.env.HOME = tmpHome;

    const configured = '~/.routecodex/auth/example-oauth.json';
    const resolved = path.join(tmpHome, '.routecodex', 'auth', 'example-oauth.json');

    const provider = new OAuthAuthProvider(
      {
        type: 'oauth',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tokenUrl: 'https://example.com/oauth/token',
        tokenFile: configured
      } as any,
      'example'
    );

    await provider.initialize();

    expect(fs.existsSync(resolved)).toBe(true);
    expect(fs.readFileSync(resolved, 'utf8').trim()).toBe('{}');
    expect(provider.getStatus().isValid).toBe(false);

    process.env.HOME = prevHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
});
