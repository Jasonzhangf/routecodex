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

async function writeClockState(sessionDir, sessionId, task) {
  const { resolveClockStateFile } = await import(path.join(projectRoot, 'dist', 'servertool', 'clock', 'paths.js'));
  const filePath = resolveClockStateFile(sessionDir, sessionId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        version: 2,
        sessionId,
        tmuxSessionId: sessionId.slice('tmux:'.length),
        updatedAtMs: Date.now(),
        tasks: [task]
      },
      null,
      2
    ),
    'utf8'
  );
  return filePath;
}

async function main() {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llmswitch-clock-hooks-'));
  const sessionDir = path.join(tmpRoot, 'sessions', 'server_test');
  process.env.ROUTECODEX_SESSION_DIR = sessionDir;

  const mod = await import(path.join(projectRoot, 'dist', 'servertool', 'clock', 'task-store.js'));
  const {
    listClockTasks,
    setClockRuntimeHooks,
    resetClockRuntimeHooksForTests,
    scheduleClockTasks,
    startClockDaemonIfNeeded,
    stopClockDaemonForTests
  } = mod;

  const clockConfig = {
    enabled: true,
    retentionMs: 20 * 60_000,
    dueWindowMs: 0,
    tickMs: 5 * 60_000,
    holdNonStreaming: false,
    holdMaxMs: 0
  };

  const deadSessionId = 'tmux:dead_session';
  const liveSessionId = 'tmux:live_session';
  const dueAtMs = Date.now() - 10_000;

  await writeClockState(sessionDir, deadSessionId, {
    taskId: 'task_dead',
    sessionId: deadSessionId,
    tmuxSessionId: 'dead_session',
    dueAtMs,
    createdAtMs: dueAtMs - 1000,
    updatedAtMs: dueAtMs - 1000,
    setBy: 'agent',
    prompt: 'dead task',
    task: 'dead task',
    deliveryCount: 0
  });
  await scheduleClockTasks(
    liveSessionId,
    [{
      dueAtMs,
      task: 'Open docs and inspect repo state',
      tool: 'web_search',
      arguments: { q: 'routecodex clock' },
      urls: ['https://example.com/docs'],
      paths: ['src/server']
    }],
    clockConfig
  );

  const liveFilePath = path.join(sessionDir, 'clock', 'tmux_live_session.json');
  const liveStateRaw = JSON.parse(await fs.readFile(liveFilePath, 'utf8'));
  assert(liveStateRaw.sessionId === liveSessionId, 'expected scheduled state to persist raw tmux session scope');
  assert(liveStateRaw.tmuxSessionId === 'live_session', 'expected scheduled state to persist tmuxSessionId');

  const dispatches = [];
  setClockRuntimeHooks({
    isTmuxSessionAlive: (tmuxSessionId) => tmuxSessionId !== 'dead_session' && tmuxSessionId !== 'gone_session',
    dispatchDueTask: async (request) => {
      dispatches.push(request);
      return { ok: true };
    }
  });

  await startClockDaemonIfNeeded(clockConfig);
  await new Promise((resolve) => setTimeout(resolve, 25));

  const deadTasks = await listClockTasks(deadSessionId, clockConfig);
  assert(deadTasks.length === 0, 'expected dead tmux session to be pruned');

  assert(dispatches.length === 1, `expected one dispatched live task, got ${dispatches.length}`);
  assert(dispatches[0].tmuxSessionId === 'live_session', 'expected live tmux session dispatch');
  assert(dispatches[0].injectText.includes('tool=web_search'), 'expected inject text to include tool');
  assert(dispatches[0].injectText.includes('https://example.com/docs'), 'expected inject text to include urls');
  assert(dispatches[0].injectText.includes('src/server'), 'expected inject text to include paths');

  const liveTasks = await listClockTasks(liveSessionId, clockConfig);
  assert(liveTasks.length === 1, 'expected delivered one-shot task to remain until retention');
  assert(liveTasks[0].deliveryCount === 1, 'expected daemon dispatch to mark task triggered');

  resetClockRuntimeHooksForTests();
  await stopClockDaemonForTests();
  await fs.rm(tmpRoot, { recursive: true, force: true });
  console.log('✅ clock-daemon-runtime-hooks ok');
}

main().catch((err) => {
  console.error('❌ clock-daemon-runtime-hooks failed', err);
  process.exit(1);
});
