/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  App,
  ProviderPage,
  RoutingPage
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
    expect(screen.queryByText('Provider Catalog')).toBeNull();
    expect(screen.queryByText('Routing')).toBeNull();
    expect(screen.queryByText('Refresh View (R)')).toBeNull();

    fireEvent.change(screen.getByLabelText('password'), { target: { value: 'setup-pass-123' } });
    fireEvent.click(screen.getByText('Setup'));
    await waitFor(() => expect(screen.getByText(/Password set and logged in\./)).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Provider Catalog')).toBeTruthy());
    expect(screen.getByText('Refresh View (R)')).toBeTruthy();

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

  it('covers provider/routing edge branches and failure paths', async () => {
    const onToast = jest.fn();
    const hasToast = (needle: string) => onToast.mock.calls.some(([msg]) => String(msg).includes(needle));

    let responseTestCalls = 0;
    let apiKeyCredentialCalls = 0;
    let routingActivateCalls = 0;

    global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const { path, method } = parseReq(input, init);

      // Provider page
      if (path === '/config/providers/v2' && method === 'GET') {
        return responseJson([
          {
            id: 'demo',
            family: 'openai',
            protocol: 'compat:passthrough',
            enabled: true,
            defaultModels: ['demo-max'],
            credentialsRef: 'authfile-demo-default',
            version: '2.0.0'
          }
        ]);
      }
      if (path === '/providers/runtimes' && method === 'GET') {
        return responseJson([
          {
            providerKey: 'demo.default.demo-max',
            runtimeKey: 'demo.default.demo-max',
            family: 'openai',
            protocol: 'compat:passthrough',
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
      if (path === '/config/providers/v2/demo' && method === 'GET') {
        return responseJson({
          version: '2.0.0',
          provider: {
            id: 'demo',
            type: 'openai',
            enabled: true,
            baseURL: 'https://example.com/v1',
            models: { 'demo-max': {} },
            auth: { type: 'apikey', apiKey: '' }
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
          return responseJson({ ok: true, secretRef: 'authfile-demo-default' });
        }
        return responseJson({ error: { message: 'apikey service down' } }, 500);
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
            default: { routing: { default: [{ targets: ['demo.default.demo-max'] }] } },
            canary: { routing: { default: [{ targets: ['demo.default.demo-max'] }] } }
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
            default: { routing: { default: [{ targets: ['demo.default.demo-max'] }] } }
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

    fireEvent.change(screen.getByLabelText('provider id'), { target: { value: 'demo' } });
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
    fireEvent.click(within(routingPanel).getByText('Activate Local'));
    await waitFor(() => expect(hasToast('activate local failed') || hasToast('No routing group selected.')).toBe(true));

    routingView.unmount();
  });

});
