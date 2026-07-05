/** @jest-environment jsdom */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  ProviderPage,
  RoutingPage
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
          id: 'demo',
          family: 'openai',
          protocol: 'compat:passthrough',
          enabled: true,
          defaultModels: ['demo-max', 'demo-plus'],
          credentialsRef: 'authfile-demo-default',
          version: '2.0.0'
        }
      ]);
    }
    if (path === '/config/providers/v2/demo' && method === 'GET') {
      return json({
        id: 'demo',
        version: '2.0.0',
        provider: {
          id: 'demo',
          type: 'openai',
          providerType: 'openai',
          enabled: true,
          baseURL: 'https://example.com/v1',
          compatibilityProfile: 'compat:passthrough',
          models: { 'demo-max': {}, 'demo-plus': {} },
          auth: { type: 'apikey', apiKey: '' }
        }
      });
    }
    if (path === '/config/providers/v2' && method === 'POST') {
      return json({ ok: true, path: '/tmp/provider/demo/config.v2.json' });
    }
    if (path === '/config/providers/v2/demo' && method === 'DELETE') {
      return json({ ok: true, path: '/tmp/provider/demo/config.v2.json' });
    }
    if (path === '/providers/runtimes' && method === 'GET') {
      return json([
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
      return json({
        providers: [
          {
            id: 'demo',
            type: 'openai',
            enabled: true,
            baseURL: 'https://example.com/v1',
            modelCount: 2,
            modelsPreview: ['demo-max'],
            compatibilityProfile: 'openai',
            authType: 'apikey'
          }
        ]
      });
    }
    if (path === '/config/providers/demo' && method === 'GET') {
      return json({
        provider: {
          id: 'demo',
          type: 'openai',
          enabled: true,
          baseURL: 'https://example.com/v1',
          models: { 'demo-max': {}, 'demo-plus': {} },
          auth: { type: 'apikey', apiKey: '' }
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
    if (path === '/config/routing/sources' && method === 'GET') {
      return json({
        activePath: '/tmp/config.json',
        sources: [{ path: '/tmp/config.json', label: '/tmp/config.json', kind: 'config', location: 'virtualrouter.routing' }]
      });
    }
    if (path === '/config/editor' && method === 'GET') {
      return json({
        ok: true,
        path: '/tmp/config.json',
        ports: [{ port: 5520, host: '0.0.0.0', mode: 'router', routingPolicyGroup: 'default', sameProtocolBehavior: 'direct' }],
        routingPolicyGroups: { default: { routing: { default: [{ targets: ['demo.default.demo-max'] }] } } },
        forwarders: {
          'fwd.gpt-5.5': {
            protocol: 'openai-responses',
            model: 'gpt-5.5',
            strategy: 'weighted',
            targets: [{ providerId: 'demo', weight: 1 }]
          }
        }
      });
    }
    if (path === '/config/routing/groups' && method === 'GET') {
      return json({
        groups: { default: { routing: { default: [{ targets: ['demo.default.demo-max'] }] } } },
        activeGroupId: 'default',
        location: 'virtualrouter.routing',
        path: '/tmp/config.json'
      });
    }
    if (path.startsWith('/config/routing/groups/') && method === 'PUT') {
      return json({
        groups: { default: { routing: { default: [{ targets: ['demo.default.demo-max'] }] } } },
        activeGroupId: 'default',
        location: 'virtualrouter.routing',
        path: '/tmp/config.json'
      });
    }
    if (path === '/config/routing/groups/activate' && method === 'POST') {
      return json({
        groups: { default: { routing: { default: [{ targets: ['demo.default.demo-max'] }] } } },
        activeGroupId: 'default',
        location: 'virtualrouter.routing',
        path: '/tmp/config.json'
      });
    }
    if (path === '/config/routing' && method === 'GET') {
      return json({ routing: { default: [{ targets: ['demo.default.demo-max'] }] } });
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
    fireEvent.change(providerIdInput, { target: { value: 'demo' } });
    fireEvent.click(within(providerEditorPanel).getByText('Load'));
    onToast.mockClear();
    fireEvent.click(within(providerEditorPanel).getByText('Save'));
    await waitFor(() => expect(hasToast('Provider saved.')).toBe(true));
    fireEvent.click(within(providerEditorPanel).getByText('Backup'));
    await waitFor(() => expect(hasToast('Provider backup captured.')).toBe(true));
    fireEvent.click(within(providerEditorPanel).getByText('Restore'));
    await waitFor(() => expect(hasToast('Provider restored from backup.')).toBe(true));
    fireEvent.change(within(modelPanel).getByPlaceholderText('new model id'), { target: { value: 'demo-next' } });
    fireEvent.click(within(modelPanel).getByText('Add Model'));
    onToast.mockClear();
    fireEvent.click(within(modelPanel).getByText('Test Provider (/v1/responses)'));
    await waitFor(() => expect(hasToast('Provider test passed.')).toBe(true));
    providerView.unmount();
    const routingView = render(<RoutingPage authenticated authEpoch={1} onToast={onToast} />);
    await waitFor(() => expect(screen.getByText('Routing Management')).toBeTruthy());
    routingView.unmount();
  });
});
