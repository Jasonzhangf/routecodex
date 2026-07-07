import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { compileRouteCodexRuntimeConfigManifest } from '../../src/config/user-config-loader.js';

async function compileVirtualRouterInput(userConfig: Record<string, unknown>, providerRootDir?: string, options?: Parameters<typeof compileRouteCodexRuntimeConfigManifest>[2]) {
  return (await compileRouteCodexRuntimeConfigManifest(userConfig, providerRootDir, options)).virtualRouterBootstrapInput;
}
import { parseTomlRecord } from '../../src/config/toml-basic.js';

const LIVE_CONFIG = '/Users/fanzhang/.rcc/config.toml';
let liveConfig: Record<string, unknown> | null = null;
try {
  liveConfig = parseTomlRecord(readFileSync(LIVE_CONFIG, 'utf8'));
} catch {
  liveConfig = null;
}

/**
 * E2E-equivalent coverage for ProviderForwarder use in the live
 * ~/.rcc/config.toml. We do NOT touch the live server (no
 * start/stop/restart). Instead we assert the bootstrap graph that the
 * live server would feed into Rust VirtualRouterEngine.
 */
describe('virtual-router-builder: forwarder bootstrap (live config.toml)', () => {
  const skipUnless = liveConfig ? it : it.skip;

  skipUnless('10000 tool/search targets match current config truth', async () => {
    const input = await compileVirtualRouterInput(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_coding_10000',
    });
    for (const routeName of ['tools', 'search', 'web_search']) {
      expect(routeTargets(input.routing, routeName)).toEqual(expectedRouteTargets('gateway_coding_10000', routeName));
    }
  });

  skipUnless('bootstrap forwarders section contains current live forwarders', async () => {
    const input = await compileVirtualRouterInput(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_coding_10000',
    });
    const fwds = (input as unknown as { forwarders?: Record<string, unknown> }).forwarders ?? {};
    const expectedForwarders = currentForwarders();
    expect(Object.keys(fwds).sort()).toEqual(Object.keys(expectedForwarders).sort());

    const paid54 = fwds['fwd.paid.gpt-5.4'] as {
      strategy?: string;
      stickyKey?: string;
      targets: Array<{ providerId?: string; providerKey?: string; priority?: number }>;
    };
    expect(paid54.strategy).toBe('priority');
    expect(paid54.stickyKey).toBe('none');
    expect(new Set(paid54.targets.map((t) => t.providerId))).toEqual(new Set(expectedForwarderProviderIds('fwd.paid.gpt-5.4')));
    for (const target of paid54.targets) {
      expect(target.providerKey).toContain('.gpt-5.4');
      expect(target.priority).toBe(expectedForwarderTargetPriority('fwd.paid.gpt-5.4', target.providerId));
    }

    const paid54Mini = fwds['fwd.paid.gpt-5.4-mini'] as {
      strategy?: string;
      stickyKey?: string;
      targets: Array<{ providerId?: string; providerKey?: string; priority?: number }>;
    };
    expect(paid54Mini.strategy).toBe('priority');
    expect(paid54Mini.stickyKey).toBe('none');
    expect(new Set(paid54Mini.targets.map((t) => t.providerId))).toEqual(new Set(expectedForwarderProviderIds('fwd.paid.gpt-5.4-mini')));
    for (const target of paid54Mini.targets) {
      expect(target.providerKey).toContain('.gpt-5.4-mini');
      expect(target.priority).toBe(expectedForwarderTargetPriority('fwd.paid.gpt-5.4-mini', target.providerId));
    }

    const m27 = fwds['fwd.minimax.MiniMax-M2.7'] as {
      targets: Array<{ providerId?: string; providerKey?: string; weight?: number }>;
    };
    expect(m27.targets.map((t) => [t.providerId, t.providerKey, t.weight])).toEqual(expectedForwarderTargetTriples('fwd.minimax.MiniMax-M2.7'));

    const m3 = fwds['fwd.minimax.MiniMax-M3'] as {
      targets: Array<{ providerId?: string; providerKey?: string; priority?: number }>;
    };
    expect(m3.targets.map((t) => [t.providerId, t.providerKey, t.priority])).toEqual(expectedForwarderTargetTriples('fwd.minimax.MiniMax-M3'));

    const glm52 = fwds['fwd.glm.glm-5.2'] as {
      strategy?: string;
      stickyKey?: string;
      targets: Array<{ providerId?: string; providerKey?: string; weight?: number }>;
    };
    expect(glm52.strategy).toBe('weighted');
    expect(glm52.stickyKey).toBe('none');
    expect(glm52.targets.map((t) => [t.providerId, t.providerKey, t.weight])).toEqual(expectedForwarderTargetTriples('fwd.glm.glm-5.2'));
  });

  skipUnless('5520 routes use current live priority forwarders', async () => {
    const input = await compileVirtualRouterInput(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_priority_5520',
    });
    expect(routeTargets(input.routing, 'coding')).toEqual(expectedRouteTargets('gateway_priority_5520', 'coding'));
    for (const routeName of ['tools', 'search', 'web_search', 'multimodal']) {
      expect(routeTargets(input.routing, routeName)).toEqual(expectedRouteTargets('gateway_priority_5520', routeName));
    }
    expect(routeTargets(input.routing, 'thinking')).toEqual(expectedRouteTargets('gateway_priority_5520', 'thinking'));
    expect(routeTargets(input.routing, 'longcontext')).toEqual(expectedRouteTargets('gateway_priority_5520', 'longcontext'));
    expect(routeTargets(input.routing, 'default')).toEqual(expectedRouteTargets('gateway_priority_5520', 'default'));
  });

  skipUnless('5520 thinking uses the current high priority pool', async () => {
    const input = await compileVirtualRouterInput(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_priority_5520',
    });
    const thinkingRoute = input.routing.thinking;
    expect(Array.isArray(thinkingRoute)).toBe(true);
    const [pool] = thinkingRoute as Array<Record<string, unknown>>;
    expect(pool.mode).toBe('priority');
    expect(pool.targets).toEqual(expectedRouteTargets('gateway_priority_5520', 'thinking'));
    expect(pool.thinking).toBe('high');
  });

  skipUnless('5555 route targets match current config truth', async () => {
    const input = await compileVirtualRouterInput(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_priority_5555',
    });
    expect(routeTargets(input.routing, 'coding')).toEqual(expectedRouteTargets('gateway_priority_5555', 'coding'));
    expect(routeTargets(input.routing, 'thinking')).toEqual(expectedRouteTargets('gateway_priority_5555', 'thinking'));
    expect(routeTargets(input.routing, 'longcontext')).toEqual(expectedRouteTargets('gateway_priority_5555', 'longcontext'));
    for (const routeName of ['tools', 'search', 'web_search']) {
      expect(routeTargets(input.routing, routeName)).toEqual(expectedRouteTargets('gateway_priority_5555', routeName));
    }
    expect(routeTargets(input.routing, 'multimodal')).toEqual(expectedRouteTargets('gateway_priority_5555', 'multimodal'));
    expect(routeTargets(input.routing, 'default')).toEqual(expectedRouteTargets('gateway_priority_5555', 'default'));
  });

  skipUnless('live config keeps forwarder targets providerId only', () => {
    const raw = readFileSync(LIVE_CONFIG, 'utf8');
    expect(raw).not.toMatch(/providerKey\s*=/);
    expect(raw).not.toMatch(/modelId\s*=/);
  });

  skipUnless('5555 allowedProviders expands forwarders through Rust pipelineRuntimeConfig', async () => {
    const manifest = await compileRouteCodexRuntimeConfigManifest(
      liveConfig as Record<string, unknown>,
      '/Users/fanzhang/.rcc/provider',
      { routingPolicyGroup: 'gateway_priority_5555' },
    );
    const allowed = manifest.pipelineRuntimeConfig.routingProviderIds;
    expect(allowed).toEqual(expect.arrayContaining(expectedExpandedProviderIds('gateway_priority_5555')));
    expect(allowed).not.toContain('fwd');
  });

  skipUnless('10000 routing contains current forwarder targets', async () => {
    const input = await compileVirtualRouterInput(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_coding_10000',
    });
    const all = collectTargets(input.routing);
    const fwdTargets = all.filter((t) => t.startsWith('fwd.'));
    const expected = collectTargets(currentRouting('gateway_coding_10000')).filter((t) => t.startsWith('fwd.'));
    expect(fwdTargets).toEqual(expected);
  });

  skipUnless('live config.toml forwarder ids are the current artifact truth', async () => {
    const raw = readFileSync(LIVE_CONFIG, 'utf8');
    const fwdMatches = raw.match(/"fwd\.[^"]+"/g) ?? [];
    const fwdIds = Array.from(new Set(fwdMatches.map((m) => m.slice(1, -1))));
    const input = await compileVirtualRouterInput(liveConfig as Record<string, unknown>, '/Users/fanzhang/.rcc/provider', {
      routingPolicyGroup: 'gateway_coding_10000',
    });
    const fwds = (input as unknown as { forwarders?: Record<string, unknown> }).forwarders ?? {};
    expect(fwdIds.sort()).toEqual(Object.keys(fwds).sort());
  });
});

