import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { compileRouteCodexRuntimeConfigManifest } from '../../src/config/user-config-loader.js';

async function compileVirtualRouterInput(userConfig: Record<string, unknown>, providerRootDir?: string, options?: Parameters<typeof compileRouteCodexRuntimeConfigManifest>[2]) {
  return (await compileRouteCodexRuntimeConfigManifest(userConfig, providerRootDir, options)).virtualRouterBootstrapInput;
}
import { extractProviderKeysForRoutingGroup } from '../../src/server/runtime/http-server/http-server-bootstrap.js';
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
  } catch {
    liveConfig = null;
  }
  const skipUnless = liveConfig ? it : it.skip;

  skipUnless('10000 tool/search targets resolve to fwd.minimax.MiniMax-M3', async () => {
    const input = await compileVirtualRouterInput(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_coding_10000',
    });
    for (const routeName of ['tools', 'search', 'web_search']) {
      expect(routeTargets(input.routing, routeName)).toEqual(['fwd.minimax.MiniMax-M3']);
    }
  });

  skipUnless('bootstrap forwarders section contains current live forwarders', async () => {
    const input = await compileVirtualRouterInput(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_coding_10000',
    });
    const fwds = (input as unknown as { forwarders?: Record<string, unknown> }).forwarders ?? {};
    expect(Object.keys(fwds).sort()).toEqual([
      'fwd.deepseek.deepseek-v4-flash',
      'fwd.deepseek.deepseek-v4-pro',
      'fwd.glm.glm-5.2',
      'fwd.gpt.gpt-5.4',
      'fwd.gpt.gpt-5.5',
      'fwd.lmstudio.ornith-1.0-397b',
      'fwd.minimax.MiniMax-M2.7',
      'fwd.minimax.MiniMax-M3',
      'fwd.minimax.minimax-m3',
      'fwd.paid.gpt-5.4',
      'fwd.paid.gpt-5.4-mini',
      'fwd.paid.gpt-5.5',
    ]);

    const paid54 = fwds['fwd.paid.gpt-5.4'] as {
      strategy?: string;
      stickyKey?: string;
      targets: Array<{ providerId?: string; providerKey?: string; priority?: number }>;
    };
    expect(paid54.strategy).toBe('priority');
    expect(paid54.stickyKey).toBe('none');
    expect(new Set(paid54.targets.map((t) => t.providerId))).toEqual(new Set(['asxs', '1token', 'xl']));
    expect(paid54.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerId: 'asxs', providerKey: 'asxs.crsa.gpt-5.4', priority: 1 }),
      expect.objectContaining({ providerId: 'xl', providerKey: 'xl.key1.gpt-5.4', priority: 2 }),
      expect.objectContaining({ providerId: '1token', providerKey: '1token.key1.gpt-5.4', priority: 3 }),
    ]));
    for (const target of paid54.targets) {
      expect(target.providerKey).toContain('.gpt-5.4');
      const expectedPriority = target.providerId === 'asxs'
        ? 1
        : target.providerId === 'xl'
          ? 2
          : target.providerId === '1token'
            ? 3
            : 4;
      expect(target.priority).toBe(expectedPriority);
    }

    const paid54Mini = fwds['fwd.paid.gpt-5.4-mini'] as {
      strategy?: string;
      stickyKey?: string;
      targets: Array<{ providerId?: string; providerKey?: string; priority?: number }>;
    };
    expect(paid54Mini.strategy).toBe('priority');
    expect(paid54Mini.stickyKey).toBe('none');
    expect(new Set(paid54Mini.targets.map((t) => t.providerId))).toEqual(new Set(['asxs', 'xl']));
    for (const target of paid54Mini.targets) {
      expect(target.providerKey).toContain('.gpt-5.4-mini');
      const expectedPriority = target.providerId === 'asxs'
        ? 1
        : target.providerId === 'xl'
          ? 2
          : 3;
      expect(target.priority).toBe(expectedPriority);
    }

    const m27 = fwds['fwd.minimax.MiniMax-M2.7'] as {
      targets: Array<{ providerId?: string; providerKey?: string; weight?: number }>;
    };
    expect(m27.targets.map((t) => [t.providerId, t.providerKey, t.weight]).sort()).toEqual([
      ['minimax', 'minimax.key1.MiniMax-M2.7', 1],
      ['minimonth', 'minimonth.key1.MiniMax-M2.7', 5],
    ]);

    const m3 = fwds['fwd.minimax.MiniMax-M3'] as {
      targets: Array<{ providerId?: string; providerKey?: string; priority?: number }>;
    };
    expect(m3.targets).toEqual([
      expect.objectContaining({
        providerId: 'minimax',
        providerKey: 'minimax.key1.MiniMax-M3',
        priority: 1,
      }),
    ]);

    const glm52 = fwds['fwd.glm.glm-5.2'] as {
      strategy?: string;
      stickyKey?: string;
      targets: Array<{ providerId?: string; providerKey?: string; weight?: number }>;
    };
    expect(glm52.strategy).toBe('weighted');
    expect(glm52.stickyKey).toBe('none');
    expect(glm52.targets).toEqual([
      expect.objectContaining({
        providerId: 'orangeai',
        providerKey: 'orangeai.key1.glm-5.2',
        weight: 1,
      }),
    ]);
  });

  skipUnless('5520 routes use current live priority forwarders', async () => {
    const input = await compileVirtualRouterInput(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_priority_5520',
    });
    expect(routeTargets(input.routing, 'coding')).toEqual(['fwd.paid.gpt-5.5', 'fwd.paid.gpt-5.5']);
    for (const routeName of ['tools', 'search', 'web_search', 'multimodal']) {
      expect(routeTargets(input.routing, routeName)).toEqual(['fwd.paid.gpt-5.4-mini']);
    }
    expect(routeTargets(input.routing, 'thinking')).toEqual([
      'fwd.paid.gpt-5.5',
      'fwd.paid.gpt-5.5',
    ]);
    expect(routeTargets(input.routing, 'longcontext')).toEqual([
      'fwd.gpt.gpt-5.5',
      'fwd.gpt.gpt-5.5',
    ]);
    expect(routeTargets(input.routing, 'default')).toEqual(['fwd.gpt.gpt-5.4']);
  });

  skipUnless('5520 thinking uses the current high priority pool', async () => {
    const input = await compileVirtualRouterInput(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_priority_5520',
    });
    const thinkingRoute = input.routing.thinking;
    expect(Array.isArray(thinkingRoute)).toBe(true);
    const [pool] = thinkingRoute as Array<Record<string, unknown>>;
    expect(pool.mode).toBe('priority');
    expect(pool.targets).toEqual(['fwd.paid.gpt-5.5', 'fwd.paid.gpt-5.5']);
    expect(pool.thinking).toBe('high');
  });

  skipUnless('5555 route targets match current config truth', async () => {
    const input = await compileVirtualRouterInput(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_priority_5555',
    });
    expect(routeTargets(input.routing, 'coding')).toEqual([
      'fwd.glm.glm-5.2',
      'fwd.paid.gpt-5.4-mini',
      'fwd.minimax.MiniMax-M3',
    ]);
    expect(routeTargets(input.routing, 'thinking')).toEqual([
      'fwd.glm.glm-5.2',
      'fwd.paid.gpt-5.4-mini',
      'fwd.minimax.MiniMax-M3',
    ]);
    expect(routeTargets(input.routing, 'longcontext')).toEqual([
      'fwd.glm.glm-5.2',
      'fwd.paid.gpt-5.4-mini',
      'fwd.minimax.MiniMax-M3',
    ]);
    for (const routeName of ['tools', 'search', 'web_search']) {
      expect(routeTargets(input.routing, routeName)).toEqual([
        'fwd.minimax.MiniMax-M2.7',
        'fwd.minimax.MiniMax-M3',
        'fwd.paid.gpt-5.4-mini',
      ]);
    }
    expect(routeTargets(input.routing, 'multimodal')).toEqual(['fwd.minimax.MiniMax-M3', 'fwd.paid.gpt-5.4-mini']);
    expect(routeTargets(input.routing, 'default')).toEqual([
      'fwd.glm.glm-5.2',
      'fwd.paid.gpt-5.4-mini',
      'fwd.minimax.MiniMax-M3',
      'fwd.minimax.MiniMax-M2.7',
      'fwd.paid.gpt-5.5',
      'fwd.paid.gpt-5.5',
      'fwd.gpt.gpt-5.4',
    ]);
  });

  skipUnless('live config keeps forwarder targets providerId only', () => {
    const raw = readFileSync(LIVE_CONFIG, 'utf8');
    expect(raw).not.toMatch(/providerKey\s*=/);
    expect(raw).not.toMatch(/modelId\s*=/);
  });

  skipUnless('5555 allowedProviders expands forwarders to real provider ids', () => {
    const allowed = extractProviderKeysForRoutingGroup(liveConfig as Record<string, unknown>, 'gateway_priority_5555');
    expect(allowed).toEqual(expect.arrayContaining([
      'asxs',
      'minimax',
      'minimonth',
      'xl',
      'cc',
      '1token',
    ]));
    expect(allowed).not.toContain('fwd');
  });

  skipUnless('10000 routing contains current forwarder targets', async () => {
    const input = await compileVirtualRouterInput(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_coding_10000',
    });
    const all = collectTargets(input.routing);
    const fwdTargets = all.filter((t) => t.startsWith('fwd.'));
    expect(fwdTargets).toEqual([
      'fwd.minimax.MiniMax-M3',
      'fwd.minimax.MiniMax-M3',
      'fwd.minimax.MiniMax-M3',
      'fwd.glm.glm-5.2',
      'fwd.minimax.MiniMax-M3',
    ]);
  });

  skipUnless('live config.toml contains the expected forwarder ids (drift guard)', () => {
    const raw = readFileSync(LIVE_CONFIG, 'utf8');
    const fwdMatches = raw.match(/"fwd\.[^"]+"/g) ?? [];
    const fwdIds = Array.from(new Set(fwdMatches.map((m) => m.slice(1, -1))));
    expect(fwdIds.sort()).toEqual([
      'fwd.deepseek.deepseek-v4-flash',
      'fwd.deepseek.deepseek-v4-pro',
      'fwd.glm.glm-5.2',
      'fwd.gpt.gpt-5.4',
      'fwd.gpt.gpt-5.5',
      'fwd.lmstudio.ornith-1.0-397b',
      'fwd.minimax.MiniMax-M2.7',
      'fwd.minimax.MiniMax-M3',
      'fwd.minimax.minimax-m3',
      'fwd.paid.gpt-5.4',
      'fwd.paid.gpt-5.4-mini',
      'fwd.paid.gpt-5.5',
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
