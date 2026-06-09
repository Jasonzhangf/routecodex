import { describe, expect, test } from '@jest/globals';

import {
  createClientDisconnectWatcher,
  createServerToolClientDisconnectedError,
  createServerToolTimeoutError,
  createStopMessageFetchFailedError,
  isAdapterClientDisconnected,
  isServerToolClientDisconnectedError,
  withTimeout
} from '../../sharedmodule/llmswitch-core/src/servertool/timeout-error-block.js';

describe('servertool timeout/error block native shell', () => {
  test('reads adapter disconnect state through native policy', () => {
    expect(isAdapterClientDisconnected({ clientConnectionState: { disconnected: ' TRUE ' } } as any)).toBe(true);
    expect(isAdapterClientDisconnected({ clientDisconnected: true } as any)).toBe(true);
    expect(isAdapterClientDisconnected({ clientDisconnected: 'false' } as any)).toBe(false);
  });

  test('uses Rust timeout watcher plan before arming timer', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 0, () => new Error('timeout'))).resolves.toBe('ok');
    await expect(
      withTimeout(new Promise((resolve) => setTimeout(resolve, 40)), 5.9, () => new Error('timeout'))
    ).rejects.toThrow('timeout');
  });

  test('plans client disconnect errors through native contract', () => {
    const error = createServerToolClientDisconnectedError({
      requestId: ' req-1 ',
      flowId: ' flow-1 '
    });

    expect(isServerToolClientDisconnectedError(error)).toBe(true);
    expect(error.message).toBe('[servertool] client disconnected during followup flow=flow-1');
    expect((error as any).details).toEqual({ requestId: 'req-1', flowId: 'flow-1' });
  });

  test('plans timeout and stop-message fetch errors through native contract', () => {
    const timeout = createServerToolTimeoutError({
      requestId: 'req-2',
      phase: 'followup',
      timeoutMs: 1000.9,
      flowId: 'web_search_flow',
      attempt: 2.2,
      maxAttempts: 3.8
    });
    expect(timeout.status).toBe(504);
    expect(timeout.message).toBe('[servertool] followup timeout after 1000ms flow=web_search_flow');
    expect((timeout as any).details).toEqual({
      requestId: 'req-2',
      flowId: 'web_search_flow',
      phase: 'followup',
      timeoutMs: 1000,
      attempt: 2,
      maxAttempts: 3
    });

    const fetchFailed = createStopMessageFetchFailedError({
      requestId: 'req-3',
      reason: 'loop_limit',
      elapsedMs: -5,
      repeatCount: 4.7,
      attempt: 0,
      maxAttempts: 5.9
    });
    expect(fetchFailed.status).toBe(502);
    expect(fetchFailed.message).toBe('fetch failed: network error (stopMessage loop detected)');
    expect((fetchFailed as any).details).toEqual({
      requestId: 'req-3',
      reason: 'loop_limit',
      elapsedMs: 0,
      repeatCount: 4,
      attempt: 1,
      maxAttempts: 5
    });
  });

  test('client disconnect watcher consumes native interval plan', async () => {
    const adapterContext = { clientDisconnected: false } as any;
    const watcher = createClientDisconnectWatcher({
      adapterContext,
      requestId: 'req-4',
      pollIntervalMs: 1
    });
    setTimeout(() => {
      adapterContext.clientDisconnected = true;
    }, 5);
    await expect(watcher.promise).rejects.toMatchObject({
      code: 'SERVERTOOL_CLIENT_DISCONNECTED'
    });
  });
});
