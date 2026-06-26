/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  ControlPage,
  OAuthPage,
  ProviderPage,
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
          protocol: 'compat:passthrough',
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
          compatibilityProfile: 'compat:passthrough',
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
          protocol: 'compat:passthrough',
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
    oauthView.unmount();

    const routingView = render(<RoutingPage authenticated authEpoch={1} onToast={onToast} />);
    await waitFor(() => expect(screen.getByText('Routing Management')).toBeTruthy());
    routingView.unmount();
  });

  it('renders and interacts with stats/control pages', async () => {
    const hasToast = (needle: string) => onToast.mock.calls.some(([msg]) => String(msg).includes(needle));
    const statsView = render(<StatsPage authenticated authEpoch={1} onToast={onToast} />);
    await waitFor(() => expect(screen.getByText('Stats Management')).toBeTruthy());
    expect(screen.getByText('Token Usage (Session + Historical)')).toBeTruthy();
    statsView.unmount();

    const controlView = render(<ControlPage authenticated authEpoch={1} onToast={onToast} />);
    await waitFor(() => expect(screen.getByText('Control Plane')).toBeTruthy());
    onToast.mockClear();
    fireEvent.click(screen.getByText('Restart All Servers'));
    await waitFor(() => expect(hasToast('servers.restart done.')).toBe(true));
    controlView.unmount();

});