function currentVirtualRouter(): Record<string, unknown> {
  return ((liveConfig as Record<string, unknown>).virtualrouter ?? {}) as Record<string, unknown>;
}

function currentForwarders(): Record<string, unknown> {
  return (currentVirtualRouter().forwarders ?? {}) as Record<string, unknown>;
}

function currentRouting(group: string): Record<string, unknown> {
  const groups = (currentVirtualRouter().routingPolicyGroups ?? {}) as Record<string, unknown>;
  const entry = (groups[group] ?? {}) as Record<string, unknown>;
  return (entry.routing ?? {}) as Record<string, unknown>;
}

function expectedRouteTargets(group: string, routeName: string): string[] {
  return routeTargets(currentRouting(group), routeName);
}

function expectedExpandedProviderIds(group: string): string[] {
  const providerIds = new Set<string>();
  for (const target of collectTargets(currentRouting(group))) {
    if (target.startsWith('fwd.')) {
      const forwarder = currentForwarders()[target] as { targets?: unknown } | undefined;
      for (const forwarderTarget of Array.isArray(forwarder?.targets) ? forwarder.targets : []) {
        if (forwarderTarget && typeof forwarderTarget === 'object') {
          const providerId = (forwarderTarget as { providerId?: unknown }).providerId;
          if (typeof providerId === 'string' && providerId) providerIds.add(providerId);
        }
      }
    } else if (target) {
      providerIds.add(target.split('.')[0] ?? target);
    }
  }
  return [...providerIds].sort();
}

