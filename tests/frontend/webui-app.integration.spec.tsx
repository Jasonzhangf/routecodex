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
    'provider.backup_restore',
    'provider.delete',
    'routing.port_tab_save',
    'routing.provider_picker',
    'routing.group_create_copy',
    'routing.group_save',
    'routing.activate_local',
    'forwarder.priority_save',
    'forwarder.weighted_save',
    'forwarder.roundrobin_save',
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
  let configPorts: JsonRecord[] = [];
  const configEditorSnapshot = () => ({
    ok: true,
    path: '/tmp/config.json',
    ports: configPorts,
    routingPolicyGroups: routingGroups,
    activeRoutingPolicyGroup: state.activeGroupId,
    forwarders: {
      'fwd.gpt-5.5': {
        protocol: 'openai-responses',
        model: 'gpt-5.5',
        strategy: 'priority',
        targets: [{ providerId: 'demo', priority: 100 }]
      }
    }
  });

  const state = {
    authRequired: true,
    authenticated: true,
    hasPassword: true,
    activeGroupId: 'default'
  };
  const fault = {
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
    configPorts = [
      { port: 5520, host: '0.0.0.0', mode: 'router', routingPolicyGroup: 'default', sameProtocolBehavior: 'direct' },
      { port: 5555, host: '0.0.0.0', mode: 'router', routingPolicyGroup: 'canary', sameProtocolBehavior: 'relay' }
    ];

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
    providers.set('picker', {
      id: 'picker',
      type: 'openai',
      enabled: true,
      baseURL: 'https://picker.example/v1',
      compatibilityProfile: 'openai',
      auth: { type: 'apikey', apiKey: '' },
      models: {
        'picker-model': {}
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

    state.authRequired = true;
    state.authenticated = true;
    state.hasPassword = true;
    state.activeGroupId = 'default';
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
        return json({
          ok: true,
          authRequired: state.authRequired,
          hasPassword: state.hasPassword,
          authenticated: state.authenticated
        });
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

      if (path === '/config/editor' && method === 'GET') {
        return json(configEditorSnapshot());
      }

      if (path === '/config/editor/ports' && method === 'PUT') {
        configPorts = Array.isArray(body.ports) ? body.ports as JsonRecord[] : [];
        return json(configEditorSnapshot());
      }

      if (path === '/config/editor/forwarders' && method === 'PUT') {
        const forwarders = (body.forwarders as JsonRecord) || {};
        return json({ ...configEditorSnapshot(), forwarders });
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

  it('opens admin pages without password controls when local auth is not required', async () => {
    state.authRequired = false;
    state.authenticated = false;
    state.hasPassword = true;

    render(<App />);

    await waitFor(() => expect(screen.getByText('Provider Catalog')).toBeTruthy());
    expect(screen.getByText('Local Admin Access')).toBeTruthy();
    expect(screen.getByText('auth bypass (loopback bind)')).toBeTruthy();
    expect(screen.queryByText('Admin Login')).toBeNull();
    expect(screen.queryByText('Admin Setup')).toBeNull();
    expect(screen.queryByLabelText('password')).toBeNull();
    expect(screen.getByText('Routing')).toBeTruthy();
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
    fireEvent.change(within(providerEditorPanel).getByLabelText('baseURL'), { target: { value: 'https://example.com/v1' } });
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

    fireEvent.click(within(providerEditorPanel).getByText('Backup'));
    await waitFor(() => expect(screen.getByText(/Provider backup captured\./)).toBeTruthy());
    fireEvent.change(within(providerEditorPanel).getByLabelText('baseURL'), { target: { value: 'https://changed.example/v1' } });
    fireEvent.click(within(providerEditorPanel).getByText('Restore'));
    await waitFor(() => expect(screen.getByText(/Provider restored from backup\./)).toBeTruthy());
    expect(within(providerEditorPanel).getByDisplayValue('https://example.com/v1')).toBeTruthy();
    hit('provider.backup_restore');

    fireEvent.click(within(providerEditorPanel).getByText('Delete'));
    await waitFor(() => expect(screen.getByText(/Provider deleted\./)).toBeTruthy());
    hit('provider.delete');
    // Routing page
    fireEvent.click(screen.getByText('Routing'));
    await waitFor(() => expect(screen.getByText('Routing Management')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Port Config Entries')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('5520')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('new port'), { target: { value: '7777' } });
    fireEvent.change(screen.getByLabelText('new port routing group'), { target: { value: 'canary' } });
    fireEvent.change(screen.getByLabelText('new port provider binding'), { target: { value: 'picker' } });
    fireEvent.change(screen.getByLabelText('new port same protocol'), { target: { value: 'relay' } });
    fireEvent.click(screen.getByText('Add Port Config'));
    await waitFor(() => expect(screen.getAllByText(/Port config saved\./).length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByText('7777')).toBeTruthy());
    hit('routing.port_tab_save');

    fireEvent.change(screen.getByPlaceholderText('new group id'), { target: { value: 'canary' } });
    fireEvent.click(screen.getByText('Create/Copy Group'));
    await waitFor(() => expect(screen.getByText(/Routing group created\./)).toBeTruthy());
    hit('routing.group_create_copy');

    fireEvent.change(screen.getByLabelText('provider target picker'), { target: { value: 'picker.default.picker-model' } });
    fireEvent.click(screen.getByText('Add Pool'));
    await waitFor(() => expect(screen.getAllByText('picker.default.picker-model').length).toBeGreaterThan(0));
    hit('routing.provider_picker');

    fireEvent.click(screen.getByText('Save Group'));
    await waitFor(() => expect(screen.getByText(/Routing group saved\./)).toBeTruthy());
    hit('routing.group_save');

    fireEvent.click(screen.getByText('Activate Local'));
    await waitFor(() => expect(screen.getByText(/Routing group activated locally\./)).toBeTruthy());
    hit('routing.activate_local');

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

    fireEvent.click(screen.getByText('Forwarders'));
    await waitFor(() => expect(screen.getByText('Forwarder Aggregation')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('fwd.gpt-5.5')).toBeTruthy());
    expect(screen.getByText('strategy: priority')).toBeTruthy();
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(screen.getByLabelText('forwarder strategy'), { target: { value: 'priority' } });
    fireEvent.change(screen.getByLabelText('forwarder targets'), { target: { value: 'demo:100\npicker:200' } });
    fireEvent.click(screen.getByText('Save Forwarder'));
    await waitFor(() => expect(screen.getAllByText(/Forwarder saved\./).length).toBeGreaterThan(0));
    hit('forwarder.priority_save');

    fireEvent.change(screen.getByLabelText('forwarder strategy'), { target: { value: 'weighted' } });
    fireEvent.change(screen.getByLabelText('forwarder targets'), { target: { value: 'demo:2\npicker:1' } });
    fireEvent.click(screen.getByText('Save Forwarder'));
    await waitFor(() => expect(screen.getByText('strategy: weighted')).toBeTruthy());
    hit('forwarder.weighted_save');

    fireEvent.change(screen.getByLabelText('forwarder strategy'), { target: { value: 'roundrobin' } });
    fireEvent.change(screen.getByLabelText('forwarder targets'), { target: { value: 'demo\npicker' } });
    fireEvent.click(screen.getByText('Save Forwarder'));
    await waitFor(() => expect(screen.getByText('strategy: roundrobin')).toBeTruthy());
    hit('forwarder.roundrobin_save');

    expect(covered).toEqual(new Set(requiredFeatures));

  });
});
