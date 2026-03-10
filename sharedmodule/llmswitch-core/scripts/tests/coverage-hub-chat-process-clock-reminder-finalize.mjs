#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-clock-reminder-finalize.js')
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function main() {
  const mod = await importFresh('hub-chat-process-clock-reminder-finalize');
  const {
    buildDueReminderUserMessage,
    buildClockReminderMetadata,
    buildClockReminderMessages
  } = mod;

  assert.equal(typeof buildDueReminderUserMessage, 'function');
  assert.equal(typeof buildClockReminderMetadata, 'function');
  assert.equal(typeof buildClockReminderMessages, 'function');

  {
    assert.equal(buildDueReminderUserMessage(null, 'x'), null);
    assert.equal(buildDueReminderUserMessage({ a: 1 }, ''), null);
  }

  {
    const out = buildDueReminderUserMessage({ rid: '1' }, 'task-1 due');
    assert.ok(out);
    assert.equal(out.role, 'user');
    assert.ok(String(out.content).includes('task-1 due'));
    assert.ok(String(out.content).includes('[Clock Reminder]'));
  }

  {
    const req = { metadata: { originalEndpoint: '/v1/messages', keep: true } };
    const out = buildClockReminderMetadata({
      nextRequest: req,
      metadata: {},
      dueUserMessage: null,
      reservation: null
    });
    assert.deepEqual(out, req.metadata);
  }

  {
    const out = buildClockReminderMetadata({
      nextRequest: {},
      metadata: { originalEndpoint: '  /v1/responses  ' },
      dueUserMessage: null,
      reservation: null
    });
    assert.deepEqual(out, { originalEndpoint: '/v1/responses' });
  }

  {
    const out = buildClockReminderMetadata({
      nextRequest: {},
      metadata: { originalEndpoint: '   ' },
      dueUserMessage: { role: 'user', content: 'x' },
      reservation: { token: 'r1' }
    });
    assert.equal(out.originalEndpoint, '/v1/chat/completions');
    assert.deepEqual(out.__clockReservation, { token: 'r1' });
  }

  {
    const out = buildClockReminderMessages({
      baseMessages: [{ role: 'user', content: 'hello' }],
      markerToolMessages: [],
      dueUserMessage: null,
      timeTagLine: '[Time/Date]: now'
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].content, 'hello\n[Time/Date]: now');
  }

  {
    const out = buildClockReminderMessages({
      baseMessages: [{ role: 'assistant', content: 'a' }],
      markerToolMessages: [{ role: 'tool', content: 'm1' }],
      dueUserMessage: { role: 'user', content: 'due' },
      timeTagLine: '[Time/Date]: now'
    });
    assert.equal(out.length, 3);
    assert.equal(out[1].role, 'tool');
    assert.equal(out[2].role, 'user');
    assert.equal(out[2].content, 'due\n[Time/Date]: now');
  }

  {
    const out = buildClockReminderMessages({
      baseMessages: [{ role: 'assistant', content: 'a' }, { role: 'tool', content: 't' }],
      markerToolMessages: [],
      dueUserMessage: null,
      timeTagLine: '[Time/Date]: now'
    });
    assert.equal(out.length, 3);
    assert.equal(out[2].role, 'user');
    assert.equal(out[2].content, '[Time/Date]: now');
  }

  {
    const out = buildClockReminderMessages({
      baseMessages: [{ role: 'user', content: ['a'] }],
      markerToolMessages: [],
      dueUserMessage: null,
      timeTagLine: '[Time/Date]: now'
    });
    assert.deepEqual(out[0].content, ['a', '[Time/Date]: now']);
  }

  {
    const out = buildClockReminderMessages({
      baseMessages: [{ role: 'user', content: { type: 'input_text', text: 'x' } }],
      markerToolMessages: [],
      dueUserMessage: null,
      timeTagLine: '[Time/Date]: now'
    });
    assert.equal(out[0].content, '[Time/Date]: now');
  }

  console.log('✅ coverage-hub-chat-process-clock-reminder-finalize passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-clock-reminder-finalize failed:', error);
  process.exit(1);
});
