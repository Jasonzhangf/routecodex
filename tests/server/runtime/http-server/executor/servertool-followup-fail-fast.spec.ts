import { describe, expect, it } from '@jest/globals';
import {
  awaitNestedExecutionWithFailFast,
  createServerToolFollowupTimeoutError,
  resolveServerToolNestedFollowupTimeoutMs
} from '../../../../../src/server/runtime/http-server/executor/servertool-followup-fail-fast.js';

describe('servertool followup fail-fast helper', () => {
  it('fails fast when nested execute never resolves', async () => {
    await expect(
      awaitNestedExecutionWithFailFast({
        promise: new Promise(() => {
          // never resolve
        }),
        timeoutMs: 20,
        requestId: 'req_followup_dispatch_timeout'
      })
    ).rejects.toMatchObject({
      code: 'SERVERTOOL_TIMEOUT',
      upstreamCode: 'servertool_followup_timeout',
      status: 504,
      requestExecutorProviderErrorStage: 'provider.followup'
    });
  });

  it('fails fast when client aborts after nested execute starts', async () => {
    const controller = new AbortController();
    const pending = awaitNestedExecutionWithFailFast({
      promise: new Promise(() => {
        // provider transport is still pending; abort must win immediately
      }),
      abortSignal: controller.signal,
      timeoutMs: 60_000,
      requestId: 'req_followup_dispatch_abort_after_start'
    });

    controller.abort(Object.assign(new Error('CLIENT_RESPONSE_CLOSED'), {
      code: 'CLIENT_DISCONNECTED',
      name: 'AbortError'
    }));

    await expect(pending).rejects.toMatchObject({ code: 'CLIENT_DISCONNECTED' });
  });

  it('reads timeout override from env', () => {
    process.env.ROUTECODEX_SERVERTOOL_FOLLOWUP_TIMEOUT_MS = '1234';
    try {
      expect(resolveServerToolNestedFollowupTimeoutMs()).toBe(1234);
    } finally {
      delete process.env.ROUTECODEX_SERVERTOOL_FOLLOWUP_TIMEOUT_MS;
    }
  });

  it('caps timeout override to the fail-fast ceiling', () => {
    process.env.ROUTECODEX_SERVERTOOL_FOLLOWUP_TIMEOUT_MS = '900000';
    try {
      expect(resolveServerToolNestedFollowupTimeoutMs()).toBe(10_000);
    } finally {
      delete process.env.ROUTECODEX_SERVERTOOL_FOLLOWUP_TIMEOUT_MS;
    }
  });

  it('shapes the timeout error as provider.followup fail-fast', () => {
    expect(createServerToolFollowupTimeoutError({ requestId: 'req1', timeoutMs: 99 })).toMatchObject({
      code: 'SERVERTOOL_TIMEOUT',
      upstreamCode: 'servertool_followup_timeout',
      status: 504,
      statusCode: 504,
      retryable: false,
      requestExecutorProviderErrorStage: 'provider.followup',
      details: {
        requestId: 'req1',
        timeoutMs: 99,
        reason: 'nested_followup_timeout'
      }
    });
  });
});
