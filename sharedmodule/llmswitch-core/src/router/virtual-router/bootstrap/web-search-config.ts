import {
  VirtualRouterError,
  VirtualRouterErrorCode,
  type VirtualRouterWebSearchConfig,
  type VirtualRouterWebSearchEngineConfig
} from '../types.js';
import type { NormalizedRoutePoolConfig } from './routing-config.js';

export function validateWebSearchRouting(
  webSearch: VirtualRouterWebSearchConfig | undefined,
  routingSource: Record<string, NormalizedRoutePoolConfig[]>
): void {
  if (!webSearch) {
    return;
  }
  const routePools = routingSource.web_search;
  if (!Array.isArray(routePools) || !routePools.length) {
    throw new VirtualRouterError(
      'Virtual Router webSearch.engines configured but routing.web_search route is missing or empty',
      VirtualRouterErrorCode.CONFIG_ERROR
    );
  }
  const targets = new Set<string>(collectWebSearchRouteTargets(routingSource));
  for (const engine of webSearch.engines) {
    if (!targets.has(engine.providerKey)) {
      throw new VirtualRouterError(
        `Virtual Router webSearch engine "${engine.id}" references providerKey "${engine.providerKey}" which is not present in routing.web_search/search`,
        VirtualRouterErrorCode.CONFIG_ERROR
      );
    }
  }
}

export function normalizeWebSearch(
  input: unknown,
  routingSource: Record<string, NormalizedRoutePoolConfig[]>
): VirtualRouterWebSearchConfig | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const enginesNode = Array.isArray(record.engines) ? record.engines : [];
  const engines: VirtualRouterWebSearchEngineConfig[] = [];
  const webSearchRouteTargets = collectWebSearchRouteTargets(routingSource);

  for (const raw of enginesNode) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const node = raw as Record<string, unknown>;
    const idRaw = node.id;
    const providerKeyRaw = node.providerKey ?? node.provider ?? node.target;
    const id = typeof idRaw === 'string' && idRaw.trim() ? idRaw.trim() : undefined;
    const providerKey =
      typeof providerKeyRaw === 'string' && providerKeyRaw.trim() ? providerKeyRaw.trim() : undefined;
    if (!id || !providerKey) {
      continue;
    }
    const resolvedProviderKey = resolveWebSearchEngineProviderKey(providerKey, webSearchRouteTargets) ?? providerKey;
    const description =
      typeof node.description === 'string' && node.description.trim() ? node.description.trim() : undefined;
    const isDefault =
      node.default === true || (typeof node.default === 'string' && node.default.trim().toLowerCase() === 'true');
    const rawExecutionMode =
      typeof node.executionMode === 'string'
        ? node.executionMode.trim().toLowerCase()
        : typeof node.mode === 'string'
          ? node.mode.trim().toLowerCase()
          : '';
    const executionMode = rawExecutionMode === 'direct' ? 'direct' : 'servertool';
    const rawDirectActivation =
      typeof node.directActivation === 'string'
        ? node.directActivation.trim().toLowerCase()
        : typeof node.activation === 'string'
          ? node.activation.trim().toLowerCase()
          : '';
    const directActivation =
      rawDirectActivation === 'builtin'
        ? 'builtin'
        : rawDirectActivation === 'route'
          ? 'route'
          : executionMode === 'direct'
            ? 'route'
            : undefined;
    const modelId =
      typeof node.modelId === 'string' && node.modelId.trim() ? node.modelId.trim() : undefined;
    const maxUsesRaw = typeof node.maxUses === 'number' ? node.maxUses : Number(node.maxUses);
    const maxUses = Number.isFinite(maxUsesRaw) && maxUsesRaw > 0 ? Math.floor(maxUsesRaw) : undefined;
    const serverToolsDisabled =
      node.serverToolsDisabled === true ||
      (typeof node.serverToolsDisabled === 'string' &&
        node.serverToolsDisabled.trim().toLowerCase() === 'true') ||
      (node.serverTools &&
        typeof node.serverTools === 'object' &&
        (node.serverTools as Record<string, unknown>).enabled === false);

    if (engines.some((engine) => engine.id === id)) {
      continue;
    }

    engines.push({
      id,
      providerKey: resolvedProviderKey,
      description,
      default: isDefault,
      executionMode,
      ...(directActivation ? { directActivation } : {}),
      ...(modelId ? { modelId } : {}),
      ...(maxUses ? { maxUses } : {}),
      ...(serverToolsDisabled ? { serverToolsDisabled: true } : {})
    });
  }

  if (!engines.length) {
    return undefined;
  }

  let injectPolicy: VirtualRouterWebSearchConfig['injectPolicy'];
  let force: boolean | undefined;

  const rawPolicy = record.injectPolicy ?? (record as any).inject_policy;
  if (typeof rawPolicy === 'string') {
    const normalized = rawPolicy.trim().toLowerCase();
    if (normalized === 'always' || normalized === 'selective') {
      injectPolicy = normalized;
    }
  }

  if (record.force === true || (typeof record.force === 'string' && record.force.trim().toLowerCase() === 'true')) {
    force = true;
  } else {
    const webSearchPools = routingSource.web_search ?? [];
    if (Array.isArray(webSearchPools) && webSearchPools.some((pool) => pool.force)) {
      force = true;
    }
  }

  return {
    engines,
    injectPolicy: injectPolicy ?? 'selective',
    ...(force ? { force } : {})
  };
}

function collectWebSearchRouteTargets(routingSource: Record<string, NormalizedRoutePoolConfig[]>): string[] {
  const routePools = routingSource.web_search;
  if (!Array.isArray(routePools) || !routePools.length) {
    return [];
  }
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const pool of routePools) {
    if (!pool || !Array.isArray(pool.targets)) {
      continue;
    }
    for (const target of pool.targets) {
      if (typeof target !== 'string') {
        continue;
      }
      const normalized = target.trim();
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      targets.push(normalized);
    }
  }
  return targets;
}

function resolveWebSearchEngineProviderKey(providerKey: string, routeTargets: string[]): string | undefined {
  const input = providerKey.trim();
  if (!input) {
    return undefined;
  }
  if (routeTargets.includes(input)) {
    return input;
  }

  const prefixMatches = routeTargets.filter((target) => target.startsWith(`${input}.`));
  if (prefixMatches.length > 0) {
    return prefixMatches[0];
  }

  const firstDot = input.indexOf('.');
  if (firstDot > 0 && firstDot < input.length - 1) {
    const providerId = input.slice(0, firstDot);
    const modelSuffix = input.slice(firstDot + 1);
    const suffixMatches = routeTargets.filter(
      (target) => target.startsWith(`${providerId}.`) && target.endsWith(`.${modelSuffix}`)
    );
    if (suffixMatches.length > 0) {
      return suffixMatches[0];
    }
  }

  return undefined;
}
