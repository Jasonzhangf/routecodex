import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import {
  consumeDaemonStopIntent,
  resolveDaemonStopIntentPath,
  writeDaemonStopIntent
} from '../../src/utils/daemon-stop-intent.js';

describe('daemon stop intent', () => {
  it('writes and consumes stop intent marker once', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-stop-intent-'));
    const port = 5520;

    writeDaemonStopIntent(port, {
      source: 'jest',
      routeCodexHomeDir: tempRoot,
      requestedAtMs: 1700000000000
    });

    const markerPath = resolveDaemonStopIntentPath(port, tempRoot);
    expect(fs.existsSync(markerPath)).toBe(true);

    const consumed = consumeDaemonStopIntent(port, {
      routeCodexHomeDir: tempRoot,
      nowMs: 1700000000001,
      maxAgeMs: 60_000
    });
    expect(consumed.matched).toBe(true);
    expect(consumed.source).toBe('jest');
    expect(fs.existsSync(markerPath)).toBe(false);

    const secondConsume = consumeDaemonStopIntent(port, {
      routeCodexHomeDir: tempRoot,
      nowMs: 1700000000002,
      maxAgeMs: 60_000
    });
    expect(secondConsume.matched).toBe(false);
  });

  it('ignores stale stop intent marker', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-stop-intent-'));
    const port = 5521;

    writeDaemonStopIntent(port, {
      source: 'stale',
      routeCodexHomeDir: tempRoot,
      requestedAtMs: 1700000000000
    });

    const consumed = consumeDaemonStopIntent(port, {
      routeCodexHomeDir: tempRoot,
      nowMs: 1700000100000,
      maxAgeMs: 10_000
    });
    expect(consumed.matched).toBe(false);
  });
});
