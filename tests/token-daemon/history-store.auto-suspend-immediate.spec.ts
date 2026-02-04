import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TokenHistoryStore } from '../../src/token-daemon/history-store.js';

describe('TokenHistoryStore auto-suspend (immediate)', () => {
  test('autoSuspendImmediately suspends token on first permanent failure and clears on mtime change', async () => {
    const prevHome = process.env.HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-token-history-'));
    process.env.HOME = tmpHome;

    const store = new TokenHistoryStore();
    const token = {
      provider: 'qwen',
      alias: 'default',
      filePath: path.join(tmpHome, '.routecodex', 'auth', 'qwen-oauth-1-default.json'),
      displayName: 'qwen-oauth-1-default.json'
    } as any;

    await store.recordRefreshResult(token, 'failure', {
      startedAt: 1,
      completedAt: 2,
      durationMs: 1,
      mode: 'auto',
      error: 'OAuth error: invalid_request - Invalid refresh token or client_id',
      tokenFileMtime: 100,
      countTowardsFailureStreak: true,
      autoSuspendImmediately: true
    });

    const entry = await store.getEntry(token);
    expect(entry?.autoSuspended).toBe(true);
    expect(await store.isAutoSuspended(token, 100)).toBe(true);

    // A token file change should clear auto-suspension and allow refresh again.
    expect(await store.isAutoSuspended(token, 101)).toBe(false);
    const entry2 = await store.getEntry(token);
    expect(entry2?.autoSuspended).toBe(false);

    process.env.HOME = prevHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
});

