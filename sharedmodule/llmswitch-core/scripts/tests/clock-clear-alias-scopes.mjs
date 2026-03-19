#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llms-clock-clear-alias-'));
  const sessionDir = path.join(tmpRoot, 'sessions', 'server_test');
  process.env.ROUTECODEX_SESSION_DIR = sessionDir;

  const taskStore = await import(path.join(projectRoot, 'dist', 'servertool', 'clock', 'task-store.js'));
  const reminderFlow = await import(path.join(projectRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-clock-reminders.js'));
  const { scheduleClockTasks, listClockTasks } = taskStore;
  const { maybeInjectClockRemindersAndApplyDirectives } = reminderFlow;

  const clockConfig = { enabled: true, retentionMs: 20 * 60_000, dueWindowMs: 0, tickMs: 0 };
  await scheduleClockTasks(
    'session:alias_scope_1',
    [{ dueAtMs: Date.now() + 10 * 60_000, task: 'clear-me' }],
    clockConfig
  );
  assert.equal((await listClockTasks('session:alias_scope_1', clockConfig)).length, 1, 'expected aliased reminder before clear');

  await maybeInjectClockRemindersAndApplyDirectives(
    {
      messages: [{ role: 'user', content: '<**clock:clear**>\nclear now' }],
      metadata: { sessionId: 'alias_scope_1' }
    },
    {
      sessionId: 'alias_scope_1',
      clock: clockConfig,
      clientInjectReady: true
    },
    'req_clock_clear_alias'
  );

  assert.equal((await listClockTasks('session:alias_scope_1', clockConfig)).length, 0, 'expected aliased reminder cleared by marker');

  await fs.rm(tmpRoot, { recursive: true, force: true });
  console.log('✅ clock-clear-alias-scopes passed');
}

main().catch((error) => {
  console.error('❌ clock-clear-alias-scopes failed', error);
  process.exit(1);
});
