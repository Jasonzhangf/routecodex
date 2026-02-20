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
    'oauth.settings_save',
    'oauth.auto_authorize',
    'oauth.verify_open',
    'routing.group_create_copy',
    'routing.group_save',
    'routing.activate_local',
    'routing.activate_all',
    'stats.refresh',
    'quota.pool_refresh',
    'quota.provider_offline',
    'quota.provider_recover',
    'quota.provider_reset',
    'quota.snapshot_refresh',
    'advanced.control_restart_all',
    'advanced.control_quota_offline',
    'advanced.clock_refresh',
    'auth.logout',
    'auth.login',
    'auth.change_password'
  ] as const;

  const providers = new Map<string, JsonRecord>();
  const routingGroups: Record<string, JsonRecord> = {
    default: {
      routing: {
        default: [{ targets: ['qwen.default.qwen-max'] }]
      },
      loadBalancing: { strategy: 'round-robin' }
    }
  };

  const state = {
    authenticated: true,
    hasPassword: true,
    oauthBrowser: 'default',
    activeGroupId: 'default',
    quotaProviders: [
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
    ],
    credentials: [
      {
        id: 'cred-qwen',
        kind: 'oauth',
        provider: 'qwen',
        alias: 'default',
        status: 'valid',
        expiresInSec: 3600,
        secretRef: 'oauth-qwen-default'
      },
      {
        id: 'cred-antigravity',
        kind: 'oauth',
        provider: 'antigravity',
        alias: 'work',
        status: 'expired',
        expiresInSec: -1,
        secretRef: 'oauth-antigravity-work'
      }
    ]
  };
  const fault = {
    quotaRefresh404: false,
    controlMutateFail: false,
    clockFetchFail: false
  };
  const metrics = {
    quotaResetCalls: 0
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
            : 'chat:openai',
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

    providers.set('qwen', {
      id: 'qwen',
      type: 'openai',
      enabled: true,
      baseURL: 'https://example.com/v1',
      compatibilityProfile: 'openai',
      auth: { type: 'oauth', tokenFile: 'default' },
      models: {
        'qwen-max': {},
        'qwen-plus': {}
      }
    });

    routingGroups.default = {
      routing: {
        default: [{ targets: ['qwen.default.qwen-max'] }]
      },
      loadBalancing: { strategy: 'round-robin' }
    };
    for (const key of Object.keys(routingGroups)) {
      if (key !== 'default') delete routingGroups[key];
    }

    state.authenticated = true;
    state.hasPassword = true;
    state.oauthBrowser = 'default';
    state.activeGroupId = 'default';

    state.quotaProviders = [
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
    ];

    state.credentials = [
      {
        id: 'cred-qwen',
        kind: 'oauth',
        provider: 'qwen',
        alias: 'default',
        status: 'valid',
        expiresInSec: 3600,
        secretRef: 'oauth-qwen-default'
      },
      {
        id: 'cred-antigravity',
        kind: 'oauth',
        provider: 'antigravity',
        alias: 'work',
        status: 'expired',
        expiresInSec: -1,
        secretRef: 'oauth-antigravity-work'
      }
    ];
    fault.quotaRefresh404 = false;
    fault.controlMutateFail = false;
    fault.clockFetchFail = false;
    metrics.quotaResetCalls = 0;

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
                protocol: typeof detail.compatibilityProfile === 'string' ? detail.compatibilityProfile : 'chat:openai',
                enabled: detail.enabled !== false
              }
            ];
          }
          return modelIds.map((modelId) => ({
            providerKey: `${id}.default.${modelId}`,
            runtimeKey: `${id}.default.${modelId}`,
            family: typeof detail.providerType === 'string' ? detail.providerType : 'openai',
            protocol: typeof detail.compatibilityProfile === 'string' ? detail.compatibilityProfile : 'chat:openai',
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

      if (path === '/daemon/credentials' && method === 'GET') {
        return json(state.credentials);
      }

      if (path === '/config/settings' && method === 'GET') {
        return json({ oauthBrowser: state.oauthBrowser });
      }
      if (path === '/config/settings' && method === 'PUT') {
        state.oauthBrowser = typeof body.oauthBrowser === 'string' ? body.oauthBrowser : state.oauthBrowser;
        return json({ ok: true, oauthBrowser: state.oauthBrowser });
      }

      if (path === '/daemon/oauth/authorize' && method === 'POST') {
        return json({ ok: true, tokenFile: `${body.provider || 'provider'}-${body.alias || 'default'}.json` });
      }

      if (path.startsWith('/daemon/credentials/') && path.endsWith('/refresh') && method === 'POST') {
        const id = decodeURIComponent(path.split('/')[3] || '');
        const item = state.credentials.find((x) => x.id === id);
        if (item) {
          item.status = 'valid';
          item.expiresInSec = 3600;
        }
        return json({ ok: true, status: 'valid', refreshed: true });
      }

      if (path === '/daemon/oauth/open' && method === 'POST') {
        return json({ ok: true });
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

      if (path === '/daemon/modules/quota/refresh' && method === 'POST') {
        if (fault.quotaRefresh404) {
          return json({ error: { message: 'quota refresh endpoint missing' } }, 404);
        }
        return json({ ok: true });
      }
      if (path === '/daemon/modules/quota/reset' && method === 'POST') {
        metrics.quotaResetCalls += 1;
        return json({ ok: true });
      }

      if (path === '/quota/providers' && method === 'GET') {
        return json({ ok: true, providers: state.quotaProviders });
      }

      if (path.startsWith('/quota/providers/') && path.endsWith('/disable') && method === 'POST') {
        const key = decodeURIComponent(path.split('/')[3] || '');
        const target = state.quotaProviders.find((x) => x.providerKey === key);
        if (target) {
          target.inPool = false;
          target.reason = typeof body.mode === 'string' ? body.mode : 'cooldown';
        }
        return json({ ok: true });
      }
      if (path.startsWith('/quota/providers/') && path.endsWith('/recover') && method === 'POST') {
        const key = decodeURIComponent(path.split('/')[3] || '');
        const target = state.quotaProviders.find((x) => x.providerKey === key);
        if (target) {
          target.inPool = true;
          target.reason = 'ok';
        }
        return json({ ok: true });
      }
      if (path.startsWith('/quota/providers/') && path.endsWith('/reset') && method === 'POST') {
        return json({ ok: true });
      }

      if (path === '/quota/summary' && method === 'GET') {
        return json({
          ok: true,
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

      if (path === '/daemon/stats' && method === 'GET') {
        return json({
          session: {
            totals: [
              {
                providerKey: 'qwen.default.qwen-max',
                model: 'qwen-max',
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
                providerKey: 'qwen.default.qwen-max',
                model: 'qwen-max',
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
          quota: {
            providers: state.quotaProviders
          },
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

      if (path === '/daemon/clock/tasks' && method === 'GET') {
        if (fault.clockFetchFail) {
          return json({ error: { message: 'clock fetch failed' } }, 500);
        }
        return json({
          sessions: [
            {
              sessionId: 'session-1',
              taskCount: 1,
              tasks: [
                {
                  id: 'clock-1',
                  status: 'scheduled',
                  dueAtMs: Date.now() + 60_000,
                  tool: 'mockTool'
                }
              ]
            }
          ],
          records: [
            {
              daemonId: 'd1',
              tmuxSessionId: 'tmux-1',
              heartbeatAt: Date.now(),
              status: 'online',
              lastError: ''
            }
          ]
        });
      }

      return json({ error: { message: `unhandled ${method} ${path}` } }, 500);
    }) as unknown as typeof fetch;
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

    // OAuth page
    fireEvent.click(screen.getByText('OAuth & Credentials'));
    await waitFor(() => expect(screen.getByText('Auth Inventory')).toBeTruthy());

    const oauthPanel = panelByTitle('OAuth Workbench');
    const oauthBrowserSelect = oauthPanel.querySelector('select') as HTMLSelectElement;
    expect(oauthBrowserSelect).toBeTruthy();
    fireEvent.change(oauthBrowserSelect, { target: { value: 'camoufox' } });
    fireEvent.click(within(oauthPanel).getByText('Save'));
    await waitFor(() => expect(screen.getByText(/OAuth settings saved\./)).toBeTruthy());
    hit('oauth.settings_save');

    fireEvent.click(within(oauthPanel).getByText('Auto Auth'));
    const oauthProviderSelect = oauthPanel.querySelectorAll('select')[1] as HTMLSelectElement;
    expect(oauthProviderSelect).toBeTruthy();
    fireEvent.change(oauthProviderSelect, { target: { value: 'antigravity' } });
    const oauthAliasInput = oauthPanel.querySelector('input[style*="width: 180px"]') as HTMLInputElement;
    expect(oauthAliasInput).toBeTruthy();
    fireEvent.change(oauthAliasInput, { target: { value: 'work' } });
    fireEvent.click(within(oauthPanel).getByText('Start Auto Auth'));
    await waitFor(() => expect(screen.getByText(/OAuth authorize started\./)).toBeTruthy());
    hit('oauth.auto_authorize');

    fireEvent.click(within(oauthPanel).getByText('Open Verify'));
    await waitFor(() => expect(screen.getByText(/Verify URL opened\./)).toBeTruthy());
    hit('oauth.verify_open');

    // Routing page
    fireEvent.click(screen.getByText('Routing & Capacity'));
    fireEvent.click(screen.getByText('Routing Groups'));
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
    fireEvent.click(screen.getByText('Routing & Capacity'));
    fireEvent.click(screen.getByText('Quota Pool'));
    await waitFor(() => expect(screen.getByText('Quota Pool Management')).toBeTruthy());
    const quotaPanel = panelByTitle('Quota Pool Management');

    fireEvent.click(within(quotaPanel).getByText('Refresh Provider Pool'));
    await waitFor(() => expect(within(quotaPanel).getByText(/Quota providers refreshed\./)).toBeTruthy());
    hit('quota.pool_refresh');
    const quotaBulkRow = within(quotaPanel).getByPlaceholderText('providerKey').closest('.row') as HTMLElement;
    expect(quotaBulkRow).toBeTruthy();
    fireEvent.change(within(quotaBulkRow).getByPlaceholderText('providerKey'), {
      target: { value: 'qwen.default.qwen-max' }
    });
    fireEvent.click(within(quotaBulkRow).getByText('Offline'));
    await waitFor(() => expect(screen.getByText(/disable applied\./)).toBeTruthy());
    hit('quota.provider_offline');

    fireEvent.click(within(quotaBulkRow).getByText('Recover'));
    await waitFor(() => expect(screen.getByText(/recover applied\./)).toBeTruthy());
    hit('quota.provider_recover');

    fireEvent.click(within(quotaBulkRow).getByText('Reset'));
    await waitFor(() => expect(screen.getByText(/reset applied\./)).toBeTruthy());
    hit('quota.provider_reset');

    fireEvent.click(within(panelByTitle('Antigravity Quota Snapshot')).getByText('Refresh Upstream Snapshot'));
    await waitFor(() => expect(screen.getByText(/Quota snapshot refreshed\./)).toBeTruthy());
    hit('quota.snapshot_refresh');

    // Ops / Control Plane
    fireEvent.click(screen.getByText('Ops'));
    fireEvent.click(screen.getByText('Control Plane'));
    await waitFor(() => expect(panelByTitle('Control Plane')).toBeTruthy());
    const controlPanel = panelByTitle('Control Plane');

    fireEvent.click(within(controlPanel).getByText('Restart All Servers'));
    await waitFor(() => expect(screen.getByText(/servers\.restart done\./)).toBeTruthy());
    hit('advanced.control_restart_all');

    fireEvent.change(within(controlPanel).getByPlaceholderText('providerKey'), {
      target: { value: 'qwen.default.qwen-max' }
    });
    fireEvent.click(within(controlPanel).getByText('Offline'));
    await waitFor(() => expect(screen.getByText(/quota\.disable done\./)).toBeTruthy());
    hit('advanced.control_quota_offline');

    // Ops / Clock
    fireEvent.click(screen.getByText('Clock'));
    await waitFor(() => expect(screen.getByText('Clock Tasks')).toBeTruthy());
    fireEvent.click(within(panelByTitle('Clock Tasks')).getByText('Refresh'));
    await waitFor(() => expect(screen.getByText(/Clock snapshot refreshed\./)).toBeTruthy());
    await waitFor(() => expect(screen.getByText('clock-1')).toBeTruthy());
    hit('advanced.clock_refresh');

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
    fault.quotaRefresh404 = true;
    fault.controlMutateFail = true;
    fault.clockFetchFail = true;
    state.quotaProviders = [
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
    ];

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

    fireEvent.click(screen.getByText('OAuth & Credentials'));
    await waitFor(() => expect(screen.getByText('OAuth Workbench')).toBeTruthy());
    const oauthPanel = panelByTitle('OAuth Workbench');
    const providerSelect = oauthPanel.querySelectorAll('select')[1] as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: 'antigravity' } });
    const aliasInput = oauthPanel.querySelector('input[style*="width: 180px"]') as HTMLInputElement;
    fireEvent.change(aliasInput, { target: { value: 'work' } });
    fireEvent.click(within(oauthPanel).getByText('Open Verify'));
    await waitFor(() => expect(screen.getByText(/No verify URL available\./i)).toBeTruthy());
    fireEvent.click(within(oauthPanel).getByText('Copy URL'));
    await waitFor(() => expect(screen.getByText(/No verify URL available\./i)).toBeTruthy());

    fireEvent.click(screen.getByText('Routing & Capacity'));
    fireEvent.click(screen.getByText('Routing Groups'));
    await waitFor(() => expect(screen.getByText('Routing Management')).toBeTruthy());
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

    fireEvent.click(screen.getByText('Routing & Capacity'));
    fireEvent.click(screen.getByText('Quota Pool'));
    await waitFor(() => expect(screen.getByText('Quota Pool Management')).toBeTruthy());
    const quotaPanel = panelByTitle('Quota Pool Management');
    fireEvent.click(within(quotaPanel).getByText('Refresh Provider Pool'));
    await waitFor(() => expect(metrics.quotaResetCalls).toBeGreaterThan(0));
    const bulkRow = within(quotaPanel).getByPlaceholderText('providerKey').closest('.row') as HTMLElement;
    fireEvent.change(within(bulkRow).getByPlaceholderText('providerKey'), { target: { value: '' } });
    fireEvent.click(within(bulkRow).getByText('Offline'));
    await waitFor(() => expect(screen.getByText(/providerKey required or select rows/i)).toBeTruthy());

    fireEvent.click(screen.getByText('Ops'));
    fireEvent.click(screen.getByText('Control Plane'));
    await waitFor(() => expect(panelByTitle('Control Plane')).toBeTruthy());
    fireEvent.click(within(panelByTitle('Control Plane')).getByText('Restart All Servers'));
    await waitFor(() => expect(screen.getAllByText(/control mutate failed/i).length).toBeGreaterThan(0));

    fireEvent.click(screen.getByText('Clock'));
    await waitFor(() => expect(screen.getByText('Clock Tasks')).toBeTruthy());
    fireEvent.click(within(panelByTitle('Clock Tasks')).getByText('Refresh'));
    await waitFor(() => expect(screen.getAllByText(/clock fetch failed/i).length).toBeGreaterThan(0));
  });
});
