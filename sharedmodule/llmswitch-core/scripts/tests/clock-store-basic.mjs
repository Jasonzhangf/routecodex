#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'assertion failed');
  }
}

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llmswitch-clock-'));
  const sessionDir = path.join(tmpRoot, 'sessions', 'server_test');
  process.env.ROUTECODEX_SESSION_DIR = sessionDir;

  const mod = await import(path.join(projectRoot, 'dist', 'servertool', 'clock', 'task-store.js'));
  const {
    scheduleClockTasks,
    listClockTasks,
    reserveDueTasksForRequest,
    commitClockReservation,
    clearClockSession,
    stopClockDaemonForTests
  } = mod;

  const clockConfig = { enabled: true, retentionMs: 20 * 60_000, dueWindowMs: 60_000, tickMs: 0 };
  const sessionId = 'sess_test_1';

  // 1) schedule two tasks
  const now = Date.now();
  const scheduled = await scheduleClockTasks(
    sessionId,
    [
      { dueAtMs: now + 30_000, task: 'task A', tool: 'exec_command', arguments: { cmd: 'ls' } },
      { dueAtMs: now + 90_000, task: 'task B' }
    ],
    clockConfig
  );
  assert(Array.isArray(scheduled) && scheduled.length === 2, 'expected scheduleClockTasks to return 2 tasks');

  // 2) list should show 2 tasks
  const listed = await listClockTasks(sessionId, clockConfig);
  assert(listed.length === 2, `expected listClockTasks=2, got ${listed.length}`);

  // 3) reserve should include task A (dueWindow=60s; dueAt=+30s => due immediately)
  const reserved = await reserveDueTasksForRequest({
    reservationId: 'req_test:clock',
    sessionId,
    config: clockConfig
  });
  assert(reserved.reservation && reserved.reservation.taskIds.length >= 1, 'expected reservation to include at least 1 task');
  assert(typeof reserved.injectText === 'string' && reserved.injectText.includes('scheduled task'), 'expected injectText');

  // 4) commit marks tasks delivered
  await commitClockReservation(reserved.reservation, clockConfig);
  const afterCommit = await listClockTasks(sessionId, clockConfig);
  const deliveredCount = afterCommit.filter((t) => typeof t.deliveredAtMs === 'number' && t.deliveredAtMs > 0).length;
  assert(deliveredCount >= 1, 'expected at least 1 task to be marked delivered');

  // 5) clear removes state
  await clearClockSession(sessionId);
  const afterClear = await listClockTasks(sessionId, clockConfig);
  assert(afterClear.length === 0, 'expected empty after clear');

  await stopClockDaemonForTests();
  await fs.rm(tmpRoot, { recursive: true, force: true });
  console.log('✅ clock-store-basic ok');
}

main().catch((err) => {
  console.error('❌ clock-store-basic failed', err);
  process.exit(1);
});

