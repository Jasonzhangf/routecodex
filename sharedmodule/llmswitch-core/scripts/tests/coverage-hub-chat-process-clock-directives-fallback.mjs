#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-clock-directives.js')
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function main() {
  const mod = await importFresh('hub-chat-process-clock-directives-fallback');
  const {
    extractClockScheduleDirectivesFromText,
    extractClockScheduleDirectivesFromContent,
    stripClockClearDirectiveFromText,
    stripClockClearDirectiveFromContent
  } = mod;

  assert.equal(typeof extractClockScheduleDirectivesFromText, 'function');
  assert.equal(typeof extractClockScheduleDirectivesFromContent, 'function');
  assert.equal(typeof stripClockClearDirectiveFromText, 'function');
  assert.equal(typeof stripClockClearDirectiveFromContent, 'function');

  {
    const out = extractClockScheduleDirectivesFromText('<**clock:clear**>');
    assert.equal(out.directives.length, 0);
    assert.equal(out.next, '<**clock:clear**>');
  }

  {
    const out = extractClockScheduleDirectivesFromText(undefined);
    assert.deepEqual(out, { directives: [], next: '' });
  }

  {
    const out = extractClockScheduleDirectivesFromText('<**clock:{bad json}**>');
    assert.equal(out.directives.length, 0);
    assert.equal(out.next, '<**clock:{bad json}**>');
  }

  {
    const out = extractClockScheduleDirectivesFromText(
      '<**clock:{"time":"2026-03-01T10:00:00.000Z","message":"valid"}**>'
    );
    assert.equal(out.directives.length, 1);
    assert.equal(out.directives[0].task, 'valid');
    assert.equal(out.next, '');
  }

  {
    const out = extractClockScheduleDirectivesFromText(
      '<**clock:{"time":"2026-03-01T10:00:00.000Z","message":"bad recurrence","recurrence":{"kind":"interval","everyMinutes":0,"maxRuns":3}}**>'
    );
    assert.equal(out.directives.length, 0);
    assert.equal(out.next.includes('bad recurrence'), true);
  }

  {
    const out = extractClockScheduleDirectivesFromContent([
      'prefix <**clock:{"time":"2026-03-01T10:00:00.000Z","message":"inline"}**> suffix',
      { type: 'input_text', text: '<**clock:{"time":"2026-03-01T11:00:00.000Z","message":"block-inline"}**>' },
      { type: 'input_image', image_url: 'x' },
      42
    ]);
    assert.equal(out.directives.length, 2);
    assert.equal(out.directives[0].task, 'inline');
    assert.equal(out.directives[1].task, 'block-inline');
    assert.equal(out.next[0], 'prefix  suffix');
    assert.equal(out.next[1].text, '');
    assert.equal(out.next[2].type, 'input_image');
    assert.equal(out.next[3], 42);
  }

  {
    const out = extractClockScheduleDirectivesFromContent(undefined);
    assert.deepEqual(out, { directives: [], next: undefined });
  }

  {
    const out = extractClockScheduleDirectivesFromContent(
      'prefix <**clock:{"time":"2026-03-01T12:00:00.000Z","message":"string-content"}**> suffix'
    );
    assert.equal(out.directives.length, 1);
    assert.equal(out.directives[0].task, 'string-content');
    assert.equal(out.next, 'prefix  suffix');
  }

  {
    const out = stripClockClearDirectiveFromText('<** clock : clear **>\n\n\nhello');
    assert.deepEqual(out, { hadClear: true, next: 'hello' });
  }

  {
    const out = stripClockClearDirectiveFromText(undefined);
    assert.deepEqual(out, { hadClear: false, next: '' });
  }

  {
    const out = stripClockClearDirectiveFromContent([
      '<**clock:clear**>',
      { type: 'input_text', text: '<**clock:clear**>\n\nnext' },
      { type: 'input_text' },
      { type: 'input_image', image_url: 'x' },
      7
    ]);
    assert.equal(out.hadClear, true);
    assert.equal(out.next[0], '');
    assert.equal(out.next[1].text, 'next');
    assert.equal(out.next[2].type, 'input_text');
    assert.equal(out.next[3].type, 'input_image');
    assert.equal(out.next[4], 7);
  }

  {
    const out = stripClockClearDirectiveFromContent('<**clock:clear**>\n\nhello');
    assert.deepEqual(out, { hadClear: true, next: 'hello' });
  }

  {
    const out = stripClockClearDirectiveFromContent({ passthrough: true });
    assert.deepEqual(out, { hadClear: false, next: { passthrough: true } });
  }

  console.log('✅ coverage-hub-chat-process-clock-directives-fallback passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-clock-directives-fallback failed:', error);
  process.exit(1);
});
