#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(
    repoRoot,
    'dist',
    'router',
    'virtual-router',
    'engine-selection',
    'native-chat-process-clock-reminder-semantics.js'
  )
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function setEnvVar(name, value) {
  if (value === undefined || value === null || value === '') {
    delete process.env[name];
    return;
  }
  process.env[name] = String(value);
}

async function withTempNativeModule(content, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llms-native-clock-reminder-sem-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  const prevRccNativePath = process.env.RCC_LLMS_ROUTER_NATIVE_PATH;

  await withTempNativeModule(
    `
exports.findLastUserMessageIndexJson = () => JSON.stringify(3);
exports.injectTimeTagIntoMessagesJson = () => JSON.stringify([{ role: 'user', content: 'tagged' }]);
exports.resolveClockSessionScopeJson = () => JSON.stringify('tmux:rcc_codex_mock_1');
exports.resolveClockConfigJson = (_rawJson, rawIsUndefined) => JSON.stringify(
  rawIsUndefined
    ? { enabled: true, retentionMs: 1200000, dueWindowMs: 0, tickMs: 60000, holdNonStreaming: true, holdMaxMs: 60000 }
    : null
);
exports.buildClockMarkerScheduleMessagesJson = () => JSON.stringify([
  { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'clock', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'call_1', name: 'clock', content: '{}' }
]);
exports.buildDueReminderUserMessageJson = () => JSON.stringify({ role: 'user', content: 'due now' });
exports.buildClockReminderMetadataJson = () => JSON.stringify({ originalEndpoint: '/v1/chat/completions', __clockReservation: { id: 'r1' } });
exports.buildClockReminderMessagesJson = () => JSON.stringify([{ role: 'user', content: 'done' }]);
`,
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      setEnvVar('RCC_LLMS_ROUTER_NATIVE_PATH', undefined);

      const mod = await importFresh('native-chat-process-clock-reminder-semantics');

      const idx = mod.findLastUserMessageIndexWithNative([], () => -1);
      assert.equal(idx, 3);

      const tagged = mod.injectTimeTagIntoMessagesWithNative([], '[time]', () => []);
      assert.equal(Array.isArray(tagged), true);
      assert.equal(tagged[0].content, 'tagged');

      const scope = mod.resolveClockSessionScopeWithNative(
        { clientTmuxSessionId: 'rcc_codex_fallback' },
        null,
        () => null
      );
      assert.equal(scope, 'tmux:rcc_codex_mock_1');

      const clockConfig = mod.resolveClockConfigWithNative(
        undefined,
        true,
        () => null
      );
      assert.equal(clockConfig?.enabled, true);
      assert.equal(clockConfig?.retentionMs, 1200000);

      const markerMessages = mod.buildClockMarkerScheduleMessagesWithNative(
        'req1',
        0,
        { dueAt: '2026-01-01T00:00:00Z', task: 'run' },
        { ok: true },
        () => []
      );
      assert.equal(markerMessages.length, 2);

      const dueMsg = mod.buildDueReminderUserMessageWithNative({ id: 1 }, 'due text', () => null);
      assert.equal(dueMsg?.role, 'user');

      const metadata = mod.buildClockReminderMetadataWithNative(null, { originalEndpoint: '/v1/chat/completions' }, { role: 'user', content: 'x' }, { id: 1 }, () => ({}));
      assert.equal(metadata.__clockReservation.id, 'r1');

      const allMessages = mod.buildClockReminderMessagesWithNative([], [], null, '[time]', () => []);
      assert.equal(allMessages[0].content, 'done');
    }
  );

  if (prevNativePath === undefined) {
    delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  } else {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevNativePath;
  }
  if (prevRccNativePath === undefined) {
    delete process.env.RCC_LLMS_ROUTER_NATIVE_PATH;
  } else {
    process.env.RCC_LLMS_ROUTER_NATIVE_PATH = prevRccNativePath;
  }

  console.log('✅ coverage-native-chat-process-clock-reminder-semantics passed');
}

main().catch((error) => {
  console.error('❌ coverage-native-chat-process-clock-reminder-semantics failed:', error);
  process.exit(1);
});
