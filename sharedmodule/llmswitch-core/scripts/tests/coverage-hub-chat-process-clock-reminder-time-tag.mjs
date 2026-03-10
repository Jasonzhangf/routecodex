#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-clock-reminder-time-tag.js')
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function main() {
  const mod = await importFresh('hub-chat-process-clock-reminder-time-tag');
  const { CLOCK_TIME_TAG_FALLBACK_LINE, resolveClockReminderTimeTagLine } = mod;
  assert.equal(typeof CLOCK_TIME_TAG_FALLBACK_LINE, 'string');
  assert.equal(typeof resolveClockReminderTimeTagLine, 'function');

  {
    const out = await resolveClockReminderTimeTagLine({
      getClockTimeSnapshotFn: async () => ({ nowMs: 123 }),
      buildTimeTagLineFn: (snapshot) => `line:${snapshot.nowMs}`
    });
    assert.equal(out, 'line:123');
  }

  {
    const out = await resolveClockReminderTimeTagLine({
      getClockTimeSnapshotFn: async () => null
    });
    assert.equal(out, CLOCK_TIME_TAG_FALLBACK_LINE);
  }

  {
    const out = await resolveClockReminderTimeTagLine({
      getClockTimeSnapshotFn: async () => {
        throw new Error('ntp down');
      },
      fallbackLine: 'CUSTOM_FALLBACK'
    });
    assert.equal(out, 'CUSTOM_FALLBACK');
  }

  {
    const out = await resolveClockReminderTimeTagLine({
      getClockTimeSnapshotFn: async () => undefined,
      fallbackLine: '   '
    });
    assert.equal(out, CLOCK_TIME_TAG_FALLBACK_LINE);
  }

  {
    const out = await resolveClockReminderTimeTagLine({
      getClockTimeSnapshotFn: async () => ({ nowMs: 456 }),
      buildTimeTagLineFn: () => 'line:456',
      fallbackLine: 'WILL_NOT_USE'
    });
    assert.equal(out, 'line:456');
  }

  {
    const out = await resolveClockReminderTimeTagLine();
    assert.equal(typeof out, 'string');
    assert.ok(out.startsWith('[Time/Date]:'));
  }

  console.log('✅ coverage-hub-chat-process-clock-reminder-time-tag passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-clock-reminder-time-tag failed:', error);
  process.exit(1);
});
