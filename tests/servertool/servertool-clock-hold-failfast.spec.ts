import { describe, expect, jest, test } from '@jest/globals';

const listClockTasks = jest.fn(async () => {
  throw new Error('clock store offline');
});

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/servertool/clock/tasks.js', async () => {
  return {
    cancelClockTask: jest.fn(),
    clearClockTasks: jest.fn(),
    commitClockReservation: jest.fn(),
    findNearbyClockTasks: jest.fn(() => []),
    formatClockReminderBatchText: jest.fn(() => ''),
    formatClockReminderText: jest.fn(() => ''),
    hasObservedClockList: jest.fn(() => false),
    listClockTasks,
    listClockSessionIds: jest.fn(() => []),
    markClockListObserved: jest.fn(),
    parseDueAtMs: jest.fn(() => null),
    reserveDueTasksForRequest: jest.fn(async () => ({ reservation: null })),
    scheduleClockTasks: jest.fn(async () => []),
    selectClockReminderDeliveryBatch: jest.fn(() => []),
    selectDueUndeliveredTasks: jest.fn(() => []),
    updateClockTask: jest.fn(),
    findNextUndeliveredDueAtMs: jest.fn(() => Date.now() + 60_000)
  };
});

jest.unstable_mockModule('../../sharedmodule/llmswitch-core/src/servertool/clock/config.js', async () => {
  return {
    normalizeClockConfig: jest.fn((value) => value),
    resolveClockConfig: jest.fn(() => ({
      enabled: true,
      tickMs: 1000,
      dueWindowMs: 5000
    }))
  };
});

const { runServerToolOrchestration } = await import('../../sharedmodule/llmswitch-core/src/servertool/engine.js');

describe('servertool clock hold timeout probe fail-fast', () => {
  test('throws when clock hold timeout probe cannot inspect task store', async () => {
    const chat = {
      id: 'chatcmpl-clock-hold-failfast',
      object: 'chat.completion',
      model: 'gpt-test',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: '继续处理中...'
          }
        }
      ]
    } as any;

    const adapterContext = {
      requestId: 'req-clock-hold-failfast-1',
      sessionId: 'session-clock-hold-1',
      entryEndpoint: '/v1/responses',
      providerProtocol: 'openai-responses',
      __rt: {
        clock: {
          enabled: true,
          dueWindowMs: 5000
        }
      }
    } as any;

    await expect(
      runServerToolOrchestration({
        chat,
        adapterContext,
        requestId: 'req-clock-hold-failfast-1',
        entryEndpoint: '/v1/responses',
        providerProtocol: 'openai-responses'
      })
    ).rejects.toMatchObject({
      code: 'SERVERTOOL_CLOCK_HOLD_TIMEOUT_PROBE_FAILED',
      status: 500
    });

    expect(listClockTasks).toHaveBeenCalledWith(
      'session-clock-hold-1',
      expect.objectContaining({ dueWindowMs: 5000 })
    );
  });
});
