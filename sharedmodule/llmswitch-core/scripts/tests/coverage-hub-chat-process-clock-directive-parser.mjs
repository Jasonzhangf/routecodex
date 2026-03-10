#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-clock-directive-parser.js')
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function assertDirective(result) {
  assert.ok(result);
  assert.equal(typeof result.dueAtMs, 'number');
  assert.equal(typeof result.dueAt, 'string');
  assert.equal(typeof result.task, 'string');
}

async function main() {
  const mod = await importFresh('hub-chat-process-clock-directive-parser');
  const parseClockScheduleDirectivePayload = mod.parseClockScheduleDirectivePayload;
  const hydrateClockScheduleDirectiveCandidate = mod.hydrateClockScheduleDirectiveCandidate;
  assert.equal(typeof parseClockScheduleDirectivePayload, 'function');
  assert.equal(typeof hydrateClockScheduleDirectiveCandidate, 'function');

  {
    assert.equal(parseClockScheduleDirectivePayload(''), null);
    assert.equal(parseClockScheduleDirectivePayload('   '), null);
    assert.equal(parseClockScheduleDirectivePayload('clear'), null);
    assert.equal(parseClockScheduleDirectivePayload('CLEAR'), null);
  }

  {
    const out = parseClockScheduleDirectivePayload(
      '{"time":"2026-03-01T10:00:00.000Z","message":"run smoke"}'
    );
    assertDirective(out);
    assert.equal(out.task, 'run smoke');
  }

  {
    const out = parseClockScheduleDirectivePayload(
      '{"dueAt":"2026-03-01T10:00:00.000Z","task":"run dueAt alias"}'
    );
    assertDirective(out);
    assert.equal(out.task, 'run dueAt alias');
  }

  {
    const out = parseClockScheduleDirectivePayload(
      '{"due_at":"2026-03-01T10:00:00.000Z","task":"run due_at alias"}'
    );
    assertDirective(out);
    assert.equal(out.task, 'run due_at alias');
  }

  {
    assert.equal(
      parseClockScheduleDirectivePayload('{"time":"bad-date","message":"x"}'),
      null
    );
    assert.equal(
      parseClockScheduleDirectivePayload('{"time":"2026-03-01T10:00:00.000Z","message":""}'),
      null
    );
  }

  {
    const daily = parseClockScheduleDirectivePayload(
      '{"time":"2026-03-01T10:00:00.000Z","message":"daily","recurrence":"daily","maxRuns":2}'
    );
    assertDirective(daily);
    assert.deepEqual(daily.recurrence, { kind: 'daily', maxRuns: 2 });

    const dayAlias = parseClockScheduleDirectivePayload(
      '{"time":"2026-03-01T10:00:00.000Z","message":"day alias","recurrence":"day","maxRuns":2}'
    );
    assertDirective(dayAlias);
    assert.deepEqual(dayAlias.recurrence, { kind: 'daily', maxRuns: 2 });

    const weekly = parseClockScheduleDirectivePayload(
      '{"time":"2026-03-01T10:00:00.000Z","message":"weekly","recurrence":"weekly","maxRuns":2}'
    );
    assertDirective(weekly);
    assert.deepEqual(weekly.recurrence, { kind: 'weekly', maxRuns: 2 });

    const weekAlias = parseClockScheduleDirectivePayload(
      '{"time":"2026-03-01T10:00:00.000Z","message":"week alias","recurrence":{"type":"week","maxRuns":4}}'
    );
    assertDirective(weekAlias);
    assert.deepEqual(weekAlias.recurrence, { kind: 'weekly', maxRuns: 4 });
  }

  {
    const intervalA = parseClockScheduleDirectivePayload(
      '{"time":"2026-03-01T10:00:00.000Z","message":"interval","recurrence":"interval","everyMinutes":7,"maxRuns":5}'
    );
    assertDirective(intervalA);
    assert.deepEqual(intervalA.recurrence, { kind: 'interval', everyMinutes: 7, maxRuns: 5 });

    const intervalB = parseClockScheduleDirectivePayload(
      '{"time":"2026-03-01T10:00:00.000Z","message":"interval alias","recurrence":"every-minutes","everyMinutes":3,"maxRuns":2}'
    );
    assertDirective(intervalB);
    assert.deepEqual(intervalB.recurrence, { kind: 'interval', everyMinutes: 3, maxRuns: 2 });

    const intervalC = parseClockScheduleDirectivePayload(
      '{"time":"2026-03-01T10:00:00.000Z","message":"interval object","recurrence":{"kind":"interval","minutes":9,"maxRuns":6}}'
    );
    assertDirective(intervalC);
    assert.deepEqual(intervalC.recurrence, { kind: 'interval', everyMinutes: 9, maxRuns: 6 });

    const modeFallback = parseClockScheduleDirectivePayload(
      '{"time":"2026-03-01T10:00:00.000Z","message":"mode fallback","maxRuns":8,"recurrence":{"mode":"daily"}}'
    );
    assertDirective(modeFallback);
    assert.deepEqual(modeFallback.recurrence, { kind: 'daily', maxRuns: 8 });
  }

  {
    assert.equal(
      parseClockScheduleDirectivePayload(
        '{"time":"2026-03-01T10:00:00.000Z","message":"bad kind","recurrence":"unknown","maxRuns":2}'
      ),
      null
    );
    assert.equal(
      parseClockScheduleDirectivePayload(
        '{"time":"2026-03-01T10:00:00.000Z","message":"bad max","recurrence":"daily","maxRuns":0}'
      ),
      null
    );
    assert.equal(
      parseClockScheduleDirectivePayload(
        '{"time":"2026-03-01T10:00:00.000Z","message":"bad interval minutes","recurrence":"interval","everyMinutes":0,"maxRuns":2}'
      ),
      null
    );
    assert.equal(
      parseClockScheduleDirectivePayload(
        '{"time":"2026-03-01T10:00:00.000Z","message":"empty kind","recurrence":"","maxRuns":2}'
      ),
      null
    );
    assert.equal(
      parseClockScheduleDirectivePayload(
        '{"time":"2026-03-01T10:00:00.000Z","message":"has recurrence but false","recurrence":false}'
      ),
      null
    );
    assert.equal(
      parseClockScheduleDirectivePayload(
        '{"time":"2026-03-01T10:00:00.000Z","message":"non-string kind","recurrence":{"kind":1},"maxRuns":2}'
      ),
      null
    );
  }

  {
    const out = parseClockScheduleDirectivePayload(
      '{time:"2026-03-01T10:00:00.000Z",message:"loose-double-quoted"}'
    );
    assertDirective(out);
    assert.equal(out.task, 'loose-double-quoted');

    const out2 = parseClockScheduleDirectivePayload(
      "{time:'2026-03-01T10:00:00.000Z',message:'loose-single-quoted'}"
    );
    assertDirective(out2);
    assert.equal(out2.task, 'loose-single-quoted');
  }

  {
    assert.equal(parseClockScheduleDirectivePayload('{time:invalid,message:"x"}'), null);
    assert.equal(parseClockScheduleDirectivePayload('{time:   ,message:"x"}'), null);
    assert.equal(parseClockScheduleDirectivePayload('not-a-directive'), null);
    assert.equal(parseClockScheduleDirectivePayload('{}'), null);
    assert.equal(parseClockScheduleDirectivePayload('[]'), null);
  }

  {
    const out = hydrateClockScheduleDirectiveCandidate({
      dueAt: '2026-03-01T10:00:00.000Z',
      task: 'invalid-interval',
      recurrence: { kind: 'interval', everyMinutes: 0, maxRuns: 3 }
    });
    assert.equal(out, null);
  }

  console.log('✅ coverage-hub-chat-process-clock-directive-parser passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-clock-directive-parser failed:', error);
  process.exit(1);
});
