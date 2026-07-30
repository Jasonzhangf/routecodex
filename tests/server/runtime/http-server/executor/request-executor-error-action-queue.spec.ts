import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule(
  '../../../../../src/modules/llmswitch/bridge/provider-action-gate-host',
  () => ({
    readProviderActionGateContractNative: jest.fn(),
    recordProviderActionFailureNative: jest.fn(),
    beginProviderActionWaitNative: jest.fn(),
    pollProviderActionAdmissionNative: jest.fn(),
    commitProviderActionTerminalNative: jest.fn(),
    abandonProviderActionAdmissionNative: jest.fn(),
    recordProviderActionSuccessNative: jest.fn(),
    cancelProviderActionWaitNative: jest.fn(),
    peekProviderActionWaitNative: jest.fn(),
    resetProviderActionGateNative: jest.fn()
  })
);

const providerActionGateHost = await import(
  '../../../../../src/modules/llmswitch/bridge/provider-action-gate-host'
);
const {
  describeErrorActionQueueContract,
  peekErrorActionBackoffWaitMs,
  recordErrorActionBackoff,
  registerErrorActionQueueHook,
  resetErrorActionBackoff,
  resetErrorActionBackoffByLaneGroup,
  resetErrorActionBackoffByScopePrefix,
  recordErrorActionSuccessByLaneGroup,
  resetErrorActionQueueStateForTests,
  waitErrorActionBackoffWithGate
} = await import(
  '../../../../../src/server/runtime/http-server/executor/request-executor-error-action-queue'
);

const mockReadContract = jest.mocked(providerActionGateHost.readProviderActionGateContractNative);
const mockRecordFailure = jest.mocked(providerActionGateHost.recordProviderActionFailureNative);
const mockBeginWait = jest.mocked(providerActionGateHost.beginProviderActionWaitNative);
const mockPollAdmission = jest.mocked(providerActionGateHost.pollProviderActionAdmissionNative);
const mockCommitTerminal = jest.mocked(providerActionGateHost.commitProviderActionTerminalNative);
const mockAbandonAdmission = jest.mocked(
  providerActionGateHost.abandonProviderActionAdmissionNative
);
const mockRecordSuccess = jest.mocked(providerActionGateHost.recordProviderActionSuccessNative);
const mockCancelWait = jest.mocked(providerActionGateHost.cancelProviderActionWaitNative);
const mockPeekWait = jest.mocked(providerActionGateHost.peekProviderActionWaitNative);
const mockReset = jest.mocked(providerActionGateHost.resetProviderActionGateNative);

