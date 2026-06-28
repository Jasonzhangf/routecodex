/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../../webui/src/App';

type JsonRecord = Record<string, unknown>;

describe('webui integration flows (feature coverage)', () => {
  const requiredFeatures = [
    'provider.list',
    'provider.create_save',
    'provider.test_model',
    'provider.manage_models',
    'provider.authfile_create',
    'provider.delete',
    'routing.group_create_copy',
    'routing.group_save',
    'routing.activate_local',
    'routing.activate_all',
    'stats.refresh',
    'advanced.control_restart_all',
    'auth.logout',
    'auth.login',
    'auth.change_password'
  ] as const;

  const providers = new Map<string, JsonRecord>();
  const routingGroups: Record<string, JsonRecord> = {
    default: {
      routing: {
        default: [{ targets: ['demo.default.demo-max'] }]
      },
      loadBalancing: { strategy: 'round-robin' }
    }
  };

  const state = {
    authenticated: true,
    hasPassword: true,
    activeGroupId: 'default'
  };
  const fault = {
    controlMutateFail: false,
    clockFetchFail: false
  };

  const summarizeProviderV2 = (id: string, detail: JsonRecord) => {
    const modelsNode = detail.models;
    const modelIds = modelsNode && typeof modelsNode === 'object' && !Array.isArray(modelsNode)
      ? Object.keys(modelsNode as JsonRecord)
      : [];
    const auth = detail.auth && typeof detail.auth === 'object' && !Array.isArray(detail.auth) ? (detail.auth as JsonRecord) : {};
    return {
      id,
      family: typeof detail.providerType === 'string' ? detail.providerType : typeof detail.type === 'string' ? detail.type : 'openai',
      protocol:
        typeof detail.compatibilityProfile === 'string'
          ? detail.compatibilityProfile
          : typeof detail.type === 'string'
            ? `chat:${detail.type}`
            : 'compat:passthrough',
      enabled: detail.enabled !== false,
      defaultModels: modelIds,
      credentialsRef:
        typeof auth.apiKey === 'string'
          ? auth.apiKey
          : typeof auth.tokenFile === 'string'
            ? auth.tokenFile
            : undefined,
      version: '2.0.0'
    };
  };

  beforeEach(() => {
    if (typeof globalThis.structuredClone !== 'function') {
      // jsdom runtime used by jest may not expose structuredClone.
      // Keep behavior close enough for plain JSON editor payloads.
      // @ts-expect-error test-only polyfill
      globalThis.structuredClone = (value: unknown) => JSON.parse(JSON.stringify(value));
    }

    providers.clear();

    providers.set('demo', {
      id: 'demo',
      type: 'openai',
      enabled: true,
      baseURL: 'https://example.com/v1',
      compatibilityProfile: 'openai',
      auth: { type: 'apikey', apiKey: '' },
      models: {
        'demo-max': {},
        'demo-plus': {}
      }
    });

    routingGroups.default = {
      routing: {
        default: [{ targets: ['demo.default.demo-max'] }]
      },
      loadBalancing: { strategy: 'round-robin' }
    };
    for (const key of Object.keys(routingGroups)) {
      if (key !== 'default') delete routingGroups[key];
    }

    state.authenticated = true;
    state.hasPassword = true;
    state.activeGroupId = 'default';
    fault.controlMutateFail = false;
    fault.clockFetchFail = false;

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

      if (path === '/health') return json({ version: 'test-version' });

      if (path === '/daemon/auth/status' && method === 'GET') {
        return json({ ok: true, hasPassword: state.hasPassword, authenticated: state.authenticated });
      }
      if (path === '/daemon/auth/login' && method === 'POST') {
        state.authenticated = true;
        return json({ ok: true });
      }
      if (path === '/daemon/auth/logout' && method === 'POST') {
        state.authenticated = false;
        return json({ ok: true });
      }
      if (path === '/daemon/auth/setup' && method === 'POST') {
        state.hasPassword = true;
        state.authenticated = true;
        return json({ ok: true });
      }
      if (path === '/daemon/auth/change' && method === 'POST') {
        return json({ ok: true });
      }

      if (path === '/daemon/status') {
        return json({ ok: true, serverId: 'test-server' });
      }

      if (path === '/config/providers/v2' && method === 'GET') {
        return json(Array.from(providers.entries()).map(([id, detail]) => summarizeProviderV2(id, detail)));
      }

      if (path.startsWith('/config/providers/v2/') && method === 'GET') {
        const id = decodeURIComponent(path.split('/').pop() || '');
        if (!providers.has(id)) {
          return json({ error: { message: 'not found' } }, 404);
        }
        return json({ ok: true, id, version: '2.0.0', provider: providers.get(id) });
      }

      if (path === '/config/providers/v2' && method === 'POST') {
        const id = typeof body.providerId === 'string' ? body.providerId : '';
        const detail = (body.provider as JsonRecord) || {};
        providers.set(id, detail);
        return json({ ok: true, id, path: `/tmp/provider/${id}/config.v2.json` });
      }

      if (path.startsWith('/config/providers/v2/') && method === 'DELETE') {
        const id = decodeURIComponent(path.split('/').pop() || '');
        providers.delete(id);
        return json({ ok: true, id, path: `/tmp/provider/${id}/config.v2.json` });
      }

      if (path === '/config/providers' && method === 'GET') {
        return json({ ok: true, providers: [] });
      }

      if (path.startsWith('/config/providers/') && method === 'GET') {
        const id = decodeURIComponent(path.split('/').pop() || '');
        if (!providers.has(id)) {
          return json({ error: { message: 'not found' } }, 404);
        }
        return json({ ok: true, id, provider: providers.get(id) });
      }

      if (path.startsWith('/config/providers/') && method === 'PUT') {
        const id = decodeURIComponent(path.split('/').pop() || '');
        const detail = (body.provider as JsonRecord) || {};
        providers.set(id, detail);
        return json({ ok: true, id, path: '/tmp/config.json' });
      }

      if (path.startsWith('/config/providers/') && method === 'DELETE') {
        const id = decodeURIComponent(path.split('/').pop() || '');
        providers.delete(id);
        return json({ ok: true, id, path: '/tmp/config.json' });
      }

      if (path === '/providers/runtimes' && method === 'GET') {
        const runtimes = Array.from(providers.entries()).flatMap(([id, detail]) => {
          const modelsNode = detail.models;
          const modelIds =
            modelsNode && typeof modelsNode === 'object' && !Array.isArray(modelsNode)
              ? Object.keys(modelsNode as JsonRecord)
              : [];
          if (!modelIds.length) {
            return [
              {
                providerKey: id,
                runtimeKey: id,
                family: typeof detail.providerType === 'string' ? detail.providerType : 'openai',
                protocol: typeof detail.compatibilityProfile === 'string' ? detail.compatibilityProfile : 'compat:passthrough',
                enabled: detail.enabled !== false
              }
            ];
          }
          return modelIds.map((modelId) => ({
            providerKey: `${id}.default.${modelId}`,
            runtimeKey: `${id}.default.${modelId}`,
            family: typeof detail.providerType === 'string' ? detail.providerType : 'openai',
            protocol: typeof detail.compatibilityProfile === 'string' ? detail.compatibilityProfile : 'compat:passthrough',
            enabled: detail.enabled !== false
          }));
        });
        return json(runtimes);
      }

      if (path === '/daemon/credentials/apikey' && method === 'POST') {
        return json({ ok: true, secretRef: `authfile-${body.provider || 'unknown'}-${body.alias || 'default'}` });
      }

      if (path === '/v1/responses' && method === 'POST') {
        return json({ output_text: 'pong from mock upstream' });
      }
      if (path === '/config/routing/sources' && method === 'GET') {
        return json({
          ok: true,
          activePath: '/tmp/config.json',
          sources: [{ path: '/tmp/config.json', label: '/tmp/config.json', kind: 'config', location: 'virtualrouter.routing' }]
        });
      }

      if (path === '/config/routing/groups' && method === 'GET') {
        return json({
          ok: true,
          path: '/tmp/config.json',
          groups: routingGroups,
          activeGroupId: state.activeGroupId,
          location: 'virtualrouter.routing'
        });
      }

      if (path.startsWith('/config/routing/groups/') && method === 'PUT' && !path.endsWith('/activate')) {
        const groupId = decodeURIComponent(path.split('/').pop() || 'default');
        routingGroups[groupId] = (body.policy as JsonRecord) || { routing: {} };
        return json({ ok: true, path: '/tmp/config.json', groups: routingGroups, activeGroupId: state.activeGroupId, location: 'virtualrouter.routing' });
      }

      if (path.startsWith('/config/routing/groups/') && method === 'DELETE') {
        const groupId = decodeURIComponent(path.split('/').pop() || '');
        if (groupId === state.activeGroupId) {
          return json({ error: { message: 'cannot delete active group' } }, 409);
        }
        delete routingGroups[groupId];
        return json({ ok: true, path: '/tmp/config.json', groups: routingGroups, activeGroupId: state.activeGroupId, location: 'virtualrouter.routing' });
      }

      if (path === '/config/routing/groups/activate' && method === 'POST') {
        const groupId = typeof body.groupId === 'string' ? body.groupId : 'default';
        state.activeGroupId = groupId;
        if (!routingGroups[groupId]) routingGroups[groupId] = { routing: {} };
        return json({ ok: true, groups: routingGroups, activeGroupId: state.activeGroupId, location: 'virtualrouter.routing', path: '/tmp/config.json' });
      }

      if (path === '/config/routing' && method === 'GET') {
        const active = routingGroups[state.activeGroupId] || routingGroups.default || { routing: {} };
        const routing = (active as JsonRecord).routing || {};
        return json({ ok: true, routing });
      }

      if (path === '/daemon/stats' && method === 'GET') {
        return json({
          session: {
            totals: [
              {
                providerKey: 'demo.default.demo-max',
                model: 'demo-max',
                requestCount: 10,
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
                providerKey: 'demo.default.demo-max',
                model: 'demo-max',
                requestCount: 100,
                errorCount: 3,
                totalPromptTokens: 1000,
                totalCompletionTokens: 2000,
                totalOutputTokens: 3000
              }
            ]
          },
          totals: {
            session: {
              requestCount: 10,
              errorCount: 1,
              totalPromptTokens: 100,
              totalCompletionTokens: 200,
              totalOutputTokens: 300
            },
            historical: {
              requestCount: 100,
              errorCount: 3,
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
          serverTool: {
            state: { enabled: true, updatedAtMs: Date.now(), updatedBy: 'test' },
            stats: { executions: 3, success: 2, failure: 1, scannedLines: 10, byTool: [], recent: [] }
          }
        });
      }

      if (path === '/daemon/control/mutate' && method === 'POST') {
        if (fault.controlMutateFail) {
          return json({ error: { message: 'control mutate failed' } }, 500);
        }
        return json({ ok: true, action: body.action || 'unknown' });
      }

      return json({ error: { message: `unhandled ${method} ${path}` } }, 500);
    }) as unknown as typeof fetch;
  });

  it('gates admin pages behind login when auth is required', async () => {
    state.authenticated = false;
    state.hasPassword = true;

    render(<App />);

    await waitFor(() => expect(screen.getByText('Admin Login')).toBeTruthy());
    expect(screen.getByText(/Admin authentication is required before opening any daemon management page\./)).toBeTruthy();
    expect(screen.queryByText('Provider Catalog')).toBeNull();
    expect(screen.queryByText('Routing')).toBeNull();
    expect(screen.queryByText('Refresh View (R)')).toBeNull();

    fireEvent.change(screen.getByLabelText('password'), { target: { value: 'test-pass' } });
    fireEvent.click(screen.getByText('Login'));

    await waitFor(() => expect(screen.getByText('Provider Catalog')).toBeTruthy());
    expect(screen.getByText('Refresh View (R)')).toBeTruthy();
  });

  it('covers major user flows across all tabs', async () => {
    const covered = new Set<string>();
    const hit = (feature: (typeof requiredFeatures)[number]) => covered.add(feature);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('RouteCodex WebUI V2')).toBeTruthy();
      expect(screen.getByText('Provider Pool')).toBeTruthy();
    });
    hit('provider.list');

    const panelByTitle = (title: string) => {
      const node = screen
        .getAllByText(title)
        .find((item) => item.classList.contains('card-title') || item.classList.contains('card-sub')) || screen.getAllByText(title)[0];
      const panel = node.closest('.panel');
      if (!panel) throw new Error(`panel not found for ${title}`);
      return panel as HTMLElement;
    };

    // Provider: new/save/test/delete/authfile/model manager
    const providerPoolPanel = panelByTitle('Provider Pool');
    fireEvent.click(within(providerPoolPanel).getByText('New'));

    const providerIdInput = screen.getByLabelText('provider id') as HTMLInputElement;
    fireEvent.change(providerIdInput, { target: { value: 'demo' } });

    const providerEditorPanel = panelByTitle('Provider Editor');
    const modelPanel = panelByTitle('Models + Test + Authfile');
    fireEvent.change(within(modelPanel).getByPlaceholderText('new model id'), { target: { value: 'demo-model' } });
    fireEvent.click(within(modelPanel).getByText('Add Model'));
    fireEvent.click(within(providerEditorPanel).getByText('Save'));
    await waitFor(() => expect(screen.getByText(/Provider saved\./)).toBeTruthy());
    hit('provider.create_save');

    fireEvent.click(within(modelPanel).getByText('Test Provider (/v1/responses)'));
    await waitFor(() => expect(screen.getByText(/Provider test passed\./)).toBeTruthy());
    hit('provider.test_model');

    fireEvent.change(within(modelPanel).getByPlaceholderText('new model id'), { target: { value: 'demo-model-2' } });
    fireEvent.click(within(modelPanel).getByText('Add Model'));
    hit('provider.manage_models');

    fireEvent.change(within(modelPanel).getByDisplayValue('default'), { target: { value: 'default' } });
    const apiKeyInput = modelPanel.querySelector('input[type="password"]') as HTMLInputElement;
    expect(apiKeyInput).toBeTruthy();
    fireEvent.change(apiKeyInput, { target: { value: 'secret' } });
    fireEvent.click(within(modelPanel).getByText('Create authfile'));
    await waitFor(() => expect(screen.getByText(/Authfile created\./)).toBeTruthy());
    fireEvent.click(within(modelPanel).getByText('Apply to provider'));
    await waitFor(() => expect(screen.getByText(/secretRef applied to provider auth\./)).toBeTruthy());
    hit('provider.authfile_create');

    fireEvent.click(within(providerEditorPanel).getByText('Delete'));
    await waitFor(() => expect(screen.getByText(/Provider deleted\./)).toBeTruthy());
    hit('provider.delete');
    // Routing page
    fireEvent.click(screen.getByText('Routing'));
    await waitFor(() => expect(screen.getByText('Routing Management')).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText('new group id'), { target: { value: 'canary' } });
    fireEvent.click(screen.getByText('Create/Copy Group'));
    await waitFor(() => expect(screen.getByText(/Routing group created\./)).toBeTruthy());
    hit('routing.group_create_copy');

    fireEvent.click(screen.getByText('Save Group'));
    await waitFor(() => expect(screen.getByText(/Routing group saved\./)).toBeTruthy());
    hit('routing.group_save');

    fireEvent.click(screen.getByText('Activate + Restart Local'));
    await waitFor(() => expect(screen.getByText(/Routing group activated locally\./)).toBeTruthy());
    hit('routing.activate_local');

    fireEvent.click(screen.getByText('Activate + Restart All'));
    await waitFor(() => expect(screen.getByText(/Restart-all requested\./)).toBeTruthy());
    hit('routing.activate_all');

    // Stats page
    fireEvent.click(screen.getByText('Ops'));
    fireEvent.click(screen.getByText('Stats'));
    await waitFor(() => expect(screen.getByText('Stats Management')).toBeTruthy());
    fireEvent.click(within(panelByTitle('Stats Management')).getByText('Refresh'));
    hit('stats.refresh');

    // Quota page
    // Ops / Control Plane
    fireEvent.click(screen.getByText('Ops'));
    fireEvent.click(screen.getByText('Control Plane'));
    await waitFor(() => expect(panelByTitle('Control Plane')).toBeTruthy());
    const controlPanel = panelByTitle('Control Plane');

    fireEvent.click(within(controlPanel).getByText('Restart All Servers'));
    await waitFor(() => expect(screen.getByText(/servers\.restart done\./)).toBeTruthy());
    hit('advanced.control_restart_all');

    // Auth flows: logout + login + change password
    fireEvent.click(screen.getByText('Logout'));
    await waitFor(() => expect(screen.getByText(/Logged out\./)).toBeTruthy());
    hit('auth.logout');

    fireEvent.change(screen.getByLabelText('password'), { target: { value: 'test-password' } });
    fireEvent.click(screen.getByText('Login'));
    await waitFor(() => expect(screen.getByText(/Logged in\./)).toBeTruthy());
    hit('auth.login');

    fireEvent.change(screen.getByLabelText('old'), { target: { value: 'old' } });
    fireEvent.change(screen.getByLabelText('new'), { target: { value: 'new' } });
    fireEvent.click(screen.getByText('Change Password'));
    await waitFor(() => expect(screen.getByText(/Password changed\./)).toBeTruthy());
    hit('auth.change_password');

    const functionalCoverage = covered.size / requiredFeatures.length;
    expect(functionalCoverage).toBeGreaterThanOrEqual(0.9);
  });

  it('covers validation and failure branches across pages', async () => {
    fault.controlMutateFail = true;
    fault.clockFetchFail = true;

    render(<App />);
    await waitFor(() => expect(screen.getByText('Provider Pool')).toBeTruthy());

    const panelByTitle = (title: string) => {
      const node = screen
        .getAllByText(title)
        .find((item) => item.classList.contains('card-title') || item.classList.contains('card-sub')) || screen.getAllByText(title)[0];
      const panel = node.closest('.panel');
      if (!panel) throw new Error(`panel not found for ${title}`);
      return panel as HTMLElement;
    };

    const providerPoolPanel = panelByTitle('Provider Pool');
    fireEvent.click(within(providerPoolPanel).getByText('New'));

    const providerEditorPanel = panelByTitle('Provider Editor');
    fireEvent.click(within(providerEditorPanel).getByText('Save'));
    await waitFor(() => expect(screen.getByText(/provider id is required/i)).toBeTruthy());

    const providerIdInput = screen.getByLabelText('provider id') as HTMLInputElement;
    const modelPanel = panelByTitle('Models + Test + Authfile');
    fireEvent.change(providerIdInput, { target: { value: '' } });
    fireEvent.click(within(modelPanel).getByText('Create authfile'));
    await waitFor(() => expect(screen.getByText(/provider id is required before creating authfile/i)).toBeTruthy());

    fireEvent.change(providerIdInput, { target: { value: 'demo' } });
    fireEvent.click(within(modelPanel).getByText('Create authfile'));
    await waitFor(() => expect(screen.getByText(/api key is required/i)).toBeTruthy());
    expect((within(modelPanel).getByText('Apply to provider') as HTMLButtonElement).disabled).toBe(true);
    const routingPanel = panelByTitle('Routing Management');
    fireEvent.click(screen.getByText('Create/Copy Group'));
    await waitFor(() => expect(screen.getByText(/new group id is required/i)).toBeTruthy());
    fireEvent.click(within(routingPanel).getByText('Add Route'));
    await waitFor(() => expect(screen.getByText(/route name is required/i)).toBeTruthy());
    fireEvent.click(within(routingPanel).getByText('Remove Route'));
    fireEvent.click(within(routingPanel).getByText('Save Group'));
    await waitFor(() => expect(screen.getByText(/At least one route is required before save\./i)).toBeTruthy());
    fireEvent.change(within(routingPanel).getByPlaceholderText('route name (e.g. default / coding / tools)'), {
      target: { value: 'default' }
    });
    fireEvent.click(within(routingPanel).getByText('Add Route'));
    fireEvent.click(within(routingPanel).getByText('Add Pool'));
    await waitFor(() => expect(screen.getByText(/at least one target is required|select a route first/i)).toBeTruthy());
    fireEvent.click(screen.getByText('Delete Group'));
    await waitFor(() => expect(screen.getAllByText(/cannot delete active group/i).length).toBeGreaterThan(0));

    fireEvent.click(screen.getByText('Ops'));
    fireEvent.click(screen.getByText('Control Plane'));
    await waitFor(() => expect(panelByTitle('Control Plane')).toBeTruthy());
    fireEvent.click(within(panelByTitle('Control Plane')).getByText('Restart All Servers'));
    await waitFor(() => expect(screen.getAllByText(/control mutate failed/i).length).toBeGreaterThan(0));

  });
});
