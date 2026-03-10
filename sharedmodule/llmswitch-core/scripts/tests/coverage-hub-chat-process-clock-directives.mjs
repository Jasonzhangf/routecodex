#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-clock-directives.js')
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'llms-clock-directives-native-'));
  const file = path.join(dir, 'mock-native.cjs');
  await fs.writeFile(file, content, 'utf8');
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const prevNativeDisable = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE;
  const prevNativePath = process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;

  setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE', '1');
  delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;

  const mod = await importFresh('hub-chat-process-clock-directives');
  const {
    stripClockClearDirectiveFromText,
    stripClockClearDirectiveFromContent,
    extractClockScheduleDirectivesFromText,
    extractClockScheduleDirectivesFromContent
  } = mod;

  assert.equal(typeof stripClockClearDirectiveFromText, 'function');
  assert.equal(typeof stripClockClearDirectiveFromContent, 'function');
  assert.equal(typeof extractClockScheduleDirectivesFromText, 'function');
  assert.equal(typeof extractClockScheduleDirectivesFromContent, 'function');

  {
    const out = stripClockClearDirectiveFromText('hello world');
    assert.deepEqual(out, { hadClear: false, next: 'hello world' });
  }

  {
    const out = stripClockClearDirectiveFromText(undefined);
    assert.deepEqual(out, { hadClear: false, next: '' });
  }

  {
    const out = stripClockClearDirectiveFromText('<**clock:clear**>\n\n\nhello');
    assert.deepEqual(out, { hadClear: true, next: 'hello' });
  }

  {
    const out = stripClockClearDirectiveFromContent('plain-content');
    assert.deepEqual(out, { hadClear: false, next: 'plain-content' });
  }

  {
    const out = stripClockClearDirectiveFromContent([
      'a',
      { type: 'input_text', text: '<** Clock : Clear **>\n\n\nhi' },
      { type: 'input_image', image_url: 'x' }
    ]);
    assert.equal(out.hadClear, true);
    assert.deepEqual(out.next, [
      'a',
      { type: 'input_text', text: 'hi' },
      { type: 'input_image', image_url: 'x' }
    ]);
  }

  {
    const out = stripClockClearDirectiveFromContent([
      'plain-line',
      { type: 'input_text' },
      42
    ]);
    assert.equal(out.hadClear, false);
    assert.deepEqual(out.next, ['plain-line', { type: 'input_text' }, 42]);
  }

  {
    const out = stripClockClearDirectiveFromContent([
      '<**clock:clear**>',
      'tail'
    ]);
    assert.equal(out.hadClear, true);
    assert.deepEqual(out.next, ['', 'tail']);
  }

  {
    const passthrough = { unknown: true };
    const out = stripClockClearDirectiveFromContent(passthrough);
    assert.deepEqual(out, { hadClear: false, next: passthrough });
  }

  {
    const out = extractClockScheduleDirectivesFromText('<**clock:{"time":"2026-03-01T10:00:00.000Z","message":"run smoke"}**>');
    assert.equal(out.directives.length, 1);
    assert.equal(out.directives[0].task, 'run smoke');
    assert.equal(out.next, '');
  }

  {
    const out = extractClockScheduleDirectivesFromText('<**clock:{time:"2026-03-01T10:00:00.000Z",message:"run loose"}**>');
    assert.equal(out.directives.length, 1);
    assert.equal(out.directives[0].task, 'run loose');
  }

  {
    const out = extractClockScheduleDirectivesFromText(
      'prefix <**clock:{"time":"2026-03-01T10:00:00.000Z","message":"middle"}**> suffix'
    );
    assert.equal(out.directives.length, 1);
    assert.equal(out.directives[0].task, 'middle');
    assert.equal(out.next, 'prefix  suffix');
  }

  {
    const out = extractClockScheduleDirectivesFromText('<**clock:bad-payload**>');
    assert.equal(out.directives.length, 0);
    assert.equal(out.next, '<**clock:bad-payload**>');
  }

  {
    const out = extractClockScheduleDirectivesFromText('<**clock:**>');
    assert.equal(out.directives.length, 0);
    assert.equal(out.next, '<**clock:**>');
  }

  {
    const out = extractClockScheduleDirectivesFromText(undefined);
    assert.equal(out.directives.length, 0);
    assert.equal(out.next, '');
  }

  {
    const out = extractClockScheduleDirectivesFromText('<**clock:{time:\'2026-03-01T10:00:00.000Z\',message:\'single-quoted\'}**>');
    assert.equal(out.directives.length, 1);
    assert.equal(out.directives[0].task, 'single-quoted');
  }

  {
    const out = extractClockScheduleDirectivesFromText('<**clock:{"due_at":"2026-03-01T10:00:00.000Z","task":"due_at route"}**>');
    assert.equal(out.directives.length, 1);
    assert.equal(out.directives[0].task, 'due_at route');
  }

  {
    const out = extractClockScheduleDirectivesFromText(
      '<**clock:{"time":"2026-03-01T10:00:00.000Z","message":"run recurring","recurrence":{"kind":"interval","everyMinutes":5,"maxRuns":3}}**>'
    );
    assert.equal(out.directives.length, 1);
    assert.deepEqual(out.directives[0].recurrence, { kind: 'interval', everyMinutes: 5, maxRuns: 3 });
  }

  {
    const out = extractClockScheduleDirectivesFromText(
      '<**clock:{"time":"2026-03-01T10:00:00.000Z","message":"bad recurring","recurrence":{"kind":"interval","everyMinutes":0,"maxRuns":3}}**>'
    );
    assert.equal(out.directives.length, 0);
    assert.equal(out.next.includes('bad recurring'), true);
  }

  {
    const out = extractClockScheduleDirectivesFromText(
      '<**clock:{"time":"2026-03-01T10:00:00.000Z","message":"daily recurring","recurrence":"daily","maxRuns":2}**>'
    );
    assert.equal(out.directives.length, 1);
    assert.deepEqual(out.directives[0].recurrence, { kind: 'daily', maxRuns: 2 });
  }

  {
    const out = extractClockScheduleDirectivesFromText(
      '<**clock:{"time":"2026-03-01T10:00:00.000Z","message":"weekly recurring","recurrence":{"type":"week","maxRuns":4}}**>'
    );
    assert.equal(out.directives.length, 1);
    assert.deepEqual(out.directives[0].recurrence, { kind: 'weekly', maxRuns: 4 });
  }

  {
    const out = extractClockScheduleDirectivesFromText(
      '<**clock:{"time":"2026-03-01T10:00:00.000Z","message":"interval alias","recurrence":"every_minutes","everyMinutes":7,"maxRuns":5}**>'
    );
    assert.equal(out.directives.length, 1);
    assert.deepEqual(out.directives[0].recurrence, { kind: 'interval', everyMinutes: 7, maxRuns: 5 });
  }

  {
    const out = extractClockScheduleDirectivesFromText(
      '<**clock:{"time":"2026-03-01T10:00:00.000Z","message":"unknown kind","recurrence":"unknown","maxRuns":2}**>'
    );
    assert.equal(out.directives.length, 0);
    assert.equal(out.next.includes('unknown kind'), true);
  }

  {
    const out = extractClockScheduleDirectivesFromText(
      '<**clock:{"time":"2026-03-01T10:00:00.000Z","message":"bad max","recurrence":"daily","maxRuns":0}**>'
    );
    assert.equal(out.directives.length, 0);
    assert.equal(out.next.includes('bad max'), true);
  }

  {
    const out = extractClockScheduleDirectivesFromText(
      '<**clock:{time:invalid-date,message:"invalid loose"}**>'
    );
    assert.equal(out.directives.length, 0);
    assert.equal(out.next.includes('invalid-date'), true);
  }

  {
    const out = extractClockScheduleDirectivesFromContent([
      { type: 'input_text', text: '<**clock:{"time":"2026-03-01T10:00:00.000Z","message":"array text"}**>' },
      { type: 'input_image', image_url: 'x' },
      '<**clock:clear**>'
    ]);
    assert.equal(out.directives.length, 1);
    assert.equal(out.directives[0].task, 'array text');
    assert.deepEqual(out.next, [
      { type: 'input_text', text: '' },
      { type: 'input_image', image_url: 'x' },
      '<**clock:clear**>'
    ]);
  }

  {
    const out = extractClockScheduleDirectivesFromContent(
      '<**clock:{"time":"2026-03-01T10:00:00.000Z","message":"content string"}**>'
    );
    assert.equal(out.directives.length, 1);
    assert.equal(out.directives[0].task, 'content string');
    assert.equal(out.next, '');
  }

  {
    const out = extractClockScheduleDirectivesFromContent([
      '<**clock:{"time":"2026-03-01T10:00:00.000Z","message":"string part"}**>'
    ]);
    assert.equal(out.directives.length, 1);
    assert.equal(out.directives[0].task, 'string part');
  }

  {
    const passthrough = { payload: 'x' };
    const out = extractClockScheduleDirectivesFromContent(passthrough);
    assert.deepEqual(out, { directives: [], next: passthrough });
  }

  {
    const out = extractClockScheduleDirectivesFromContent([
      { type: 'input_text' },
      100
    ]);
    assert.equal(out.directives.length, 0);
    assert.deepEqual(out.next, [{ type: 'input_text' }, 100]);
  }

  await withTempNativeModule(
    `
exports.stripClockClearDirectiveTextJson = (text) => JSON.stringify({ hadClear: true, next: String(text || '').toUpperCase() });
exports.extractClockScheduleDirectiveTextPartsJson = () => JSON.stringify({
  parts: [
    { kind: 'text', text: 'prefix ' },
    {
      kind: 'directive',
      full: '<**clock:mock-ok**>',
      candidate: { dueAt: '2026-03-01T10:00:00.000Z', task: 'native task' }
    },
    { kind: 'directive', full: '<**clock:mock-bad**>' },
    { kind: 'text', text: ' suffix' }
  ]
});
`,
    async (modulePath) => {
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE', undefined);
      setEnvVar('ROUTECODEX_LLMS_ROUTER_NATIVE_PATH', modulePath);
      const modNative = await importFresh('hub-chat-process-clock-directives-native');
      const out = modNative.stripClockClearDirectiveFromText('abc');
      assert.deepEqual(out, { hadClear: true, next: 'ABC' });
      const parsed = modNative.extractClockScheduleDirectivesFromText('ignored');
      assert.equal(parsed.directives.length, 1);
      assert.equal(parsed.directives[0].task, 'native task');
      assert.equal(parsed.next, 'prefix <**clock:mock-bad**> suffix');
    }
  );

  if (prevNativeDisable === undefined) {
    delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE;
  } else {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_DISABLE = prevNativeDisable;
  }
  if (prevNativePath === undefined) {
    delete process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH;
  } else {
    process.env.ROUTECODEX_LLMS_ROUTER_NATIVE_PATH = prevNativePath;
  }

  console.log('✅ coverage-hub-chat-process-clock-directives passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-clock-directives failed:', error);
  process.exit(1);
});
