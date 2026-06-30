import { describe, expect, test } from '@jest/globals';

import {
  createServerToolClientDisconnectedError,
  createServerToolTimeoutError,
  isAdapterClientDisconnected,
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

    expect((error as any).code).toBe('SERVERTOOL_CLIENT_DISCONNECTED');
    expect(error.message).toBe('[servertool] client disconnected during followup flow=flow-1');
    expect((error as any).details).toEqual({ requestId: 'req-1', flowId: 'flow-1' });
  });

  test('plans timeout errors through native contract', () => {
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
  });
});