function expectedForwarderTargets(forwarderId: string): Array<Record<string, unknown>> {
  const forwarder = currentForwarders()[forwarderId] as { targets?: unknown } | undefined;
  return Array.isArray(forwarder?.targets)
    ? forwarder.targets.filter((target): target is Record<string, unknown> => !!target && typeof target === 'object' && !Array.isArray(target))
    : [];
}

function expectedForwarderProviderIds(forwarderId: string): Array<string | undefined> {
  return expectedForwarderTargets(forwarderId).map((target) => {
    const providerId = target.providerId;
    return typeof providerId === 'string' ? providerId : undefined;
  });
}

function expectedForwarderTargetPriority(forwarderId: string, providerId: string | undefined): number | undefined {
  const expected = expectedForwarderTargets(forwarderId).find((target) => target.providerId === providerId);
  return typeof expected?.priority === 'number' ? expected.priority : undefined;
}

function expectedForwarderTargetTriples(forwarderId: string): Array<[string | undefined, string | undefined, number | undefined]> {
  return expectedForwarderTargets(forwarderId).map((target) => {
    const providerId = typeof target.providerId === 'string' ? target.providerId : undefined;
    const model = typeof target.model === 'string' ? target.model : forwarderId.split('.').slice(2).join('.');
    const providerKey = providerId && model ? `${providerId}.key1.${model}` : undefined;
    const weightOrPriority = typeof target.weight === 'number'
      ? target.weight
      : typeof target.priority === 'number'
        ? target.priority
        : undefined;
    return [providerId, providerKey, weightOrPriority];
  });
}

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
