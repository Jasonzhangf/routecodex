import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  planAuthFileResolutionWithNative,
  resolveAuthFileKeyWithNative,
} from '../sharedmodule/helpers/config-direct-native.js';
import { AuthFileResolver } from '../../src/config/auth-file-resolver.js';

async function mkTmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function legacyPlan(keyId: string, authDir: string): {
  kind: 'literal' | 'authFile';
  value?: string;
  filePath?: string;
  cacheKey?: string;
} {
  if (!keyId.startsWith('authfile-')) {
    return { kind: 'literal', value: keyId };
  }
  const filename = keyId.replace('authfile-', '');
  return {
    kind: 'authFile',
    filePath: path.join(authDir, filename),
    cacheKey: keyId,
  };
}

async function legacyResolve(keyId: string, authDir: string): Promise<{
  kind: 'literal' | 'authFile';
  value: string;
  cacheKey?: string;
}> {
  const plan = legacyPlan(keyId, authDir);
  if (plan.kind === 'literal') {
    return { kind: 'literal', value: plan.value ?? keyId };
  }
  const raw = await fs.readFile(plan.filePath!, 'utf8');
  return {
    kind: 'authFile',
    value: raw.trim(),
    cacheKey: plan.cacheKey,
  };
}

describe('auth-file resolver rust parity', () => {
  it('matches pre-wire literal key plan semantics', async () => {
    const root = await mkTmp('routecodex-auth-literal-');
    const authDir = path.join(root, 'auth');
    const keyId = ' authfile-demo ';

    expect(planAuthFileResolutionWithNative({ keyId, authDir })).toEqual(legacyPlan(keyId, authDir));
  });

  it('matches pre-wire authfile path plan semantics', async () => {
    const root = await mkTmp('routecodex-auth-path-');
    const authDir = path.join(root, 'auth');
    const keyId = 'authfile-demo-default';

    expect(planAuthFileResolutionWithNative({ keyId, authDir })).toEqual(legacyPlan(keyId, authDir));
  });

  it('matches pre-wire empty authfile suffix path semantics', async () => {
    const root = await mkTmp('routecodex-auth-empty-');
    const authDir = path.join(root, 'auth');
    const keyId = 'authfile-';

    expect(planAuthFileResolutionWithNative({ keyId, authDir })).toEqual(legacyPlan(keyId, authDir));
  });

  it('resolves authfile content through the native plan and keeps TS as IO/cache shell', async () => {
    const root = await mkTmp('routecodex-auth-read-');
    const authDir = path.join(root, 'auth');
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(path.join(authDir, 'demo'), '  sk-demo-value  \n', 'utf8');

    const resolver = new AuthFileResolver(authDir);
    await expect(resolver.resolveKey('authfile-demo')).resolves.toBe('sk-demo-value');
  });

  it('matches pre-wire authfile read and trim semantics', async () => {
    const root = await mkTmp('routecodex-auth-native-read-');
    const authDir = path.join(root, 'auth');
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(path.join(authDir, 'demo'), '  sk-native-value  \n', 'utf8');

    expect(resolveAuthFileKeyWithNative({ keyId: 'authfile-demo', authDir })).toEqual(
      await legacyResolve('authfile-demo', authDir)
    );
  });

  it('matches pre-wire literal key read semantics', async () => {
    const root = await mkTmp('routecodex-auth-native-literal-');
    const authDir = path.join(root, 'auth');
    expect(resolveAuthFileKeyWithNative({ keyId: 'literal-key', authDir })).toEqual(
      await legacyResolve('literal-key', authDir)
    );
  });

  it('caches authfile content by native cache key after the first read', async () => {
    const root = await mkTmp('routecodex-auth-cache-');
    const authDir = path.join(root, 'auth');
    const secretPath = path.join(authDir, 'demo');
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(secretPath, 'first\n', 'utf8');

    const resolver = new AuthFileResolver(authDir);
    await expect(resolver.resolveKey('authfile-demo')).resolves.toBe('first');
    await fs.writeFile(secretPath, 'second\n', 'utf8');
    await expect(resolver.resolveKey('authfile-demo')).resolves.toBe('first');
  });
});
