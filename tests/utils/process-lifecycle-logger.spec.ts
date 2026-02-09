import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, test } from '@jest/globals';

import {
  flushProcessLifecycleLogQueue,
  logProcessLifecycle,
  logProcessLifecycleSync
} from '../../src/utils/process-lifecycle-logger.js';

describe('process lifecycle logger', () => {
  test('writes async and sync lifecycle events to jsonl', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routecodex-lifecycle-'));
    const logPath = path.join(tempDir, 'process-lifecycle.jsonl');
    const prevPath = process.env.ROUTECODEX_PROCESS_LIFECYCLE_LOG;
    const prevConsole = process.env.ROUTECODEX_PROCESS_LIFECYCLE_CONSOLE;

    process.env.ROUTECODEX_PROCESS_LIFECYCLE_LOG = logPath;
    process.env.ROUTECODEX_PROCESS_LIFECYCLE_CONSOLE = '0';

    try {
      logProcessLifecycle({
        event: 'unit_async_event',
        source: 'tests.process-lifecycle',
        details: { signal: 'SIGTERM', targetPid: 12345, result: 'attempt' }
      });
      logProcessLifecycleSync({
        event: 'unit_sync_event',
        source: 'tests.process-lifecycle',
        details: { result: 'success' }
      });

      await flushProcessLifecycleLogQueue();

      const lines = fs
        .readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines.some((entry) => entry.event === 'unit_async_event')).toBe(true);
      expect(lines.some((entry) => entry.event === 'unit_sync_event')).toBe(true);

      const asyncEntry = lines.find((entry) => entry.event === 'unit_async_event');
      expect(asyncEntry?.source).toBe('tests.process-lifecycle');
      expect((asyncEntry?.details as Record<string, unknown>)?.signal).toBe('SIGTERM');
    } finally {
      if (prevPath === undefined) {
        delete process.env.ROUTECODEX_PROCESS_LIFECYCLE_LOG;
      } else {
        process.env.ROUTECODEX_PROCESS_LIFECYCLE_LOG = prevPath;
      }
      if (prevConsole === undefined) {
        delete process.env.ROUTECODEX_PROCESS_LIFECYCLE_CONSOLE;
      } else {
        process.env.ROUTECODEX_PROCESS_LIFECYCLE_CONSOLE = prevConsole;
      }
    }
  });
});
