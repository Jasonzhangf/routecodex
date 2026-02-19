/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  ClockPage,
  ControlPage,
  OAuthPage,
  ProviderPage,
  QuotaPage,
  RoutingPage,
  StatsPage
} from '../../webui/src/App';

type JsonRecord = Record<string, unknown>;

function installPageFetchMock() {
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
    const url = new URL(raw, 'http://localhost');
    const path = url.pathname;
    const method = (init?.method || 'GET').toUpperCase();
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const body = bodyText ? (JSON.parse(bodyText) as JsonRecord) : {};

    const json = (obj: unknown, status = 200) =>
      Promise.resolve(
        {
          ok: status >= 200 && status < 300,
          status,
          statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
          text: async () => JSON.stringify(obj)
        } as Response
      );

    if (path === '/config/providers/v2' && method === 'GET') {
      return json([
        {
          id: 'qwen',
          family: 'openai',
          protocol: 'chat:openai',
          enabled: true,
          defaultModels: ['qwen-max', 'qwen-plus'],
          credentialsRef: 'authfile-qwen-default',
          version: '2.0.0'
        }
      ]);
    }
    if (path === '/config/providers/v2/qwen' && method === 'GET') {
      return json({
        id: 'qwen',
        version: '2.0.0',
        provider: {
          id: 'qwen',
          type: 'openai',
          providerType: 'openai',
          enabled: true,
          baseURL: 'https://example.com/v1',
          compatibilityProfile: 'chat:openai',
          models: { 'qwen-max': {}, 'qwen-plus': {} },
          auth: { type: 'oauth', tokenFile: 'default' }
        }
      });
    }
    if (path === '/config/providers/v2' && method === 'POST') {
      return json({ ok: true, path: '/tmp/provider/qwen/config.v2.json' });
    }
    if (path === '/config/providers/v2/qwen' && method === 'DELETE') {
      return json({ ok: true, path: '/tmp/provider/qwen/config.v2.json' });
    }
    if (path === '/providers/runtimes' && method === 'GET') {
      return json([
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
      return json({
        providers: [
          {
            id: 'qwen',
            type: 'openai',
            enabled: true,
            baseURL: 'https://example.com/v1',
            modelCount: 2,
            modelsPreview: ['qwen-max'],
            compatibilityProfile: 'openai',
            authType: 'oauth'
          }
        ]
      });
    }
    if (path === '/config/providers/qwen' && method === 'GET') {
      return json({
        provider: {
          id: 'qwen',
          type: 'openai',
          enabled: true,
          baseURL: 'https://example.com/v1',
          models: { 'qwen-max': {}, 'qwen-plus': {} },
          auth: { type: 'oauth', tokenFile: 'default' }
        }
      });
    }
    if (path.startsWith('/config/providers/') && method === 'PUT') {
      return json({ ok: true, path: '/tmp/config.json' });
    }
    if (path.startsWith('/config/providers/') && method === 'DELETE') {
      return json({ ok: true, path: '/tmp/config.json' });
    }
    if (path === '/daemon/credentials/apikey' && method === 'POST') {
      return json({ ok: true, secretRef: `authfile-${body.provider || 'x'}-${body.alias || 'default'}` });
    }
    if (path === '/v1/responses' && method === 'POST') {
      return json({ output_text: 'pong' });
    }

    if (path === '/daemon/credentials' && method === 'GET') {
      return json([
        {
          id: 'cred-qwen',
          kind: 'oauth',
          provider: 'qwen',
          alias: 'default',
          status: 'valid',
          expiresInSec: 1200,
          secretRef: 'oauth-qwen-default'
        }
      ]);
    }
    if (path === '/quota/providers' && method === 'GET') {
      return json({
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
              url: 'https://verify.example.com',
              message: 'verify required'
            }
          }
        ]
      });
    }
    if (path === '/config/settings' && method === 'GET') {
      return json({ oauthBrowser: 'default' });
    }
    if (path === '/config/settings' && method === 'PUT') {
      return json({ ok: true });
    }
    if (path === '/daemon/oauth/authorize' && method === 'POST') {
      return json({ ok: true, tokenFile: 'qwen-default.json' });
    }
    if (path.startsWith('/daemon/credentials/') && path.endsWith('/refresh') && method === 'POST') {
      return json({ ok: true, status: 'valid', refreshed: true });
    }
    if (path === '/daemon/oauth/open' && method === 'POST') {
      return json({ ok: true });
    }

    if (path === '/config/routing/sources' && method === 'GET') {
      return json({
        activePath: '/tmp/config.json',
        sources: [{ path: '/tmp/config.json', label: '/tmp/config.json', kind: 'config', location: 'virtualrouter.routing' }]
      });
    }
    if (path === '/config/routing/groups' && method === 'GET') {
      return json({
        groups: { default: { routing: { default: [{ targets: ['qwen.default.qwen-max'] }] } } },
        activeGroupId: 'default',
        location: 'virtualrouter.routing',
        path: '/tmp/config.json'
      });
    }
    if (path.startsWith('/config/routing/groups/') && method === 'PUT') {
      return json({
        groups: { default: { routing: { default: [{ targets: ['qwen.default.qwen-max'] }] } } },
        activeGroupId: 'default',
        location: 'virtualrouter.routing',
        path: '/tmp/config.json'
      });
    }
    if (path === '/config/routing/groups/activate' && method === 'POST') {
      return json({
        groups: { default: { routing: { default: [{ targets: ['qwen.default.qwen-max'] }] } } },
        activeGroupId: 'default',
        location: 'virtualrouter.routing',
        path: '/tmp/config.json'
      });
    }
    if (path === '/daemon/control/mutate' && method === 'POST') {
      return json({ ok: true, action: body.action || 'unknown' });
    }
    if (path === '/config/routing' && method === 'GET') {
      return json({ routing: { default: [{ targets: ['qwen.default.qwen-max'] }] } });
    }

    if (path === '/daemon/stats' && method === 'GET') {
      return json({
        session: {
          totals: [
            {
              providerKey: 'qwen.default.qwen-max',
              model: 'qwen-max',
              requestCount: 9,
              errorCount: 1,
              totalPromptTokens: 100,
              totalCompletionTokens: 200,
              totalOutputTokens: 300
            }
          ]
        },
        historical: {
          totals: [
            {
              providerKey: 'qwen.default.qwen-max',
              model: 'qwen-max',
              requestCount: 99,
              errorCount: 5,
              totalPromptTokens: 1000,
              totalCompletionTokens: 2000,
              totalOutputTokens: 3000
            }
          ]
        },
        totals: {
          session: {
            requestCount: 9,
            errorCount: 1,
            totalPromptTokens: 100,
            totalCompletionTokens: 200,
            totalOutputTokens: 300
          },
          historical: {
            requestCount: 99,
            errorCount: 5,
            totalPromptTokens: 1000,
            totalCompletionTokens: 2000,
            totalOutputTokens: 3000
          }
        }
      });
    }

    if (path === '/daemon/modules/quota/refresh' && method === 'POST') return json({ ok: true });
    if (path === '/daemon/modules/quota/reset' && method === 'POST') return json({ ok: true });
    if (path === '/quota/summary' && method === 'GET') {
      return json({
        records: [
          {
            key: 'antigravity://work/gpt-4',
            remainingFraction: 0.42,
            resetAt: Date.now() + 3600_000,
            fetchedAt: Date.now()
          }
        ]
      });
    }
    if (path === '/quota/refresh' && method === 'POST') {
      return json({ ok: true, result: { refreshedAt: Date.now(), tokenCount: 1, recordCount: 1 } });
    }
    if (path.startsWith('/quota/providers/') && path.endsWith('/disable') && method === 'POST') return json({ ok: true });
    if (path.startsWith('/quota/providers/') && path.endsWith('/recover') && method === 'POST') return json({ ok: true });
    if (path.startsWith('/quota/providers/') && path.endsWith('/reset') && method === 'POST') return json({ ok: true });

    if (path === '/daemon/control/snapshot' && method === 'GET') {
      return json({
        ok: true,
        nowMs: Date.now(),
        servers: [{ port: 3000, version: 'test', ready: true, pids: [123] }],
        quota: {
          providers: [{ providerKey: 'qwen.default.qwen-max', inPool: true, reason: 'ok', cooldownUntil: null, blacklistUntil: null }]
        },
        serverTool: {
          state: { enabled: true, updatedAtMs: Date.now(), updatedBy: 'test' },
          stats: { executions: 3, success: 2, failure: 1, scannedLines: 10, byTool: [], recent: [] }
        }
      });
    }

    if (path === '/daemon/clock/tasks' && method === 'GET') {
      return json({
        tasks: [{ id: 'clock-1', status: 'scheduled', dueAtMs: Date.now() + 60_000, tool: 'mockTool', sessionId: 'session-1' }],
        records: [{ daemonId: 'd1', tmuxSessionId: 'tmux-1', heartbeatAt: Date.now(), status: 'online', lastError: '' }]
      });
    }

    return json({});
  }) as unknown as typeof fetch;
}

