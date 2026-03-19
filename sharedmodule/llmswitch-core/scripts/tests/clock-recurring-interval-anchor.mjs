#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llms-clock-interval-anchor-'));
  const sessionDir = path.join(tmpRoot, 'sessions', 'server_test');
  process.env.ROUTECODEX_SESSION_DIR = sessionDir;

  const clockTasks = await import(path.join(projectRoot, 'dist', 'servertool', 'clock', 'tasks.js'));
  const {
    scheduleClockTasks,
    listClockTasks,
    reserveDueTasksForRequest,
    commitClockReservation
  } = clockTasks;

  const clockConfig = { enabled: true, retentionMs: 20 * 60_000, dueWindowMs: 0, tickMs: 0 };
  const sessionId = 'tmux:interval_anchor_test';
  const now = Date.now();
  const originalDueAtMs = now - 3 * 60_000;

  const scheduled = await scheduleClockTasks(
    sessionId,
    [{
      dueAtMs: originalDueAtMs,
      task: 'interval-anchor',
      recurrence: { kind: 'interval', everyMinutes: 10, maxRuns: 3 }
    }],
    clockConfig
  );
  assert.equal(scheduled.length, 1, 'expected recurring reminder to be scheduled');

  const reserved = await reserveDueTasksForRequest({
    reservationId: 'interval-anchor:1',
    sessionId,
    config: clockConfig,
    requestId: 'req_interval_anchor'
  });
  assert.equal(Array.isArray(reserved.reservation?.taskIds), true, 'expected a due reservation');

  const committedAtMs = Date.now();
  await commitClockReservation(reserved.reservation, clockConfig);
  const afterCommit = await listClockTasks(sessionId, clockConfig);
  assert.equal(afterCommit.length, 1, 'expected recurring reminder to remain after first delivery');

  const nextDueAtMs = afterCommit[0].dueAtMs;
  const deltaMs = nextDueAtMs - committedAtMs;
  assert(deltaMs >= 9 * 60_000, `expected next interval to stay close to +10m after delivery, got ${deltaMs}ms`);
  assert(deltaMs <= 11 * 60_000, `expected next interval to stay close to +10m after delivery, got ${deltaMs}ms`);

  await fs.rm(tmpRoot, { recursive: true, force: true });
  console.log('✅ clock-recurring-interval-anchor passed');
}

main().catch((error) => {
  console.error('❌ clock-recurring-interval-anchor failed', error);
  process.exit(1);
});
