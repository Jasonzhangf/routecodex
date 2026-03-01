/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  App,
  ClockPage,
  ControlPage,
  OAuthPage,
  ProviderPage,
  QuotaPage,
  RoutingPage,
  StatsPage
} from '../../webui/src/App';

type JsonRecord = Record<string, unknown>;

function responseJson(obj: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    text: async () => JSON.stringify(obj)
  } as Response;
}

function parseReq(input: RequestInfo | URL, init?: RequestInit) {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
  const url = new URL(raw, 'http://localhost');
  const method = (init?.method || 'GET').toUpperCase();
  const bodyText = typeof init?.body === 'string' ? init.body : '';
  const body = bodyText ? (JSON.parse(bodyText) as JsonRecord) : {};
  return { path: url.pathname, method, body };
}

describe('webui edge coverage', () => {
  beforeEach(() => {
    if (typeof globalThis.structuredClone !== 'function') {
      // @ts-expect-error test-only polyfill
      globalThis.structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
    }
    Object.defineProperty(window, 'confirm', {
      value: jest.fn(() => true),
      writable: true
    });
    Object.defineProperty(window.navigator, 'clipboard', {
      value: {
        writeText: jest.fn().mockResolvedValue(undefined)
      },
      writable: true
    });
  });

  it('covers app setup flow, API-key persistence, and auth failure branches', async () => {
    const state = {
      hasPassword: false,
      authenticated: false,
      healthCalls: 0,
      daemonStatusCalls: 0
    };

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { path, method } = parseReq(input, init);

      if (path === '/daemon/auth/status' && method === 'GET') {
        return responseJson({ ok: true, hasPassword: state.hasPassword, authenticated: state.authenticated });
      }
      if (path === '/daemon/auth/setup' && method === 'POST') {
        state.hasPassword = true;
        state.authenticated = true;
        return responseJson({ ok: true });
      }
      if (path === '/daemon/auth/login' && method === 'POST') {
        return responseJson({ error: { message: 'login denied' } }, 401);
      }
      if (path === '/daemon/auth/logout' && method === 'POST') {
        return responseJson({ error: { message: 'logout denied' } }, 500);
      }
      if (path === '/daemon/auth/change' && method === 'POST') {
        return responseJson({ error: { message: 'change denied' } }, 500);
      }
      if (path === '/health' && method === 'GET') {
        state.healthCalls += 1;
        if (state.healthCalls === 1) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => {
              throw new Error('bad json');
            },
            text: async () => '{"version":"ignored"}'
          } as Response;
        }
        return {
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          json: async () => ({})
        } as Response;
      }
      if (path === '/daemon/status' && method === 'GET') {
        state.daemonStatusCalls += 1;
        if (state.daemonStatusCalls === 1) {
          return responseJson({ error: { message: 'daemon down' } }, 500);
        }
        return responseJson({ serverId: 'edge-daemon' });
      }
      if (path === '/config/providers' && method === 'GET') {
        return responseJson({ providers: [] });
      }

      return responseJson({});
    }) as unknown as typeof fetch;

    render(<App />);

    await waitFor(() => expect(screen.getByText('Setup')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('password'), { target: { value: 'setup-pass-123' } });
    fireEvent.click(screen.getByText('Setup'));
    await waitFor(() => expect(screen.getByText(/Password set and logged in\./)).toBeTruthy());

    const apiPanel = screen.getByText('Server API Key').closest('.panel') as HTMLElement;
    fireEvent.change(within(apiPanel).getByPlaceholderText('x-api-key'), { target: { value: 'session-key' } });
    fireEvent.click(within(apiPanel).getByText('Save'));
    await waitFor(() => expect(screen.getByText(/API key saved in session\./)).toBeTruthy());

    fireEvent.click(within(apiPanel).getByText('Clear'));
    await waitFor(() => expect(screen.getByText(/API key cleared\./)).toBeTruthy());

    fireEvent.change(screen.getByLabelText('password'), { target: { value: 'wrong-pass' } });
    fireEvent.click(screen.getByText('Login'));
    await waitFor(() => expect(screen.getByText(/login denied/)).toBeTruthy());

    fireEvent.click(screen.getByText('Logout'));
    await waitFor(() => expect(screen.getByText(/logout denied/)).toBeTruthy());

    fireEvent.change(screen.getByLabelText('old'), { target: { value: 'old' } });
    fireEvent.change(screen.getByLabelText('new'), { target: { value: 'new' } });
    fireEvent.click(screen.getByText('Change Password'));
    await waitFor(() => expect(screen.getByText(/change denied/)).toBeTruthy());

    fireEvent.click(screen.getByText('Refresh Status'));
    await waitFor(() => expect(screen.getByText('serverId: edge-daemon')).toBeTruthy());
  });

  it('covers provider/oauth/routing edge branches and failure paths', async () => {
    const onToast = jest.fn();
    const hasToast = (needle: string) => onToast.mock.calls.some(([msg]) => String(msg).includes(needle));

    let responseTestCalls = 0;
    let apiKeyCredentialCalls = 0;
    let oauthQuotaCalls = 0;
    let oauthSettingsCalls = 0;
    let routingActivateCalls = 0;

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { path, method } = parseReq(input, init);

      // Provider page
      if (path === '/config/providers/v2' && method === 'GET') {
        return responseJson([
          {
            id: 'qwen',
            family: 'openai',
            protocol: 'chat:openai',
            enabled: true,
            defaultModels: ['qwen-max'],
            credentialsRef: 'authfile-qwen-default',
            version: '2.0.0'
          }
        ]);
      }
      if (path === '/providers/runtimes' && method === 'GET') {
        return responseJson([
          {
            providerKey: 'qwen.default.qwen-max',
            runtimeKey: 'qwen.default.qwen-max',
            family: 'openai',
            protocol: 'chat:openai',
            enabled: true
          }
        ]);
      }
      if (path === '/config/providers' && method === 'GET') {
        return responseJson({ providers: [] });
      }
      if (path === '/config/providers/missing' && method === 'GET') {
        return responseJson({ error: { message: 'provider not found' } }, 404);
      }
      if (path === '/config/providers/v2/qwen' && method === 'GET') {
        return responseJson({
          version: '2.0.0',
          provider: {
            id: 'qwen',
            type: 'openai',
            enabled: true,
            baseURL: 'https://example.com/v1',
            models: { 'qwen-max': {} },
            auth: { type: 'oauth', tokenFile: 'default' }
          }
        });
      }
      if (path === '/v1/responses' && method === 'POST') {
        responseTestCalls += 1;
        if (responseTestCalls === 1) {
          return {
            ok: false,
            status: 500,
            statusText: 'Error',
            text: async () => 'upstream down'
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => 'plain text without json'
        } as Response;
      }
      if (path === '/daemon/credentials/apikey' && method === 'POST') {
        apiKeyCredentialCalls += 1;
        if (apiKeyCredentialCalls === 1) {
          return responseJson({ ok: true, secretRef: 'authfile-qwen-default' });
        }
        return responseJson({ error: { message: 'apikey service down' } }, 500);
      }

      // OAuth page
      if (path === '/daemon/credentials' && method === 'GET') {
        return responseJson([
          {
            id: 'cred-qwen',
            kind: 'oauth',
            provider: 'qwen',
            alias: 'default',
            status: 'expired',
            expiresInSec: -1,
            secretRef: 'oauth-qwen-default'
          }
        ]);
      }
      if (path === '/quota/providers' && method === 'GET') {
        oauthQuotaCalls += 1;
        if (oauthQuotaCalls === 1) {
          return responseJson({ error: { message: 'quota temporary unavailable' } }, 500);
        }
        return responseJson({
          providers: [
            {
              providerKey: 'qwen.default.qwen-max',
              inPool: false,
              reason: 'authVerify',
              authIssue: {
                kind: 'google_account_verification',
                url: 'https://verify.example.com',
                message: 'verify now'
              }
            }
          ]
        });
      }
      if (path === '/config/settings' && method === 'GET') {
        oauthSettingsCalls += 1;
        if (oauthSettingsCalls === 1) {
          return responseJson({ error: { message: 'settings unavailable' } }, 500);
        }
        return responseJson({ oauthBrowser: 'default' });
      }
      if (path === '/config/settings' && method === 'PUT') {
        return responseJson({ error: { message: 'save settings failed' } }, 500);
      }
      if (path === '/daemon/oauth/authorize' && method === 'POST') {
        return responseJson({ error: { message: 'authorize failed' } }, 500);
      }
      if (path === '/daemon/credentials/cred-qwen/refresh' && method === 'POST') {
        return responseJson({ error: { message: 'refresh failed' } }, 500);
      }
      if (path === '/daemon/oauth/open' && method === 'POST') {
        return responseJson({ error: { message: 'open verify failed' } }, 500);
      }

      // Routing page
      if (path === '/config/routing/sources' && method === 'GET') {
        return responseJson({
          activePath: '/tmp/config.json',
          sources: [{ path: '/tmp/config.json', label: '/tmp/config.json', kind: 'config', location: 'virtualrouter.routing' }]
        });
      }
      if (path === '/config/routing/groups' && method === 'GET') {
        return responseJson({
          groups: {
            default: { routing: { default: [{ targets: ['qwen.default.qwen-max'] }] } },
            canary: { routing: { default: [{ targets: ['qwen.default.qwen-max'] }] } }
          },
          activeGroupId: 'default',
          location: 'virtualrouter.routing',
          path: '/tmp/config.json'
        });
      }
      if (path === '/config/routing/groups/default' && method === 'PUT') {
        return responseJson({ error: { message: 'save group failed' } }, 500);
      }
      if (path === '/config/routing/groups/canary' && method === 'DELETE') {
        return responseJson({
          groups: {
            default: { routing: { default: [{ targets: ['qwen.default.qwen-max'] }] } }
          },
          activeGroupId: 'default',
          location: 'virtualrouter.routing',
          path: '/tmp/config.json'
        });
      }
      if (path === '/config/routing/groups/activate' && method === 'POST') {
        routingActivateCalls += 1;
        if (routingActivateCalls === 1) {
          return responseJson({ error: { message: 'activate local failed' } }, 500);
        }
        return responseJson({ ok: true, activeGroupId: 'default', groups: { default: { routing: {} } }, path: '/tmp/config.json' });
      }
      if (path === '/daemon/control/mutate' && method === 'POST') {
        return responseJson({ error: { message: 'restart all failed' } }, 500);
      }

      return responseJson({});
    }) as unknown as typeof fetch;

    Object.defineProperty(window.navigator, 'clipboard', {
      value: {
        writeText: jest.fn().mockRejectedValue(new Error('clipboard denied'))
      },
      writable: true
    });

    const providerView = render(<ProviderPage authenticated authEpoch={1} apiKey="session-key" onToast={onToast} />);
    await waitFor(() => expect(screen.getByText('Provider Pool')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('provider id'), { target: { value: 'missing' } });
    onToast.mockClear();
    fireEvent.click(screen.getByText('Load'));
    await waitFor(() => expect(hasToast('provider not found')).toBe(true));

    fireEvent.change(screen.getByLabelText('provider id'), { target: { value: 'qwen' } });
    onToast.mockClear();
    fireEvent.click(screen.getByText('Test Provider (/v1/responses)'));
    await waitFor(() => expect(hasToast('HTTP 500')).toBe(true));

    onToast.mockClear();
    fireEvent.click(screen.getByText('Test Provider (/v1/responses)'));
    await waitFor(() => expect(hasToast('Provider test passed.')).toBe(true));

    const modelPanel = screen.getByText('Models + Test + Authfile').closest('.panel') as HTMLElement;
    expect((within(modelPanel).getByText('Apply to provider') as HTMLButtonElement).disabled).toBe(true);

    const passwordInput = modelPanel.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(passwordInput, { target: { value: 'secret' } });
    onToast.mockClear();
    fireEvent.click(within(modelPanel).getByText('Create authfile'));
    await waitFor(() => expect(hasToast('Authfile created.')).toBe(true));

    onToast.mockClear();
    fireEvent.click(within(modelPanel).getByText('Apply to provider'));
    await waitFor(() => expect(hasToast('secretRef applied to provider auth.')).toBe(true));

    onToast.mockClear();
    fireEvent.click(within(modelPanel).getByText('Create authfile'));
    await waitFor(() => expect(hasToast('apikey service down')).toBe(true));
    providerView.unmount();

    const oauthView = render(<OAuthPage authenticated authEpoch={1} onToast={onToast} />);
    await waitFor(() => expect(screen.getByText('OAuth Workbench')).toBeTruthy());

    const authInventoryPanel = screen.getByText('Auth Inventory').closest('.panel') as HTMLElement;
    fireEvent.click(within(authInventoryPanel).getByText('Refresh'));

    const oauthPanel = screen.getByText('OAuth Workbench').closest('.panel') as HTMLElement;
    onToast.mockClear();
    fireEvent.click(within(oauthPanel).getByText('Save'));
    await waitFor(() => expect(hasToast('save settings failed')).toBe(true));

    onToast.mockClear();
    fireEvent.click(within(oauthPanel).getByText('Start Manual Auth'));
    await waitFor(() => expect(hasToast('authorize failed')).toBe(true));

    const credRow = within(authInventoryPanel).getByText('oauth-qwen-default').closest('tr') as HTMLElement;
    const refreshButton = within(credRow).getByText('Refresh');
    onToast.mockClear();
    fireEvent.click(refreshButton);
    await waitFor(() => expect(hasToast('refresh failed')).toBe(true));

    await waitFor(() => expect(screen.getByText(/verify required:/)).toBeTruthy());
    onToast.mockClear();
    fireEvent.click(within(oauthPanel).getByText('Open Verify'));
    await waitFor(() => expect(hasToast('open verify failed')).toBe(true));

    onToast.mockClear();
    fireEvent.click(within(oauthPanel).getByText('Copy URL'));
    await waitFor(() => expect(hasToast('clipboard denied')).toBe(true));
    oauthView.unmount();

    const routingView = render(<RoutingPage authenticated authEpoch={1} onToast={onToast} />);
    await waitFor(() => expect(screen.getByText('Routing Management')).toBeTruthy());

    const routingPanel = screen.getByText('Routing Management').closest('.panel') as HTMLElement;
    const routingSelects = routingPanel.querySelectorAll('select');
    const groupSelect = routingSelects[1] as HTMLSelectElement;
    fireEvent.change(groupSelect, { target: { value: 'canary' } });
    await waitFor(() => expect(groupSelect.value).toBe('canary'));

    onToast.mockClear();
    fireEvent.click(within(routingPanel).getByText('Delete Group'));
    await waitFor(() =>
      expect(
        (global.fetch as jest.Mock).mock.calls.some(([input, init]) => {
          const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
          const url = new URL(raw, 'http://localhost');
          const method = ((init as RequestInit | undefined)?.method || 'GET').toUpperCase();
          return method === 'DELETE' && url.pathname.startsWith('/config/routing/groups/');
        })
      ).toBe(true)
    );

    onToast.mockClear();
    fireEvent.click(within(routingPanel).getByText('Save Group'));
    await waitFor(() => expect(hasToast('save group failed') || hasToast('No routing group selected.')).toBe(true));

    onToast.mockClear();
    fireEvent.click(within(routingPanel).getByText('Activate + Restart Local'));
    await waitFor(() => expect(hasToast('activate local failed') || hasToast('No routing group selected.')).toBe(true));

    onToast.mockClear();
    fireEvent.click(within(routingPanel).getByText('Activate + Restart All'));
    await waitFor(() => expect(hasToast('restart all failed') || hasToast('No routing group selected.')).toBe(true));

    fireEvent.click(within(screen.getByText('Runtime Pool Snapshot').closest('.panel') as HTMLElement).getByText('Refresh Pool'));
    routingView.unmount();
  });

  it('covers stats/quota/control/clock edge rendering and control branches', async () => {
    const onToast = jest.fn();
    const hasToast = (needle: string) => onToast.mock.calls.some(([msg]) => String(msg).includes(needle));

    let statsCalls = 0;
    let quotaDisableCalls = 0;
    let clockCalls = 0;

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { path, method, body } = parseReq(input, init);

      if (path === '/daemon/stats' && method === 'GET') {
        statsCalls += 1;
        if (statsCalls === 1) {
          return responseJson({ error: { message: 'stats down' } }, 500);
        }
        return responseJson({
          session: { totals: [{ providerKey: 'qwen.default.qwen-max', model: 'qwen-max', requestCount: 1, errorCount: 0 }] },
          historical: { totals: [] },
          totals: { session: { requestCount: 1, errorCount: 0 }, historical: { requestCount: 0, errorCount: 0 } }
        });
      }

      if (path === '/config/routing' && method === 'GET') {
        return responseJson({
          routing: {
            default: [{ targets: ['qwen.default.qwen-max', 'antigravity.work.gpt-4'] }]
          }
        });
      }
      if (path === '/daemon/modules/quota/refresh' && method === 'POST') return responseJson({ ok: true });
      if (path === '/daemon/modules/quota/reset' && method === 'POST') return responseJson({ ok: true });
      if (path === '/quota/providers' && method === 'GET') {
        return responseJson({
          providers: [
            {
              providerKey: 'qwen.default.qwen-max',
              inPool: true,
              reason: 'ok',
              cooldownUntil: null,
              blacklistUntil: null,
              consecutiveErrorCount: 0
            },
            {
              providerKey: 'antigravity.work.gpt-4',
              inPool: false,
              reason: 'authVerify',
              cooldownUntil: null,
              blacklistUntil: null,
              consecutiveErrorCount: 2,
              authIssue: {
                kind: 'google_account_verification',
                message: 'verify required'
              }
            }
          ]
        });
      }
      if (path === '/quota/summary' && method === 'GET') {
        return responseJson({
          records: [
            { key: 'antigravity://work/gpt-4', remainingFraction: 0.42, resetAt: Date.now() + 300000, fetchedAt: Date.now() },
            { key: 'antigravity://lab/gpt-5', remainingFraction: 0.73, resetAt: Date.now() + 600000, fetchedAt: Date.now() }
          ]
        });
      }
      if (path === '/quota/refresh' && method === 'POST') {
        return responseJson({ ok: true, result: { refreshedAt: Date.now(), tokenCount: 2, recordCount: 2 } });
      }
      if (path.startsWith('/quota/providers/') && path.endsWith('/disable') && method === 'POST') {
        quotaDisableCalls += 1;
        if (quotaDisableCalls === 1) {
          return responseJson({ error: { message: 'disable failed' } }, 500);
        }
        return responseJson({ ok: true, mode: body.mode || 'cooldown' });
      }
      if (path.startsWith('/quota/providers/') && path.endsWith('/recover') && method === 'POST') return responseJson({ ok: true });
      if (path.startsWith('/quota/providers/') && path.endsWith('/reset') && method === 'POST') return responseJson({ ok: true });

      if (path === '/daemon/control/snapshot' && method === 'GET') {
        return responseJson({ ok: true, nowMs: Date.now(), servers: [], quota: { providers: [] } });
      }
      if (path === '/daemon/control/mutate' && method === 'POST') {
        return responseJson({ ok: true, action: body.action || 'unknown' });
      }

      if (path === '/daemon/clock/tasks' && method === 'GET') {
        clockCalls += 1;
        if (clockCalls === 1) {
          return responseJson({
            tasks: [{ taskId: 'clock-fallback-id', status: 'scheduled', dueAt: Date.now() + 5000, tool: 'tool-a', sessionId: 'sid-a' }],
            daemonRecords: [{ daemonId: 'd-fallback', tmuxSession: 'tmux-fallback', heartbeatAtMs: Date.now(), status: 'online', lastError: '' }]
          });
        }
        return responseJson({
          sessions: [
            {
              sessionId: 'sid-a',
              taskCount: 1,
              tasks: [{ id: 'clock-session-task', status: 'scheduled', dueAtMs: Date.now() + 5000, tool: 'tool-b' }]
            }
          ],
          records: [{ daemonId: 'd-session', tmuxSessionId: 'tmux-session', heartbeatAt: Date.now(), status: 'online', lastError: '' }]
        });
      }

      return responseJson({});
    }) as unknown as typeof fetch;

    const statsView = render(<StatsPage authenticated authEpoch={1} onToast={onToast} />);
    await waitFor(() => expect(hasToast('stats down')).toBe(true));
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(screen.getByText('Session Requests')).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/auto refresh/i));
    statsView.unmount();

    const quotaView = render(<QuotaPage authenticated authEpoch={1} onToast={onToast} />);
    await waitFor(() => expect(screen.getByText('Quota Pool Management')).toBeTruthy());
    const quotaPanel = screen.getByText('Quota Pool Management').closest('.panel') as HTMLElement;

    fireEvent.click(within(quotaPanel).getByText('Select Visible'));
    const firstRowCheckbox = quotaPanel.querySelector('tbody input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(firstRowCheckbox);
    fireEvent.click(firstRowCheckbox);

    const bulkRow = within(quotaPanel).getByPlaceholderText('providerKey').closest('.row') as HTMLElement;
    fireEvent.change(within(bulkRow).getByPlaceholderText('providerKey'), { target: { value: 'qwen.default.qwen-max' } });

    const bulkSelects = bulkRow.querySelectorAll('select');
    fireEvent.change(bulkSelects[0], { target: { value: 'blacklist' } });
    fireEvent.change(bulkSelects[1], { target: { value: '5' } });

    onToast.mockClear();
    fireEvent.click(within(bulkRow).getByText('Offline'));
    await waitFor(() => expect(hasToast('disable failed')).toBe(true));

    onToast.mockClear();
    fireEvent.click(within(bulkRow).getByText('Recover'));
    await waitFor(() => expect(hasToast('recover applied.')).toBe(true));

    onToast.mockClear();
    fireEvent.click(within(bulkRow).getByText('Reset'));
    await waitFor(() => expect(hasToast('reset applied.')).toBe(true));

    fireEvent.click(within(quotaPanel).getByText('Refresh Routing Targets'));

    const snapshotPanel = screen.getByText('Antigravity Quota Snapshot').closest('.panel') as HTMLElement;
    const routedOnlyCheckbox = snapshotPanel.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(routedOnlyCheckbox);
    await waitFor(() => expect(within(snapshotPanel).getByText('work')).toBeTruthy());
    quotaView.unmount();

    const controlView = render(<ControlPage authenticated authEpoch={1} onToast={onToast} />);
    await waitFor(() => expect(screen.getByText('Control Plane')).toBeTruthy());

    const controlPanel = screen.getByText('Control Plane').closest('.panel') as HTMLElement;
    expect(within(controlPanel).getByText(/Quota actions have moved to the Quota Pool page/i)).toBeTruthy();

    onToast.mockClear();
    fireEvent.click(within(controlPanel).getByText('Refresh'));
    await waitFor(() => expect(screen.getByText('Control snapshot refreshed.')).toBeTruthy());

    onToast.mockClear();
    fireEvent.click(within(controlPanel).getByText('Refresh Quota'));
    await waitFor(() => expect(hasToast('quota.refresh done.')).toBe(true));

    onToast.mockClear();
    fireEvent.click(within(controlPanel).getByText('Restart All Servers'));
    await waitFor(() => expect(hasToast('servers.restart done.')).toBe(true));
    controlView.unmount();

    const clockView = render(<ClockPage authenticated authEpoch={1} onToast={onToast} />);
    await waitFor(() => expect(screen.getByText('Clock Tasks')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('daemon records: 1')).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText('conversation session id'), { target: { value: 'sid-a' } });
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(screen.getByText('clock-session-task')).toBeTruthy());
    clockView.unmount();
  });
});