describe('webui page-level coverage', () => {
  const onToast = jest.fn();

  beforeEach(() => {
    onToast.mockReset();
    installPageFetchMock();
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

  it('renders and interacts with provider/oath/routing pages', async () => {
    const hasToast = (needle: string) => onToast.mock.calls.some(([msg]) => String(msg).includes(needle));
    const providerView = render(<ProviderPage authenticated authEpoch={1} apiKey="" onToast={onToast} />);
    await waitFor(() => expect(screen.getByText('Provider Pool')).toBeTruthy());
    const providerEditorPanel = screen.getByText('Provider Editor').closest('.panel') as HTMLElement;
    const modelPanel = screen.getByText('Models + Test + Authfile').closest('.panel') as HTMLElement;
    const providerIdInput = screen.getByLabelText('provider id') as HTMLInputElement;
    fireEvent.change(providerIdInput, { target: { value: 'qwen' } });
    fireEvent.click(within(providerEditorPanel).getByText('Load'));
    onToast.mockClear();
    fireEvent.click(within(providerEditorPanel).getByText('Save'));
    await waitFor(() => expect(hasToast('Provider saved.')).toBe(true));
    fireEvent.change(within(modelPanel).getByPlaceholderText('new model id'), { target: { value: 'qwen-next' } });
    fireEvent.click(within(modelPanel).getByText('Add Model'));
    onToast.mockClear();
    fireEvent.click(within(modelPanel).getByText('Test Provider (/v1/responses)'));
    await waitFor(() => expect(hasToast('Provider test passed.')).toBe(true));
    providerView.unmount();

    const oauthView = render(<OAuthPage authenticated authEpoch={1} onToast={onToast} />);
    await waitFor(() => expect(screen.getByText('OAuth Workbench')).toBeTruthy());
    const oauthPanel = screen.getByText('OAuth Workbench').closest('.panel') as HTMLElement;
    onToast.mockClear();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(hasToast('OAuth settings saved.')).toBe(true));
    const providerSelect = oauthPanel.querySelectorAll('select')[1] as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: 'antigravity' } });
    const aliasInput = oauthPanel.querySelector('input[style*="width: 180px"]') as HTMLInputElement;
    fireEvent.change(aliasInput, { target: { value: 'work' } });
    onToast.mockClear();
    fireEvent.click(within(oauthPanel).getByText('Open Verify'));
    await waitFor(() => expect(hasToast('Verify URL opened.')).toBe(true));
    oauthView.unmount();

    const routingView = render(<RoutingPage authenticated authEpoch={1} onToast={onToast} />);
    await waitFor(() => expect(screen.getByText('Routing Management')).toBeTruthy());
    routingView.unmount();
  });

  it('renders and interacts with stats/quota/control/clock pages', async () => {
    const hasToast = (needle: string) => onToast.mock.calls.some(([msg]) => String(msg).includes(needle));
    const statsView = render(<StatsPage authenticated authEpoch={1} onToast={onToast} />);
    await waitFor(() => expect(screen.getByText('Stats Management')).toBeTruthy());
    expect(screen.getByText('Token Usage (Session + Historical)')).toBeTruthy();
    statsView.unmount();

    const quotaView = render(<QuotaPage authenticated authEpoch={1} onToast={onToast} />);
    await waitFor(() => expect(screen.getByText('Quota Pool Management')).toBeTruthy());
    const quotaPanel = screen.getByText('Quota Pool Management').closest('.panel') as HTMLElement;
    fireEvent.change(within(quotaPanel).getByPlaceholderText('providerKey'), {
      target: { value: 'qwen.default.qwen-max' }
    });
    const quotaBulkRow = within(quotaPanel).getByPlaceholderText('providerKey').closest('.row') as HTMLElement;
    onToast.mockClear();
    fireEvent.click(within(quotaBulkRow).getByText('Offline'));
    await waitFor(() => expect(hasToast('disable applied.')).toBe(true));
    onToast.mockClear();
    fireEvent.click(within(screen.getByText('Antigravity Quota Snapshot').closest('.panel') as HTMLElement).getByText('Refresh Upstream Snapshot'));
    await waitFor(() => expect(hasToast('Quota snapshot refreshed.')).toBe(true));
    quotaView.unmount();

    const controlView = render(<ControlPage authenticated authEpoch={1} onToast={onToast} />);
    await waitFor(() => expect(screen.getByText('Control Plane')).toBeTruthy());
    onToast.mockClear();
    fireEvent.click(screen.getByText('Restart All Servers'));
    await waitFor(() => expect(hasToast('servers.restart done.')).toBe(true));
    controlView.unmount();

    const clockView = render(<ClockPage authenticated authEpoch={1} onToast={onToast} />);
    await waitFor(() => expect(screen.getByText('Clock Tasks')).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText('conversation session id'), { target: { value: 'session-1' } });
    fireEvent.click(screen.getByText('Refresh'));
    await waitFor(() => expect(screen.getByText(/Clock snapshot refreshed\./)).toBeTruthy());
    clockView.unmount();
  });
});
