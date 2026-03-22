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
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llmswitch-clock-inject-'));
  const sessionDir = path.join(tmpRoot, 'sessions', 'server_test');
  process.env.ROUTECODEX_SESSION_DIR = sessionDir;

  const clockStore = await import(path.join(projectRoot, 'dist', 'servertool', 'clock', 'task-store.js'));
  const { scheduleClockTasks, listClockTasks, stopClockDaemonForTests } = clockStore;

  const chatProcess = await import(path.join(projectRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process.js'));
  const { runHubChatProcess } = chatProcess;

  const clockConfig = { enabled: true, retentionMs: 20 * 60_000, dueWindowMs: 60_000, tickMs: 0 };
  const sessionId = 'sess_inject_1';

  // schedule a due task (due in 30s => due immediately since dueWindow=60s)
  const now = Date.now();
  await scheduleClockTasks(
    sessionId,
    [{ dueAtMs: now + 30_000, task: 'inject-me', tool: 'exec_command', arguments: { cmd: 'ls' } }],
    clockConfig
  );
  const before = await listClockTasks(sessionId, clockConfig);
  assert(before.length === 1, 'expected 1 scheduled task');

  const baseRequest = {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    parameters: { stream: false },
    metadata: { originalEndpoint: '/v1/chat/completions' }
  };

  const result = await runHubChatProcess({
    request: baseRequest,
    requestId: 'req_clock_inject',
    entryEndpoint: '/v1/chat/completions',
    rawPayload: {},
    metadata: {
      providerProtocol: 'openai-chat',
      sessionId,
      clock: clockConfig,
      requestId: 'req_clock_inject'
    }
  });

  assert(result.processedRequest, 'expected processedRequest');
  const processed = result.processedRequest;
  const tools = Array.isArray(processed.tools) ? processed.tools : [];
  assert(tools.some((t) => t?.function?.name === 'clock'), 'expected clock tool to be injected');

  const msgs = Array.isArray(processed.messages) ? processed.messages : [];
  assert(msgs.length >= 2, 'expected at least 2 messages after injection');
  const last = msgs[msgs.length - 1];
  assert(last.role === 'system', 'expected injected reminder as system message');
  assert(typeof last.content === 'string' && last.content.includes('[scheduled task:'), 'expected scheduled task marker');

  const reservation = processed.metadata?.__clockReservation;
  assert(reservation && typeof reservation === 'object', 'expected __clockReservation in request metadata');

  // clock:clear directive must remove tasks and strip tag
  const clearRequest = {
    ...baseRequest,
    messages: [{ role: 'user', content: '<**clock:clear**>\nhi' }]
  };
  await runHubChatProcess({
    request: clearRequest,
    requestId: 'req_clock_clear',
    entryEndpoint: '/v1/chat/completions',
    rawPayload: {},
    metadata: {
      providerProtocol: 'openai-chat',
      sessionId,
      clock: clockConfig,
      requestId: 'req_clock_clear'
    }
  });
  const afterClear = await listClockTasks(sessionId, clockConfig);
  assert(afterClear.length === 0, 'expected tasks cleared by <**clock:clear**>');

  const aliasedSessionScope = 'session:alias_scope_1';
  await scheduleClockTasks(
    aliasedSessionScope,
    [{ dueAtMs: now + 30_000, task: 'inject-aliased-clear', tool: 'exec_command', arguments: { cmd: 'pwd' } }],
    clockConfig
  );
  const beforeAliasedClear = await listClockTasks(aliasedSessionScope, clockConfig);
  assert(beforeAliasedClear.length === 1, 'expected aliased reminder before clear');

  await runHubChatProcess({
    request: clearRequest,
    requestId: 'req_clock_clear_alias',
    entryEndpoint: '/v1/chat/completions',
    rawPayload: {},
    metadata: {
      providerProtocol: 'openai-chat',
      sessionId: 'alias_scope_1',
      clock: clockConfig,
      requestId: 'req_clock_clear_alias'
    }
  });
  const afterAliasedClear = await listClockTasks(aliasedSessionScope, clockConfig);
  assert(afterAliasedClear.length === 0, 'expected aliased session reminders cleared by <**clock:clear**>');

  await stopClockDaemonForTests();
  await fs.rm(tmpRoot, { recursive: true, force: true });
  console.log('✅ clock-injection-chat-process ok');
}

main().catch((err) => {
  console.error('❌ clock-injection-chat-process failed', err);
  process.exit(1);
});
