import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  App,
  ProviderPage,
  RoutingPage
} from '../../webui/src/App';

describe('webui render smoke', () => {
  it('renders the gated top-level app shell before login', () => {
    const html = renderToString(<App />);
    expect(html).toContain('RouteCodex WebUI V2');
    expect(html).toContain('Admin authentication is required');
    expect(html).toContain('Admin Setup');
  });

  it('renders each major page panel title without crashing', () => {
    const common = {
      authenticated: true,
      authEpoch: 1,
      onToast: () => {}
    } as const;

    const provider = renderToString(<ProviderPage {...common} apiKey="" />);
    expect(provider).toContain('Provider Pool');

    const routing = renderToString(<RoutingPage {...common} />);
    expect(routing).toContain('Routing Management');
  });
});
