import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cacheAntigravitySessionSignature,
  clearAntigravitySessionSignature,
  configureAntigravitySessionSignaturePersistence,
  flushAntigravitySessionSignaturePersistenceSync,
  getAntigravityLatestSignatureSessionIdForAlias,
  getAntigravitySessionSignature,
  lookupAntigravitySessionSignatureEntry,
  markAntigravitySessionSignatureRewind,
  resetAntigravitySessionSignatureCachesForTests
} from '../../sharedmodule/llmswitch-core/src/conversion/compat/antigravity-session-signature.js';

describe('antigravity thoughtSignature persistence & rewind guard', () => {
  it('retains alias->signature session binding across restarts (latestByAlias.sessionId)', () => {
    resetAntigravitySessionSignatureCachesForTests();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-antigravity-sig-'));
    const fileName = 'antigravity-session-signatures.json';
    const filePath = path.join(tmpDir, fileName);

    configureAntigravitySessionSignaturePersistence({ stateDir: tmpDir, fileName });

    const aliasKey = 'antigravity.key1';
    const signatureSessionId = 'sid-signature';
    const newSessionId = 'sid-new';
    const sig = 's'.repeat(80);

    cacheAntigravitySessionSignature(aliasKey, signatureSessionId, sig, 1);
    flushAntigravitySessionSignaturePersistenceSync();

    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(persisted.latestByAlias[aliasKey].sessionId).toBe(signatureSessionId);

    // Simulate a server restart: clear in-memory caches, then reconfigure persistence and hydrate on demand.
    resetAntigravitySessionSignatureCachesForTests();
    configureAntigravitySessionSignaturePersistence({ stateDir: tmpDir, fileName });

    expect(getAntigravitySessionSignature(aliasKey, signatureSessionId)).toBe(sig);
    expect(getAntigravityLatestSignatureSessionIdForAlias(aliasKey)).toBe(signatureSessionId);

    const lookup = lookupAntigravitySessionSignatureEntry(aliasKey, newSessionId);
    expect(lookup.source).toBe('miss');
    expect(lookup.sourceSessionId).toBeUndefined();
  });

  it('hydrates persisted signatures (per alias)', () => {
    resetAntigravitySessionSignatureCachesForTests();

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-antigravity-sig-'));
    const fileName = 'antigravity-session-signatures.json';
    const filePath = path.join(tmpDir, fileName);
    const ts = Date.now();
    const sig = 's'.repeat(80);

    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          version: 2,
          updatedAt: ts,
          sessions: {
            'antigravity.key1|sid-abc': { signature: sig, messageCount: 1, timestamp: ts }
          },
          latestByAlias: {
            'antigravity.key1': { signature: sig, messageCount: 1, timestamp: ts }
          }
        },
        null,
        2
      ),
      'utf8'
    );

    configureAntigravitySessionSignaturePersistence({ stateDir: tmpDir, fileName });

    expect(getAntigravitySessionSignature('antigravity.key1', 'sid-abc')).toBe(sig);
    expect(getAntigravitySessionSignature('antigravity.key2', 'sid-abc')).toBeUndefined();
  });

  it('suppresses latest fallback after rewind until a fresh signature is cached', () => {
    resetAntigravitySessionSignatureCachesForTests();

    const aliasKey = 'antigravity.key1';
    const sessionId = 'sid-rewind';
    const sig = 'a'.repeat(80);

    cacheAntigravitySessionSignature(aliasKey, sessionId, sig, 10);
    expect(getAntigravitySessionSignature(aliasKey, sessionId)).toBe(sig);

    // Mimic compat rewind handling: clear session signature, then block "latest" fallback.
    clearAntigravitySessionSignature(aliasKey, sessionId);
    markAntigravitySessionSignatureRewind(aliasKey, sessionId, 1);

    // Without the rewind guard, this would incorrectly fall back to per-alias latest and reuse `sig`.
    expect(getAntigravitySessionSignature(aliasKey, sessionId)).toBeUndefined();
  });

  it('does not silently expire persisted signatures over time (session continuity)', () => {
    resetAntigravitySessionSignatureCachesForTests();
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-antigravity-sig-'));
      const fileName = 'antigravity-session-signatures.json';
      const filePath = path.join(tmpDir, fileName);

      const aliasKey = 'antigravity.key1';
      const sessionId = 'sid-touch';
      const sig = 's'.repeat(80);
      const initialTs = Date.now() - 60_000;

      fs.writeFileSync(
        filePath,
        JSON.stringify(
          {
            version: 2,
            updatedAt: initialTs,
            sessions: {
              [`${aliasKey}|${sessionId}`]: { signature: sig, messageCount: 1, timestamp: initialTs }
            }
          },
          null,
          2
        ),
        'utf8'
      );

      configureAntigravitySessionSignaturePersistence({ stateDir: tmpDir, fileName });

      expect(getAntigravitySessionSignature(aliasKey, sessionId)).toBe(sig);
      flushAntigravitySessionSignaturePersistenceSync();

      const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(persisted.sessions[`${aliasKey}|${sessionId}`].timestamp).toBeGreaterThan(initialTs);

      // Advance time significantly; the signature should still be present.
      jest.setSystemTime(new Date(Date.now() + 8 * 60 * 60 * 1000));
      expect(getAntigravitySessionSignature(aliasKey, sessionId)).toBe(sig);
    } finally {
      jest.useRealTimers();
    }
  });
});
