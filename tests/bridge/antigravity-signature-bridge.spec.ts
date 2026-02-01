import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  cacheAntigravitySessionSignature,
  configureAntigravitySessionSignaturePersistence,
  flushAntigravitySessionSignaturePersistenceSync,
  warmupAntigravitySessionSignatureModule
} from '../../src/modules/llmswitch/bridge.js';

type CoreSignatureModule = {
  resetAntigravitySessionSignatureCachesForTests?: () => void;
  getAntigravitySessionSignatureEntry?: (
    aliasKey: string,
    sessionId: string,
    options?: { hydrate?: boolean }
  ) => { signature: string; messageCount: number } | undefined;
};

describe('llmswitch-bridge antigravity-session-signature wiring', () => {
  it('caches signatures with aliasKey+sessionId (npm dist arity)', async () => {
    const corePath = path.join(
      process.cwd(),
      'node_modules',
      '@jsonstudio',
      'llms',
      'dist',
      'conversion',
      'compat',
      'antigravity-session-signature.js'
    );
    const core = (await import(pathToFileURL(corePath).href)) as CoreSignatureModule;
    core.resetAntigravitySessionSignatureCachesForTests?.();

    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-antigravity-sig-'));
    await warmupAntigravitySessionSignatureModule();
    configureAntigravitySessionSignaturePersistence({ stateDir, fileName: 'antigravity-session-signatures.json' });

    const aliasKey = 'antigravity.aliasA';
    const sessionId = 'sid-bridge-test-001';
    const sig = 'EiYKJGUyNDgzMGE3LTVjZDYtNDJmZS05OThiLWVlNTM5ZTcyYjljMw=='; // >= 50 chars

    cacheAntigravitySessionSignature(aliasKey, sessionId, sig, 10);

    const cached = core.getAntigravitySessionSignatureEntry?.(aliasKey, sessionId);
    expect(cached?.signature).toBe(sig);
    expect(cached?.messageCount).toBe(10);

    flushAntigravitySessionSignaturePersistenceSync();
    const persistedPath = path.join(stateDir, 'antigravity-session-signatures.json');
    expect(fs.existsSync(persistedPath)).toBe(true);
  });
});
