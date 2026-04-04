import { jest } from '@jest/globals';

import {
  buildAntigravityAliasMap,
  collectAntigravityAliases,
  filterAntigravityAliasMapByProviderKeys,
  startAntigravityPreload,
  startAntigravityWarmup
} from '../../../src/server/runtime/http-server/antigravity-startup-tasks.js';

describe('antigravity startup tasks', () => {
  it('collects aliases for preload and groups provider keys for warmup/blacklist', () => {
    const runtimeMap = {
      'antigravity.demo.claude-sonnet-4-6-thinking': {
        runtimeKey: 'antigravity.demo'
      },
      'crs.key1.gpt-5.4': {
        runtimeKey: 'crs.key1'
      }
    };

    expect(collectAntigravityAliases(runtimeMap)).toEqual(['demo', 'demo']);
    expect(Array.from(buildAntigravityAliasMap(runtimeMap).entries())).toEqual([
      ['demo', ['antigravity.demo.claude-sonnet-4-6-thinking']]
    ]);
  });

  it('starts preload and warmup without awaiting long-running tasks', async () => {
    const prime = jest.fn(async () => await new Promise(() => {}));
    const preload = jest.fn(async () => await new Promise(() => {}));
    const warmup = jest.fn(async () => await new Promise(() => {}));

    await Promise.race([
      Promise.resolve().then(() => {
        startAntigravityPreload(['demo'], {
          primeAntigravityUserAgentVersion: prime,
          preloadAntigravityAliasUserAgents: preload
        });
        startAntigravityWarmup(new Map([['demo', ['antigravity.demo.model']]]), undefined, {
          isAntigravityWarmupEnabled: () => true,
          getAntigravityWarmupBlacklistDurationMs: () => 60_000,
          warmupCheckAntigravityAlias: warmup
        });
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('startup tasks timed out')), 200))
    ]);

    await Promise.resolve();
    expect(prime).toHaveBeenCalledTimes(1);
    expect(preload).toHaveBeenCalledWith(['demo']);
    expect(warmup).toHaveBeenCalledWith('demo');
  });

  it('filters warmup aliases by routed provider keys', () => {
    const aliasMap = new Map<string, string[]>([
      ['demo', ['antigravity.demo.model-a', 'antigravity.demo.model-b']],
      ['other', ['antigravity.other.model-c']]
    ]);
    const scoped = filterAntigravityAliasMapByProviderKeys(
      aliasMap,
      new Set(['antigravity.demo.model-b'])
    );
    expect(Array.from(scoped.entries())).toEqual([['demo', ['antigravity.demo.model-b']]]);
  });

  it('returns empty warmup alias map when routing scope is applied but contains no providers', () => {
    const aliasMap = new Map<string, string[]>([
      ['demo', ['antigravity.demo.model-a']],
      ['other', ['antigravity.other.model-c']]
    ]);
    const scoped = filterAntigravityAliasMapByProviderKeys(
      aliasMap,
      new Set<string>(),
      { scopeApplied: true }
    );
    expect(Array.from(scoped.entries())).toEqual([]);
  });
});
