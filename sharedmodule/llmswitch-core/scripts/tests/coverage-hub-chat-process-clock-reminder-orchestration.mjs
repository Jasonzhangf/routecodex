#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const moduleUrl = pathToFileURL(
  path.join(repoRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-clock-reminder-orchestration.js')
).href;

async function importFresh(tag) {
  return import(`${moduleUrl}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function parseToolPayload(messages) {
  const tool = messages.find((entry) => entry.role === 'tool');
  assert.ok(tool);
  assert.equal(typeof tool.content, 'string');
  return JSON.parse(tool.content);
}

async function main() {
  const mod = await importFresh('hub-chat-process-clock-reminder-orchestration');
  const { scheduleClockReminderDirectiveMessages, reserveClockDueReminderForRequest } = mod;
  assert.equal(typeof scheduleClockReminderDirectiveMessages, 'function');
  assert.equal(typeof reserveClockDueReminderForRequest, 'function');

  {
    let called = false;
    const out = await scheduleClockReminderDirectiveMessages(
      {
        clockScheduleDirectives: [],
        sessionId: 's1',
        requestId: 'req-1',
        clockConfig: { dueWindowMs: 30_000 }
      },
      {
        scheduleClockTasksFn: async () => {
          called = true;
          return [];
        }
      }
    );
    assert.equal(called, false);
    assert.deepEqual(out, []);
  }

  {
    const out = await scheduleClockReminderDirectiveMessages({
      clockScheduleDirectives: [{ dueAt: '2026-03-01T10:00:00.000Z', dueAtMs: 1, task: 't1' }],
      sessionId: null,
      requestId: 'req-no-session',
      clockConfig: { dueWindowMs: 30_000 }
    });
    assert.equal(out.length, 2);
    const payload = parseToolPayload(out);
    assert.equal(payload.ok, false);
    assert.equal(payload.action, 'schedule');
  }

  {
    const captured = [];
    const out = await scheduleClockReminderDirectiveMessages(
      {
        clockScheduleDirectives: [
          {
            dueAt: '2026-03-01T10:00:00.000Z',
            dueAtMs: 100_500,
            task: 't2',
            recurrence: { kind: 'daily', maxRuns: 3 }
          }
        ],
        sessionId: 's2',
        requestId: 'req-guard',
        clockConfig: { dueWindowMs: 1_000 }
      },
      {
        nowFn: () => 100_000,
        scheduleClockTasksFn: async (_sessionId, items) => {
          captured.push(items[0]);
          return [{ taskId: 'task-1', dueAtMs: items[0].dueAtMs, task: items[0].task, deliveryCount: 0 }];
        },
        logClockFn: () => {}
      }
    );
    assert.equal(captured.length, 1);
    assert.equal(captured[0].notBeforeRequestId, 'req-guard');
    assert.equal(out.length, 2);
    const payload = parseToolPayload(out);
    assert.equal(payload.ok, true);
    assert.equal(payload.action, 'schedule');
    assert.equal(payload.scheduled.length, 1);
  }

  {
    const captured = [];
    const out = await scheduleClockReminderDirectiveMessages(
      {
        clockScheduleDirectives: [{ dueAt: '2026-03-01T11:00:00.000Z', dueAtMs: 200_500, task: 't3' }],
        sessionId: 's3',
        requestId: 'req-no-guard',
        clockConfig: { dueWindowMs: 100 }
      },
      {
        nowFn: () => 100_000,
        scheduleClockTasksFn: async (_sessionId, items) => {
          captured.push(items[0]);
          return [{ taskId: 'task-2', dueAtMs: items[0].dueAtMs, task: items[0].task, deliveryCount: 0 }];
        },
        logClockFn: () => {}
      }
    );
    assert.equal(captured.length, 1);
    assert.equal(captured[0].notBeforeRequestId, undefined);
    assert.equal(out.length, 2);
    const payload = parseToolPayload(out);
    assert.equal(payload.ok, true);
  }

  {
    const out = await scheduleClockReminderDirectiveMessages(
      {
        clockScheduleDirectives: [{ dueAt: '2026-03-01T12:00:00.000Z', dueAtMs: 100, task: 't4' }],
        sessionId: 's4',
        requestId: 'req-error',
        clockConfig: { dueWindowMs: 1_000 }
      },
      {
        scheduleClockTasksFn: async () => {
          throw new Error('boom');
        }
      }
    );
    assert.equal(out.length, 2);
    const payload = parseToolPayload(out);
    assert.equal(payload.ok, false);
    assert.equal(typeof payload.message, 'string');
    assert.ok(payload.message.includes('boom'));
  }

  {
    const out = await scheduleClockReminderDirectiveMessages(
      {
        clockScheduleDirectives: [{ dueAt: '2026-03-01T12:00:00.000Z', dueAtMs: 100, task: 't4b' }],
        sessionId: 's4b',
        requestId: 'req-error-nonerror',
        clockConfig: { dueWindowMs: 1_000 }
      },
      {
        scheduleClockTasksFn: async () => {
          throw 'boom-string';
        }
      }
    );
    const payload = parseToolPayload(out);
    assert.equal(payload.ok, false);
    assert.equal(typeof payload.message, 'string');
    assert.ok(payload.message.includes('boom-string'));
  }

  {
    const out = await scheduleClockReminderDirectiveMessages(
      {
        clockScheduleDirectives: [{ dueAt: '2026-03-01T12:30:00.000Z', dueAtMs: 100, task: 't4c' }],
        sessionId: 's4c',
        requestId: 'req-error-nullish',
        clockConfig: { dueWindowMs: 1_000 }
      },
      {
        scheduleClockTasksFn: async () => {
          throw null;
        }
      }
    );
    const payload = parseToolPayload(out);
    assert.equal(payload.ok, false);
    assert.equal(typeof payload.message, 'string');
    assert.ok(payload.message.includes('unknown'));
  }

  {
    let called = false;
    const out = await reserveClockDueReminderForRequest(
      {
        hadClear: true,
        sessionId: 's5',
        requestId: 'req-clear',
        clockConfig: { dueWindowMs: 1_000 }
      },
      {
        reserveDueTasksForRequestFn: async () => {
          called = true;
          return { reservation: null };
        }
      }
    );
    assert.equal(called, false);
    assert.equal(out.reservation, null);
    assert.equal(out.dueInjectText, '');
  }

  {
    let called = false;
    const out = await reserveClockDueReminderForRequest(
      {
        hadClear: false,
        sessionId: null,
        requestId: 'req-nosession',
        clockConfig: { dueWindowMs: 1_000 }
      },
      {
        reserveDueTasksForRequestFn: async () => {
          called = true;
          return { reservation: null };
        }
      }
    );
    assert.equal(called, false);
    assert.equal(out.reservation, null);
    assert.equal(out.dueInjectText, '');
  }

  {
    const args = [];
    const out = await reserveClockDueReminderForRequest(
      {
        hadClear: false,
        sessionId: 's6',
        requestId: 'req-reserve',
        clockConfig: { dueWindowMs: 1_000 }
      },
      {
        reserveDueTasksForRequestFn: async (input) => {
          args.push(input);
          return { reservation: { reservationId: 'r1', sessionId: 's6', taskIds: ['t1'], reservedAtMs: 123 }, injectText: '  due text  ' };
        }
      }
    );
    assert.equal(args.length, 1);
    assert.equal(args[0].requestId, 'req-reserve');
    assert.equal(out.reservation?.reservationId, 'r1');
    assert.equal(out.dueInjectText, 'due text');
  }

  {
    const out = await reserveClockDueReminderForRequest({
      hadClear: false,
      sessionId: 's-default',
      requestId: 'req-default-reserve',
      clockConfig: { dueWindowMs: 1_000, retentionMs: 60_000, tickMs: 30_000, holdNonStreaming: true, holdMaxMs: 10_000, enabled: true }
    });
    assert.equal(out.reservation, null);
    assert.equal(out.dueInjectText, '');
  }

  {
    const out = await reserveClockDueReminderForRequest(
      {
        hadClear: false,
        sessionId: 's6b',
        requestId: 'req-reserve-no-text',
        clockConfig: { dueWindowMs: 1_000 }
      },
      {
        reserveDueTasksForRequestFn: async () => {
          return { reservation: { reservationId: 'r2', sessionId: 's6b', taskIds: [], reservedAtMs: 1 }, injectText: 42 };
        }
      }
    );
    assert.equal(out.reservation?.reservationId, 'r2');
    assert.equal(out.dueInjectText, '');
  }

  {
    const out = await reserveClockDueReminderForRequest(
      {
        hadClear: false,
        sessionId: 's7',
        requestId: 'req-reserve-fail',
        clockConfig: { dueWindowMs: 1_000 }
      },
      {
        reserveDueTasksForRequestFn: async () => {
          throw new Error('unavailable');
        }
      }
    );
    assert.equal(out.reservation, null);
    assert.equal(out.dueInjectText, '');
  }

  console.log('✅ coverage-hub-chat-process-clock-reminder-orchestration passed');
}

main().catch((error) => {
  console.error('❌ coverage-hub-chat-process-clock-reminder-orchestration failed:', error);
  process.exit(1);
});
