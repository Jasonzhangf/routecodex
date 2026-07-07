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
  it('writes and consumes stop intent marker once', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-stop-intent-'));
    const port = 5520;

    writeDaemonStopIntent(port, {
      source: 'jest',
      routeCodexHomeDir: tempRoot,
      requestedAtMs: 1700000000000
    });

    const markerPath = resolveDaemonStopIntentPath(port, tempRoot);
    expect(markerPath).toContain('/state/runtime-lifecycle/ports/5520/stop-intent.json');
    for (let idx = 0; idx < 10 && !fs.existsSync(markerPath); idx += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
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

  it('can preserve a fresh stop intent as a broadcast for multiple supervisors', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-stop-intent-'));
    const port = 5522;

    writeDaemonStopIntent(port, {
      source: 'broadcast',
      routeCodexHomeDir: tempRoot,
      requestedAtMs: 1700000000000,
      pid: 111
    });

    const markerPath = resolveDaemonStopIntentPath(port, tempRoot);
    const ignored = consumeDaemonStopIntent(port, {
      routeCodexHomeDir: tempRoot,
      nowMs: 1700000000001,
      maxAgeMs: 60_000,
      ignorePid: 111,
      preserveMatched: true
    });
    expect(ignored.matched).toBe(false);
    expect(fs.existsSync(markerPath)).toBe(true);

    const firstSupervisor = consumeDaemonStopIntent(port, {
      routeCodexHomeDir: tempRoot,
      nowMs: 1700000000002,
      maxAgeMs: 60_000,
      ignorePid: 222,
      preserveMatched: true
    });
    expect(firstSupervisor.matched).toBe(true);
    expect(firstSupervisor.source).toBe('broadcast');
    expect(firstSupervisor.pid).toBe(111);
    expect(fs.existsSync(markerPath)).toBe(true);

    const secondSupervisor = consumeDaemonStopIntent(port, {
      routeCodexHomeDir: tempRoot,
      nowMs: 1700000000003,
      maxAgeMs: 60_000,
      ignorePid: 333,
      preserveMatched: true
    });
    expect(secondSupervisor.matched).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(true);

    const cleanup = consumeDaemonStopIntent(port, {
      routeCodexHomeDir: tempRoot,
      nowMs: 1700000000004,
      maxAgeMs: 60_000
    });
    expect(cleanup.matched).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});
