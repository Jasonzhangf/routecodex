import React from 'react';
import { renderToString } from 'react-dom/server';
import {
  AdvancedPage,
  App,
  OAuthPage,
  ProviderPage,
  QuotaPage,
  RoutingPage,
  StatsPage
} from '../../webui/src/App';

describe('webui render smoke', () => {
  it('renders top-level app shell with integrated navigation labels', () => {
    const html = renderToString(<App />);
    expect(html).toContain('Providers');
    expect(html).toContain('Routing &amp; Capacity');
    expect(html).toContain('Ops');
    expect(html).toContain('Provider Catalog');
    expect(html).toContain('OAuth &amp; Credentials');
    expect(html).toContain('Refresh View (R)');
  });

  it('renders each major page panel title without crashing', () => {
    const common = {
      authenticated: true,
      authEpoch: 1,
      onToast: () => {}
    } as const;

    const provider = renderToString(<ProviderPage {...common} apiKey="" />);
    expect(provider).toContain('Provider Pool');

    const oauth = renderToString(<OAuthPage {...common} />);
    expect(oauth).toContain('Auth Inventory');

    const routing = renderToString(<RoutingPage {...common} />);
    expect(routing).toContain('Routing Management');

    const stats = renderToString(<StatsPage {...common} />);
    expect(stats).toContain('Stats Management');

    const quota = renderToString(<QuotaPage {...common} />);
    expect(quota).toContain('Quota Pool Management');

    const advancedControl = renderToString(<AdvancedPage {...common} tab="control" />);
    expect(advancedControl).toContain('Control Plane');

    const advancedClock = renderToString(<AdvancedPage {...common} tab="clock" />);
    expect(advancedClock).toContain('Clock Tasks');
  });
});