describe('request-executor-error-action-queue Rust bridge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadContract.mockReturnValue({
      isolatedDelayMs: 1000,
      sustainedDelayMs: 5000,
      singleAdmissionPerGeneration: true,
      explicitAdmissionOwnership: true,
      wallClockExpiryForbidden: true,
      waiterOrder: 'fifo_ticket',
      abandonIsHealthNeutral: true
    });
    mockRecordFailure.mockReturnValue({
      generation: 1,
      mode: 'isolated',
      minimumDelayMs: 1000
    });
    mockBeginWait.mockReturnValue({
      state: 'wait',
      generation: 1,
      mode: 'isolated',
      waitMs: 1000
    });
    mockPollAdmission.mockReturnValue({
      state: 'admitted',
      generation: 1,
      mode: 'isolated',
      waitMs: 0
    });
    mockCommitTerminal.mockReturnValue(true);
    mockAbandonAdmission.mockReturnValue(true);
    mockRecordSuccess.mockReturnValue({ accepted: true, removedLanes: 1 });
    mockPeekWait.mockReturnValue(1000);
    mockReset.mockReturnValue(1);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('describes the Rust-owned isolated and sustained contract', () => {
    expect(describeErrorActionQueueContract()).toEqual({
      featureId: 'feature_id: error.provider_action_gate',
      isolatedDelayMs: 1000,
      sustainedDelayMs: 5000,
      blockingWait: true,
      singleAdmissionPerGeneration: true,
      explicitAdmissionOwnership: true,
      wallClockExpiryForbidden: true,
      waiterOrder: 'fifo_ticket',
      abandonIsHealthNeutral: true,
      categories: ['global_error', 'session_storm', 'servertool_followup'],
      hookEvents: ['record', 'wait_start', 'wait_end']
    });
    expect(mockReadContract).toHaveBeenCalledTimes(1);
  });

  test('records the normalized category and scope through the Rust owner', () => {
    const events: unknown[] = [];
    const unregister = registerErrorActionQueueHook((event) => events.push(event));

    expect(recordErrorActionBackoff({
      category: 'global_error',
      scopeKey: ' 5520|provider-a|timeout '
    })).toBe(1000);

    expect(mockRecordFailure).toHaveBeenCalledWith(
      'global_error|5520|provider-a|timeout',
      undefined,
      undefined
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'record',
        consecutive: 1,
        delayMs: 1000
      })
    ]);
    unregister();
  });

  test('forwards the active routing-group lane independently from provider/error scope', () => {
    recordErrorActionBackoff({
      category: 'global_error',
      scopeKey: 'port:5555|provider-a|tools|HTTP_503',
      laneGroupKey: 'port:5555|gateway-priority'
    });
    resetErrorActionBackoffByLaneGroup({
      category: 'global_error',
      laneGroupKey: 'port:5555|gateway-priority'
    });

    expect(mockRecordFailure).toHaveBeenCalledWith(
      'global_error|port:5555|provider-a|tools|HTTP_503',
      'global_error|port:5555|gateway-priority',
      undefined
    );
    expect(mockReset).toHaveBeenCalledWith({
      laneGroupKey: 'global_error|port:5555|gateway-priority'
    });
  });

  test('schedules the Rust poll without adding a TS delay policy', async () => {
    const waiting = waitErrorActionBackoffWithGate({
      category: 'global_error',
      scopeKey: 'scope-a'
    });
    await jest.advanceTimersByTimeAsync(1000);
    await expect(waiting).resolves.toBe(1000);

    const waiterId = mockBeginWait.mock.calls[0]?.[1];
    expect(waiterId).toMatch(/^\d+:\d+$/);
    expect(mockBeginWait).toHaveBeenCalledWith(
      'global_error|scope-a',
      waiterId,
      waiterId
    );
    expect(mockPollAdmission).toHaveBeenCalledTimes(1);
    expect(mockCancelWait).toHaveBeenCalledWith(
      'global_error|scope-a',
      waiterId,
      waiterId
    );
  });

  test('terminal projection re-records after success release and commits one Rust generation', async () => {
    mockBeginWait
      .mockReturnValueOnce({
        state: 'released_by_success',
        generation: 0,
        mode: 'idle',
        waitMs: 0
      })
      .mockReturnValueOnce({
        state: 'admitted',
        generation: 2,
        mode: 'isolated',
        waitMs: 0
      });

    await expect(waitErrorActionBackoffWithGate({
      category: 'global_error',
      scopeKey: 'scope-terminal',
      laneGroupKey: 'group-terminal',
      actionScopeKey: 'request-terminal',
      terminalProjection: true
    })).resolves.toBe(0);

    expect(mockRecordFailure).toHaveBeenCalledWith(
      'global_error|scope-terminal',
      'global_error|group-terminal',
      'request-terminal'
    );
    expect(mockCommitTerminal).toHaveBeenCalledWith(
      'global_error|scope-terminal',
      2,
      'request-terminal'
    );
    expect(mockAbandonAdmission).not.toHaveBeenCalled();
  });

  test('an admitted nonterminal action is abandoned only when its client signal aborts', async () => {
    mockBeginWait.mockReturnValue({
      state: 'admitted',
      generation: 7,
      mode: 'sustained',
      waitMs: 0
    });
    const controller = new AbortController();

    await expect(waitErrorActionBackoffWithGate({
      category: 'global_error',
      scopeKey: 'scope-abandon',
      actionScopeKey: 'request-abandon',
      signal: controller.signal
    })).resolves.toBe(0);

    expect(mockAbandonAdmission).not.toHaveBeenCalled();
    controller.abort();
    expect(mockAbandonAdmission).toHaveBeenCalledWith(
      'global_error|scope-abandon',
      7,
      'request-abandon'
    );
    expect(mockCancelWait).toHaveBeenCalledWith(
      'global_error|scope-abandon',
      expect.stringMatching(/^\d+:\d+$/),
      'request-abandon'
    );
  });

  test('pre-aborted action abandons its exact scope and never returns admission', async () => {
    mockBeginWait.mockReturnValue({
      state: 'admitted',
      generation: 8,
      mode: 'sustained',
      waitMs: 0
    });
    const controller = new AbortController();
    controller.abort(new Error('client gone'));

    await expect(waitErrorActionBackoffWithGate({
      category: 'global_error',
      scopeKey: 'scope-pre-aborted',
      actionScopeKey: 'request-pre-aborted',
      signal: controller.signal
    })).rejects.toThrow('client gone');

    expect(mockAbandonAdmission).toHaveBeenCalledWith(
      'global_error|scope-pre-aborted',
      8,
      'request-pre-aborted'
    );
  });

  test('owned success removes the admitted abort listener before a later signal abort', async () => {
    mockBeginWait.mockReturnValue({
      state: 'admitted',
      generation: 9,
      mode: 'sustained',
      waitMs: 0
    });
    const controller = new AbortController();

    await waitErrorActionBackoffWithGate({
      category: 'global_error',
      scopeKey: 'scope-success',
      laneGroupKey: 'group-success',
      actionScopeKey: 'request-success',
      signal: controller.signal
    });
    expect(recordErrorActionSuccessByLaneGroup({
      category: 'global_error',
      laneGroupKey: 'group-success',
      actionScopeKey: 'request-success'
    })).toBe(true);
    controller.abort();

    expect(mockRecordSuccess).toHaveBeenCalledWith(
      'global_error|group-success',
      'request-success'
    );
    expect(mockAbandonAdmission).not.toHaveBeenCalled();
  });

  test('forwards exact and prefix success resets to Rust', () => {
    resetErrorActionBackoff({
      category: 'global_error',
      scopeKey: 'scope-a'
    });
    resetErrorActionBackoffByScopePrefix({
      category: 'global_error',
      scopePrefix: '5520|provider-a|'
    });

    expect(mockReset).toHaveBeenNthCalledWith(1, {
      laneKey: 'global_error|scope-a'
    });
    expect(mockReset).toHaveBeenNthCalledWith(2, {
      lanePrefix: 'global_error|5520|provider-a|'
    });
  });

  test('peeks and resets test state only through the Rust owner', () => {
    expect(peekErrorActionBackoffWaitMs({
      category: 'session_storm',
      scopeKey: 'session-a'
    })).toBe(1000);
    expect(mockPeekWait).toHaveBeenCalledWith('session_storm|session-a');

    resetErrorActionQueueStateForTests();
    expect(mockReset).toHaveBeenCalledWith({});
  });
});
