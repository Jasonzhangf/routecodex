#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-clock-reminder-directives.js')
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function main() {
  const mod = await importFresh('hub-chat-process-clock-reminder-directives');
  const { extractClockReminderDirectives } = mod;
  assert.equal(typeof extractClockReminderDirectives, 'function');

  {
    const messages = [{ role: 'assistant', content: 'x' }];
    const out = extractClockReminderDirectives(messages);
    assert.equal(out.hadClear, false);
    assert.equal(out.clockScheduleDirectives.length, 0);
    assert.deepEqual(out.baseMessages, messages);
  }

  {
    const messages = [{ role: 'user', content: 'plain text' }];
    const out = extractClockReminderDirectives(messages);
    assert.equal(out.hadClear, false);
    assert.equal(out.clockScheduleDirectives.length, 0);
    assert.deepEqual(out.baseMessages, messages);
  }

  {
    const messages = [{ role: 'user', content: '<**clock:clear**>\nhello' }];
    const out = extractClockReminderDirectives(messages);
    assert.equal(out.hadClear, true);
    assert.equal(out.clockScheduleDirectives.length, 0);
    assert.notEqual(out.baseMessages, messages);
    assert.equal(out.baseMessages[0].content, 'hello');
  }

  {
    const messages = [
      { role: 'user', content: '<**clock:{"time":"2026-03-01T10:00:00.000Z","message":"run task"}**>' }
    ];
    const out = extractClockReminderDirectives(messages);
    assert.equal(out.hadClear, false);
    assert.equal(out.clockScheduleDirectives.length, 1);
    assert.notEqual(out.baseMessages, messages);
    assert.equal(out.baseMessages[0].content, '');
    assert.equal(out.clockScheduleDirectives[0].task, 'run task');
  }

  {
    const messages = [
      {
        role: 'user',
        content:
          '<**clock:clear**>\n<**clock:{"time":"2026-03-01T10:00:00.000Z","message":"run task"}**>\ntext'
      }
    ];
    const out = extractClockReminderDirectives(messages);
    assert.equal(out.hadClear, true);
    assert.equal(out.clockScheduleDirectives.length, 1);
    assert.equal(out.baseMessages[0].content, 'text');
  }

  {
    const messages = [
      {
        role: 'user',
        content:
          '<**clock:{"time":"2026-03-01T10:00:00.000Z","message":"run every 5m","recurrence":{"kind":"interval","maxRuns":3,"everyMinutes":5}}**>'
      }
    ];
    const out = extractClockReminderDirectives(messages);
    assert.equal(out.hadClear, false);
    assert.equal(out.clockScheduleDirectives.length, 1);
    assert.equal(out.clockScheduleDirectives[0].recurrence?.kind, 'interval');
    assert.equal(out.clockScheduleDirectives[0].recurrence?.everyMinutes, 5);
  }

  {
    const messages = [
      { role: 'user', content: 'older user' },
      { role: 'assistant', content: 'middle' },
      {
        role: 'user',
        content: [{ type: 'input_text', text: '<**clock:clear**>\nlatest' }, { type: 'input_image', image_url: 'x' }]
      }
    ];
    const out = extractClockReminderDirectives(messages);
    assert.equal(out.hadClear, true);
    assert.equal(out.baseMessages[0], messages[0]);
    assert.equal(out.baseMessages[1], messages[1]);
    assert.deepEqual(out.baseMessages[2].content, [
      { type: 'input_text', text: 'latest' },
      { type: 'input_image', image_url: 'x' }
    ]);
  }

  {
    const messages = [
      { role: 'user', content: '<**clock:{"time":"not-a-time","message":"invalid"}**>' }
    ];
    const out = extractClockReminderDirectives(messages);
    assert.equal(out.hadClear, false);
    assert.equal(out.clockScheduleDirectives.length, 0);
    assert.equal(out.baseMessages, messages);
    assert.equal(
      out.baseMessages[0].content,
      '<**clock:{"time":"not-a-time","message":"invalid"}**>'
    );
  }

  console.log('✅ coverage-hub-chat-process-clock-reminder-directives passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-clock-reminder-directives failed:', error);
  process.exit(1);
});
