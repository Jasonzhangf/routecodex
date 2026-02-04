import { describe, expect, test, jest } from '@jest/globals';

import { BaseOAuthFlowStrategy } from '../../../../src/providers/core/config/oauth-flows.js';

class TestStrategy extends BaseOAuthFlowStrategy {
  async authenticate(): Promise<Record<string, unknown>> {
    return {};
  }
  async refreshToken(): Promise<Record<string, unknown>> {
    return {};
  }
  getFlowType(): any {
    return 'device_code';
  }
  public async runWait(url: string): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    return (this as any).waitForPortalReady(url);
  }
}

function makeConfig(): any {
  return {
    flowType: 'device_code',
    activationType: 'auto_browser',
    endpoints: { deviceCodeUrl: 'https://x/device', tokenUrl: 'https://x/token' },
    client: { clientId: 'test' },
    headers: {}
  };
}

describe('OAuth portal readiness timeout', () => {
  test('waitForPortalReady respects configurable total timeout (does not hardcode ~3s)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const prevTotal = process.env.ROUTECODEX_OAUTH_PORTAL_READY_TIMEOUT_MS;
    const prevPoll = process.env.ROUTECODEX_OAUTH_PORTAL_READY_POLL_MS;
    const prevReq = process.env.ROUTECODEX_OAUTH_PORTAL_READY_REQUEST_TIMEOUT_MS;

    process.env.ROUTECODEX_OAUTH_PORTAL_READY_TIMEOUT_MS = '2000';
    process.env.ROUTECODEX_OAUTH_PORTAL_READY_POLL_MS = '1000';
    process.env.ROUTECODEX_OAUTH_PORTAL_READY_REQUEST_TIMEOUT_MS = '10';

    const fetchMock = jest.fn(async () => {
      throw new Error('nope');
    });
    // @ts-expect-error override fetch for test
    const prevFetch = globalThis.fetch;
    // @ts-expect-error override fetch for test
    globalThis.fetch = fetchMock;

    jest.useFakeTimers();
    const strategy = new TestStrategy(makeConfig(), fetchMock as any);
    const p = strategy.runWait('http://127.0.0.1:9999/token-auth/demo?x=1');
    // advance time: 2 seconds total should cause ~2 attempts (at t=0 and t=1000) then exit
    await jest.advanceTimersByTimeAsync(2500);
    await p;

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(4);

    jest.useRealTimers();
    // restore fetch + env
    // @ts-expect-error restore fetch
    globalThis.fetch = prevFetch;
    if (prevTotal === undefined) delete process.env.ROUTECODEX_OAUTH_PORTAL_READY_TIMEOUT_MS;
    else process.env.ROUTECODEX_OAUTH_PORTAL_READY_TIMEOUT_MS = prevTotal;
    if (prevPoll === undefined) delete process.env.ROUTECODEX_OAUTH_PORTAL_READY_POLL_MS;
    else process.env.ROUTECODEX_OAUTH_PORTAL_READY_POLL_MS = prevPoll;
    if (prevReq === undefined) delete process.env.ROUTECODEX_OAUTH_PORTAL_READY_REQUEST_TIMEOUT_MS;
    else process.env.ROUTECODEX_OAUTH_PORTAL_READY_REQUEST_TIMEOUT_MS = prevReq;

    warn.mockRestore();
  });
});
