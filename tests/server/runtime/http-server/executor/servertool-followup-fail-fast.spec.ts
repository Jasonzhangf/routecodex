import { describe, expect, it } from '@jest/globals';
import {
  awaitNestedExecutionWithFailFast
} from '../../../../../src/server/runtime/http-server/executor/servertool-followup-fail-fast.js';

describe('servertool followup fail-fast helper', () => {
  it('resolves normally when nested execute completes and no abort is triggered', async () => {
    await expect(
      awaitNestedExecutionWithFailFast({
        promise: Promise.resolve('ok')
      })
    ).resolves.toBe('ok');
  });

  it('fails fast when client aborts after nested execute starts', async () => {
    const controller = new AbortController();
    const pending = awaitNestedExecutionWithFailFast({
      promise: new Promise(() => {
        // provider transport is still pending; abort must win immediately
      }),
      abortSignal: controller.signal,
      abortCarrier: undefined
    });

    controller.abort(Object.assign(new Error('CLIENT_RESPONSE_CLOSED'), {
      code: 'CLIENT_DISCONNECTED',
      name: 'AbortError'
    }));

    await expect(pending).rejects.toMatchObject({ code: 'CLIENT_DISCONNECTED' });
  });
});
