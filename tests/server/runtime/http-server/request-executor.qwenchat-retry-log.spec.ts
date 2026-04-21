import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  __requestExecutorTestables,
  createRequestExecutor
} from '../../../../src/server/runtime/http-server/request-executor';

describe('request-executor qwenchat retry logging', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('suppresses qwenchat create-session 404 retry switch warnings and downgrades them to stage logs', () => {
    const logStage = jest.fn();
    const executor: any = createRequestExecutor({
      logStage,
      stats: {
        recordRequestStart: jest.fn(),
        recordCompletion: jest.fn()
      },
      getModuleDependencies: () => ({}),
      runtimeManager: {}
    } as any);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    executor.logProviderRetrySwitch({
      requestId: 'req-qwenchat-retry',
      attempt: 1,
      maxAttempts: 6,
      providerKey: 'qwenchat.1.qwen3.6-plus',
      nextAttempt: 2,
      reason: 'Failed to create qwenchat session: HTTP 404',
      backoffMs: 2000,
      statusCode: 404,
      errorCode: 'QWENCHAT_CREATE_SESSION_FAILED',
      upstreamCode: 'QWENCHAT_CREATE_SESSION_FAILED',
      switchAction: 'exclude_and_reroute',
      backoffScope: 'provider',
      decisionLabel: 'provider_backoff_then_reroute',
      stage: 'provider.send'
    });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(logStage).toHaveBeenCalledWith(
      'provider.retry.qwenchat_create_session_transient',
      'req-qwenchat-retry',
      expect.objectContaining({
        providerKey: 'qwenchat.1.qwen3.6-plus',
        attempt: 1,
        nextAttempt: 2,
        backoffMs: 2000
      })
    );
  });

  it('treats qwenchat raw native tool contract violations as health-neutral provider errors', () => {
    expect(__requestExecutorTestables.isHealthNeutralProviderError({
      stage: 'provider.send',
      errorCode: 'QWENCHAT_NATIVE_TOOL_CALL',
      statusCode: 502
    })).toBe(true);

    expect(__requestExecutorTestables.isHealthNeutralProviderError({
      stage: 'provider.send',
      upstreamCode: 'QWENCHAT_NATIVE_TOOL_CALL',
      statusCode: 502
    })).toBe(true);
  });
});
