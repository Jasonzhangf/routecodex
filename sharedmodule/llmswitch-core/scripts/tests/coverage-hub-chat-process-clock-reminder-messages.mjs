#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-clock-reminder-messages.js')
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function main() {
  const mod = await importFresh('hub-chat-process-clock-reminder-messages');
  const {
    buildClockMarkerScheduleMessages,
    findLastUserMessageIndex,
    injectTimeTagIntoMessages
  } = mod;

  assert.equal(typeof buildClockMarkerScheduleMessages, 'function');
  assert.equal(typeof findLastUserMessageIndex, 'function');
  assert.equal(typeof injectTimeTagIntoMessages, 'function');

  {
    const out = buildClockMarkerScheduleMessages(
      'req:1/a',
      0,
      { dueAt: '2026-03-01T10:00:00.000Z', dueAtMs: 1762346400000, task: 'do-work' },
      { ok: true }
    );
    assert.equal(out.length, 2);
    assert.equal(out[0].role, 'assistant');
    assert.equal(out[1].role, 'tool');
    assert.equal(out[0].tool_calls[0].function.name, 'clock');
    assert.ok(out[0].tool_calls[0].id.startsWith('call_clock_marker_req_1_a_1_'));
    const parsedArgs = JSON.parse(out[0].tool_calls[0].function.arguments);
    assert.equal(parsedArgs.action, 'schedule');
    assert.deepEqual(parsedArgs.items[0], {
      dueAt: '2026-03-01T10:00:00.000Z',
      task: 'do-work'
    });
  }

  {
    const out = buildClockMarkerScheduleMessages(
      '',
      2,
      {
        dueAt: '2026-03-01T10:00:00.000Z',
        dueAtMs: 1762346400000,
        task: 'recurring',
        recurrence: { kind: 'interval', everyMinutes: 10, maxRuns: 2 }
      },
      { ok: false, reason: 'x' }
    );
    const parsedArgs = JSON.parse(out[0].tool_calls[0].function.arguments);
    assert.deepEqual(parsedArgs.items[0].recurrence, { kind: 'interval', everyMinutes: 10, maxRuns: 2 });
  }

  {
    assert.equal(findLastUserMessageIndex([]), -1);
    assert.equal(findLastUserMessageIndex(null), -1);
    assert.equal(findLastUserMessageIndex([{ role: 'assistant', content: 'x' }]), -1);
    assert.equal(
      findLastUserMessageIndex([
        { role: 'user', content: '1' },
        { role: 'assistant', content: '2' },
        { role: 'user', content: '3' }
      ]),
      2
    );
  }

  {
    const out = injectTimeTagIntoMessages([], '[Time/Date]: t');
    assert.equal(out.length, 1);
    assert.equal(out[0].role, 'user');
    assert.equal(out[0].content, '[Time/Date]: t');
  }

  {
    const source = [{ role: 'user', content: 'hello   ' }];
    const out = injectTimeTagIntoMessages(source, '[Time/Date]: t');
    assert.notEqual(out, source);
    assert.equal(out[0].content, 'hello\n[Time/Date]: t');
  }

  {
    const source = [{ role: 'user', content: '   ' }];
    const out = injectTimeTagIntoMessages(source, '[Time/Date]: t');
    assert.equal(out[0].content, '[Time/Date]: t');
  }

  {
    const source = [{ role: 'user', content: ['part1'] }];
    const out = injectTimeTagIntoMessages(source, '[Time/Date]: t');
    assert.deepEqual(out[0].content, ['part1', '[Time/Date]: t']);
  }

  {
    const source = [{ role: 'user', content: { type: 'input_text', text: 'x' } }];
    const out = injectTimeTagIntoMessages(source, '[Time/Date]: t');
    assert.equal(out[0].content, '[Time/Date]: t');
  }

  {
    const source = [
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'u1' },
      { role: 'tool', content: 't' }
    ];
    const out = injectTimeTagIntoMessages(source, '[Time/Date]: t');
    assert.equal(out[1].content, 'u1\n[Time/Date]: t');
    assert.deepEqual(out[0], source[0]);
    assert.deepEqual(out[2], source[2]);
  }

  console.log('✅ coverage-hub-chat-process-clock-reminder-messages passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-clock-reminder-messages failed:', error);
  process.exit(1);
});
