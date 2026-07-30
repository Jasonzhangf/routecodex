import { describe, expect, jest, test } from '@jest/globals';

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
  peekErrorActionBackoffWaitMs,
  recordErrorActionBackoff,
  resetErrorActionBackoff,
  resetErrorActionBackoffByScopePrefix
} = await import(
  '../../../../../src/server/runtime/http-server/executor/request-executor-error-action-queue'
);

const mockRecordFailure = jest.mocked(providerActionGateHost.recordProviderActionFailureNative);
const mockPeekWait = jest.mocked(providerActionGateHost.peekProviderActionWaitNative);
const mockReset = jest.mocked(providerActionGateHost.resetProviderActionGateNative);

describe('request-executor global provider action scope bridge', () => {
  test('preserves port/provider/error-family scope isolation in the Rust lane key', () => {
    mockRecordFailure.mockReturnValue({
      generation: 2,
      mode: 'sustained',
      minimumDelayMs: 5000
    });
    mockPeekWait.mockReturnValue(5000);
    expect(recordErrorActionBackoff({
      category: 'global_error',
      scopeKey: '5520|provider-a|upstream_transient'
    })).toBe(5000);
    expect(mockRecordFailure).toHaveBeenCalledWith(
      'global_error|5520|provider-a|upstream_transient',
      undefined,
      undefined
    );

    expect(peekErrorActionBackoffWaitMs({
      category: 'global_error',
      scopeKey: '5555|provider-a|upstream_transient'
    })).toBe(5000);
    expect(mockPeekWait).toHaveBeenCalledWith(
      'global_error|5555|provider-a|upstream_transient'
    );
  });

  test('success resets only the exact lane or explicit provider prefix', () => {
    resetErrorActionBackoff({
      category: 'global_error',
      scopeKey: '5520|provider-a|status_429'
    });
    resetErrorActionBackoffByScopePrefix({
      category: 'global_error',
      scopePrefix: '5520|provider-a|'
    });

    expect(mockReset).toHaveBeenNthCalledWith(1, {
      laneKey: 'global_error|5520|provider-a|status_429'
    });
    expect(mockReset).toHaveBeenNthCalledWith(2, {
      lanePrefix: 'global_error|5520|provider-a|'
    });
  });
});
