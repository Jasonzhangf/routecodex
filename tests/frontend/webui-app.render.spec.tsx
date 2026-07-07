import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  App,
  ForwardersPage,
  ProviderPage,
  RoutingPage
} from '../../webui/src/App';

describe('webui render smoke', () => {
  it('renders top-level app with login gate by default', () => {
    const html = renderToString(<App />);
    expect(html).toContain('RouteCodex WebUI V2');
    expect(html).toContain('Admin Setup');
    expect(html).not.toContain('Provider Catalog');
    expect(html).not.toContain('Quota Pool');
    expect(html).not.toContain('Refresh View (R)');
  });

  it('renders each major page panel title without crashing', () => {
    const common = {
      authenticated: true,
      authEpoch: 1,
      onToast: () => {}
    } as const;

    const provider = renderToString(<ProviderPage {...common} apiKey="" />);
    expect(provider).toContain('Provider Pool');
    expect(provider).toContain('tree-section accent-provider');
    expect(provider).toContain('Provider Details');
    const routing = renderToString(<RoutingPage {...common} />);
    expect(routing).toContain('Routing Management');
    expect(routing).toContain('Port Config Entries');
    expect(routing).toContain('Route List');
    expect(routing).toContain('Route Details');

    const forwarders = renderToString(<ForwardersPage {...common} />);
    expect(forwarders).toContain('Forwarder Aggregation');
    expect(forwarders).toContain('Forwarder Tree');
  });
});
