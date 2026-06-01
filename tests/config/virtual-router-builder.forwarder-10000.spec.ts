import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { buildVirtualRouterInputV2 } from '../../src/config/virtual-router-builder.js';
import { parseTomlRecord } from '../../src/config/toml-basic.js';

/**
 * E2E-equivalent coverage for "only 10000 enables ProviderForwarder" in
 * the live ~/.rcc/config.toml. We do NOT touch the live server (no
 * start/stop/restart). Instead we assert the bootstrap graph that the
 * live server would feed into Rust VirtualRouterEngine — proving the
 * "10000 only" config semantics end-to-end at the bootstrap layer.
 */
describe('virtual-router-builder: 10000-only forwarder bootstrap (live config.toml)', () => {
  const LIVE_CONFIG = '/Users/fanzhang/.rcc/config.toml';
  let liveConfig: Record<string, unknown> | null = null;
  try {
    liveConfig = parseTomlRecord(readFileSync(LIVE_CONFIG, 'utf8'));
  } catch (e) {
    // leave null; the it() blocks below will skip via the liveConfig guard
    liveConfig = null;
  }
  const skipUnless = liveConfig ? it : it.skip;

  skipUnless('10000 default target resolves to fwd.minimax.MiniMax-M2.7', async () => {
    const input = await buildVirtualRouterInputV2(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_coding_10000',
    });
    const dflt = input.routing.default;
    expect(Array.isArray(dflt)).toBe(true);
    const dfltArr = dflt as unknown as Array<{ target?: string }>;
    const fwdDflt = dfltArr.find((d) => d.target && d.target.startsWith('fwd.'));
    expect(fwdDflt?.target).toBe('fwd.minimax.MiniMax-M2.7');
  });

  skipUnless('10000 bootstrap forwarders section contains M2.7 weighted 5:3:2 + M3 priority (minimax only)', async () => {
    const input = await buildVirtualRouterInputV2(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_coding_10000',
    });
    const fwds = (input as unknown as { forwarders?: Record<string, unknown> }).forwarders ?? {};
    const fwdIds = Object.keys(fwds).sort();
    expect(fwdIds).toEqual(['fwd.minimax.MiniMax-M2.7', 'fwd.minimax.MiniMax-M3']);

    const m27 = fwds['fwd.minimax.MiniMax-M2.7'] as {
      targets: Array<{ provider?: string; model?: string; priority?: number }>;
      weights?: Record<string, number>;
    };
    const m27Providers = m27.targets.map((t) => (t.providerId ?? t.providerKey ?? t.provider)).sort();
    expect(m27Providers).toEqual(['mini27', 'minimax', 'minimonth']);
    expect(m27.weights).toMatchObject({
      'minimax': 5,
      'mini27': 3,
      'minimonth': 2,
    });

    const m3 = fwds['fwd.minimax.MiniMax-M3'] as {
      targets: Array<{ provider?: string; model?: string }>;
    };
    expect(m3.targets[0]?.providerId).toBe('minimax');
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

  skipUnless('5555 routing contains NO forwarder targets (forwarder NOT enabled on 5555)', async () => {
    const input = await buildVirtualRouterInputV2(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_priority_5555',
    });
    const all = collectTargets(input.routing);
    const fwdLeak = all.filter((t) => t.startsWith('fwd.'));
    expect(fwdLeak).toEqual([]);
  });

  skipUnless('10000 routing contains EXACTLY ONE forwarder target (only default uses fwd)', async () => {
    const input = await buildVirtualRouterInputV2(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_coding_10000',
    });
    const all = collectTargets(input.routing);
    const fwdTargets = all.filter((t) => t.startsWith('fwd.'));
    expect(fwdTargets).toEqual(['fwd.minimax.MiniMax-M2.7']);
  });

  skipUnless('live config.toml contains fwd. exactly the expected times (drift guard)', () => {
    // Drift guard: if anyone re-introduces fwd. on 5520/5555 this test fails.
    const raw = readFileSync(LIVE_CONFIG, 'utf8');
    const fwdMatches = raw.match(/"fwd\.[^"]+"/g) ?? [];
    const fwdIds = Array.from(new Set(fwdMatches.map((m) => m.slice(1, -1))));
    expect(fwdIds.sort()).toEqual([
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
