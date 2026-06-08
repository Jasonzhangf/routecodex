import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { buildVirtualRouterInputV2 } from '../../src/config/virtual-router-builder.js';
import { parseTomlRecord } from '../../src/config/toml-basic.js';

/**
 * E2E-equivalent coverage for ProviderForwarder use in the live
 * ~/.rcc/config.toml. We do NOT touch the live server (no
 * start/stop/restart). Instead we assert the bootstrap graph that the
 * live server would feed into Rust VirtualRouterEngine.
 */
describe('virtual-router-builder: forwarder bootstrap (live config.toml)', () => {
  const LIVE_CONFIG = '/Users/fanzhang/.rcc/config.toml';
  let liveConfig: Record<string, unknown> | null = null;
  try {
    liveConfig = parseTomlRecord(readFileSync(LIVE_CONFIG, 'utf8'));
  } catch (e) {
    // leave null; the it() blocks below will skip via the liveConfig guard
    liveConfig = null;
  }
  const skipUnless = liveConfig ? it : it.skip;

  skipUnless('10000 tool/search targets resolve to fwd.minimax.MiniMax-M2.7', async () => {
    const input = await buildVirtualRouterInputV2(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_coding_10000',
    });
    for (const routeName of ['tools', 'search', 'web_search']) {
      expect(routeTargets(input.routing, routeName)).toEqual(['fwd.minimax.MiniMax-M2.7']);
    }
  });

  skipUnless('bootstrap forwarders section contains GPT priority + MiniMax forwarders', async () => {
    const input = await buildVirtualRouterInputV2(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_coding_10000',
    });
    const fwds = (input as unknown as { forwarders?: Record<string, unknown> }).forwarders ?? {};
    const fwdIds = Object.keys(fwds).sort();
    expect(fwdIds).toEqual([
      'fwd.gpt.gpt-5.4-mini',
      'fwd.gpt.gpt-5.5',
      'fwd.minimax.MiniMax-M2.7',
      'fwd.minimax.MiniMax-M3',
    ]);

    const gpt55 = fwds['fwd.gpt.gpt-5.5'] as {
      strategy?: string;
      targets: Array<{ providerId?: string; providerKey?: string; priority?: number }>;
    };
    expect(gpt55.strategy).toBe('priority');
    expect(gpt55.targets.map((t) => [t.providerId, t.providerKey, t.priority])).toEqual([
      ['sdfv', 'sdfv.key1.gpt-5.5', 1],
      ['llmgate', 'llmgate.key1.free-gpt-5.5', 2],
      ['asxs', 'asxs.crsa.gpt-5.5', 3],
      ['cc', 'cc.key1.gpt-5.5', 4],
    ]);

    const m27 = fwds['fwd.minimax.MiniMax-M2.7'] as {
      targets: Array<{ provider?: string; providerId?: string; providerKey?: string; model?: string; priority?: number }>;
      weights?: Record<string, number>;
    };
    expect(m27.targets.map((t) => [t.providerId ?? t.provider, t.providerKey]).sort()).toEqual([
      ['mini27', 'mini27.key1.MiniMax-M2.7'],
      ['minimax', 'minimax.key1.MiniMax-M2.7'],
      ['minimonth', 'minimonth.key1.MiniMax-M2.7'],
    ]);
    expect(m27.weights).toMatchObject({
      'minimax': 5,
      'mini27': 3,
      'minimonth': 2,
    });

    const m3 = fwds['fwd.minimax.MiniMax-M3'] as {
      targets: Array<{ provider?: string; providerId?: string; providerKey?: string; model?: string }>;
    };
    expect(m3.targets[0]?.providerId).toBe('minimax');
    expect(m3.targets[0]?.providerKey).toBe('minimax.key1.MiniMax-M3');
    expect((m3 as any).modelId ?? m3.targets[0]?.model).toBe('MiniMax-M3');
  });

  skipUnless('5520 routing contains NO forwarder targets (forwarder NOT enabled on 5520)', async () => {
    const input = await buildVirtualRouterInputV2(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_priority_5520',
    });
    const all = collectTargets(input.routing);
    const fwdLeak = all.filter((t) => t.startsWith('fwd.'));
    expect(fwdLeak).toEqual([]);
  });

  skipUnless('5555 GPT routes use GPT forwarder target', async () => {
    const input = await buildVirtualRouterInputV2(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_priority_5555',
    });
    for (const routeName of ['coding', 'thinking', 'longcontext', 'default']) {
      expect(routeTargets(input.routing, routeName)).toEqual([
        'fwd.gpt.gpt-5.5',
        'fwd.minimax.MiniMax-M3',
        'mimo.mimo-v2.5',
      ]);
    }
  });

  skipUnless('10000 routing contains MiniMax forwarder targets only', async () => {
    const input = await buildVirtualRouterInputV2(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_coding_10000',
    });
    const all = collectTargets(input.routing);
    const fwdTargets = all.filter((t) => t.startsWith('fwd.'));
    expect(fwdTargets).toEqual([
      'fwd.minimax.MiniMax-M2.7',
      'fwd.minimax.MiniMax-M2.7',
      'fwd.minimax.MiniMax-M2.7',
    ]);
  });

  skipUnless('live config.toml contains fwd. exactly the expected times (drift guard)', () => {
    const raw = readFileSync(LIVE_CONFIG, 'utf8');
    const fwdMatches = raw.match(/"fwd\.[^"]+"/g) ?? [];
    const fwdIds = Array.from(new Set(fwdMatches.map((m) => m.slice(1, -1))));
    expect(fwdIds.sort()).toEqual([
      'fwd.gpt.gpt-5.4-mini',
      'fwd.gpt.gpt-5.5',
      'fwd.minimax.MiniMax-M2.7',
      'fwd.minimax.MiniMax-M3',
    ]);
  });
});

function collectTargets(routing: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const v of Object.values(routing)) {
    if (Array.isArray(v)) {
      for (const entry of v) collectEntryTargets(entry, out);
    } else {
      collectEntryTargets(v, out);
    }
  }
  return out;
}

function collectEntryTargets(entry: unknown, out: string[]): void {
  if (!entry || typeof entry !== 'object') return;
  const e = entry as Record<string, unknown>;
  if (Array.isArray(e.targets)) {
    for (const t of e.targets) {
      if (typeof t === 'string') out.push(t);
    }
  }
  if (typeof e.target === 'string') {
    out.push(e.target);
  }
}

function routeTargets(routing: Record<string, unknown>, routeName: string): string[] {
  const value = routing[routeName];
  const pools = Array.isArray(value) ? value : value ? [value] : [];
  const out: string[] = [];
  for (const pool of pools) {
    collectEntryTargets(pool, out);
  }
  return out;
}
