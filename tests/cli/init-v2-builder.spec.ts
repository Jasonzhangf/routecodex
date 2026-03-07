import { describe, expect, it } from '@jest/globals';

import { buildInitRouting, buildV2ConfigObject } from '../../src/cli/config/init-v2-builder.js';

describe('init-v2-builder', () => {
  it('builds weighted route pools without priority mode', () => {
    const routing = buildInitRouting({
      defaultTarget: 'openai.gpt-5.2',
      thinkingTarget: 'tab.gpt-5.2',
      webSearchTargets: ['iflow.qwen3-coder-plus', 'qwen.qwen3.5-plus']
    }) as Record<string, any>;

    expect(routing.default[0]).toEqual({
      id: 'primary',
      targets: ['openai.gpt-5.2'],
      loadBalancing: {
        strategy: 'weighted',
        weights: { 'openai.gpt-5.2': 1 }
      }
    });
    expect(routing.thinking[0].targets[0]).toBe('tab.gpt-5.2');
    expect(routing.web_search[0].loadBalancing.weights).toEqual({
      'iflow.qwen3-coder-plus': 1,
      'qwen.qwen3.5-plus': 1
    });
    expect(routing.web_search[0].mode).toBeUndefined();
  });

  it('wraps routing under routingPolicyGroups and preserves existing policy metadata', () => {
    const existing = {
      version: '2.0.0',
      virtualrouterMode: 'v2',
      httpserver: { host: '127.0.0.1', port: 5555 },
      virtualrouter: {
        activeRoutingPolicyGroup: 'default',
        routingPolicyGroups: {
          default: {
            routing: { default: [] },
            webSearch: {
              engines: [{ id: 'iflow:web_search', providerKey: 'iflow' }],
              search: { 'iflow:web_search': { providerKey: 'iflow' } }
            }
          }
        }
      }
    };

    const next = buildV2ConfigObject({
      existing,
      host: '0.0.0.0',
      port: 7777,
      routing: buildInitRouting({ defaultTarget: 'tab.gpt-5.2' })
    }) as Record<string, any>;

    expect(next.httpserver).toEqual({ host: '0.0.0.0', port: 7777 });
    expect(next.virtualrouter.activeRoutingPolicyGroup).toBe('default');
    expect(next.virtualrouter.routingPolicyGroups.default.routing.default[0].targets[0]).toBe('tab.gpt-5.2');
    expect(next.virtualrouter.routingPolicyGroups.default.webSearch.search['iflow:web_search'].providerKey).toBe('iflow');
    expect(next.routing).toBeUndefined();
    expect(next.providers).toBeUndefined();
  });
});
