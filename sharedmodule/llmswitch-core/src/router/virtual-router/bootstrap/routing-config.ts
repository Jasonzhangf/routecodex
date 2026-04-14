import {
  VirtualRouterError,
  VirtualRouterErrorCode,
  type RoutingPools,
  type RoutePoolLoadBalancingPolicy,
  type RoutePoolTier
} from '../types.js';
import { readOptionalString } from './utils.js';

export interface NormalizedRoutePoolConfig {
  id: string;
  priority: number;
  backup: boolean;
  targets: string[];
  mode?: 'round-robin' | 'priority';
  force?: boolean;
  loadBalancing?: RoutePoolLoadBalancingPolicy;
}

export function normalizeRouting(source: Record<string, unknown>): Record<string, NormalizedRoutePoolConfig[]> {
  const routing: Record<string, NormalizedRoutePoolConfig[]> = {};
  for (const [routeName, entries] of Object.entries(source)) {
    if (!Array.isArray(entries) || !entries.length) {
      routing[routeName] = [];
      continue;
    }
    const allStrings = entries.every((entry) => typeof entry === 'string' || entry === null || entry === undefined);
    if (allStrings) {
      const targets = normalizeTargetList(entries);
      routing[routeName] = targets.length ? [buildLegacyRoutePool(routeName, targets)] : [];
      continue;
    }
    const normalized: NormalizedRoutePoolConfig[] = [];
    const total = entries.length || 1;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const pool = normalizeRoutePoolEntry(routeName, entry, index, total);
      if (pool && pool.targets.length) {
        normalized.push(pool);
      }
    }
    routing[routeName] = normalized;
  }
  return routing;
}

export function expandRoutingTable(
  routingSource: Record<string, NormalizedRoutePoolConfig[]>,
  aliasIndex: Map<string, string[]>,
  modelIndex: Map<string, { declared: boolean; models: string[] }>
): { routing: RoutingPools; targetKeys: Set<string> } {
  const routing: RoutingPools = {};
  const targetKeys = new Set<string>();

  for (const [routeName, pools] of Object.entries(routingSource)) {
    const expandedPools: RoutePoolTier[] = [];
    for (const pool of pools) {
      const expandedTargets: Array<{ key: string; priority: number; order: number }> = [];
      let orderCounter = 0;
      for (const entry of pool.targets) {
        const parsed = parseRouteEntry(entry, aliasIndex);
        if (!parsed) {
          continue;
        }
        if (!aliasIndex.has(parsed.providerId)) {
          throw new VirtualRouterError(
            `Route "${routeName}" references unknown provider "${parsed.providerId}"`,
            VirtualRouterErrorCode.CONFIG_ERROR
          );
        }
        const modelInfo = modelIndex.get(parsed.providerId);
        if (modelInfo?.declared) {
          if (!parsed.modelId) {
            throw new VirtualRouterError(
              `Route "${routeName}" references empty model id for provider "${parsed.providerId}"`,
              VirtualRouterErrorCode.CONFIG_ERROR
            );
          }
          const knownModels = modelInfo.models ?? [];
          if (!knownModels.length) {
            throw new VirtualRouterError(
              `Route "${routeName}" references provider "${parsed.providerId}" but provider declares no models`,
              VirtualRouterErrorCode.CONFIG_ERROR
            );
          }
          if (!knownModels.includes(parsed.modelId)) {
            throw new VirtualRouterError(
              `Route "${routeName}" references unknown model "${parsed.modelId}" for provider "${parsed.providerId}"`,
              VirtualRouterErrorCode.CONFIG_ERROR
            );
          }
        }
        const aliases = parsed.keyAlias ? [parsed.keyAlias] : aliasIndex.get(parsed.providerId)!;
        if (!aliases.length) {
          throw new VirtualRouterError(
            `Provider ${parsed.providerId} has no auth aliases but is referenced in routing`,
            VirtualRouterErrorCode.CONFIG_ERROR
          );
        }
        for (const alias of aliases) {
          const runtimeKey = buildRuntimeKey(parsed.providerId, alias);
          const targetKey = `${runtimeKey}.${parsed.modelId}`;
          const existing = expandedTargets.find((candidate) => candidate.key === targetKey);
          if (existing) {
            if (parsed.priority > existing.priority) {
              existing.priority = parsed.priority;
            }
            continue;
          }
          expandedTargets.push({ key: targetKey, priority: parsed.priority, order: orderCounter });
          orderCounter += 1;
          targetKeys.add(targetKey);
        }
      }
      if (expandedTargets.length) {
        const sortedTargets =
          pool.mode === 'priority'
            ? [...expandedTargets]
                .sort((a, b) => {
                  if (a.priority !== b.priority) {
                    return b.priority - a.priority;
                  }
                  return a.order - b.order;
                })
                .map((candidate) => candidate.key)
            : expandedTargets.map((candidate) => candidate.key);
        expandedPools.push({
          id: pool.id,
          priority: pool.priority,
          backup: pool.backup,
          targets: sortedTargets,
          ...(pool.mode ? { mode: pool.mode } : {}),
          ...(pool.force ? { force: true } : {}),
          ...(pool.loadBalancing ? { loadBalancing: pool.loadBalancing } : {})
        });
      }
    }
    routing[routeName] = expandedPools;
  }
  return { routing, targetKeys };
}

function buildLegacyRoutePool(routeName: string, targets: string[]): NormalizedRoutePoolConfig {
  return {
    id: `${routeName}:pool0`,
    priority: targets.length,
    backup: false,
    targets
  };
}

function normalizeRoutePoolEntry(
  routeName: string,
  entry: unknown,
  index: number,
  total: number
): NormalizedRoutePoolConfig | null {
  if (typeof entry === 'string') {
    const targets = normalizeTargetList(entry);
    return targets.length
      ? {
          id: `${routeName}:pool${index + 1}`,
          priority: total - index,
          backup: false,
          targets
        }
      : null;
  }
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const id =
    readOptionalString(record.id as string | undefined) ??
    readOptionalString((record as any).poolId) ??
    `${routeName}:pool${index + 1}`;
  const backup =
    record.backup === true ||
    record.isBackup === true ||
    (typeof record.type === 'string' && record.type.toLowerCase() === 'backup');
  const priority = normalizePriorityValue(record.priority, total - index);
  const loadBalancing = normalizeRoutePoolLoadBalancing(record.loadBalancing);
  const targets = normalizeRouteTargets(record, loadBalancing);
  const explicitMode = normalizeRoutePoolMode(record.mode ?? (record as any).strategy ?? (record as any).routingMode);
  const mode =
    explicitMode ??
    inferRoutePoolModeFromConfig(record, targets, loadBalancing);
  const force =
    record.force === true ||
    (typeof record.force === 'string' && record.force.trim().toLowerCase() === 'true');
  return targets.length
    ? {
        id,
        priority,
        backup,
        targets,
        ...(mode ? { mode } : {}),
        ...(force ? { force: true } : {}),
        ...(loadBalancing ? { loadBalancing } : {})
      }
    : null;
}

function inferRoutePoolModeFromConfig(
  record: Record<string, unknown>,
  targets: string[],
  loadBalancing?: RoutePoolLoadBalancingPolicy
): 'priority' | undefined {
  if (!targets.length) {
    return undefined;
  }
  if (hasExplicitRouteTargets(record)) {
    return undefined;
  }
  const nested = asLoadBalancingRecord(record.loadBalancing);
  const hasNestedOrderedTargets =
    normalizeTargetList(nested?.targets).length > 0 ||
    normalizeTargetList(nested?.providers).length > 0 ||
    normalizeTargetList(nested?.order).length > 0 ||
    normalizeTargetList(nested?.entries).length > 0 ||
    normalizeTargetList(nested?.items).length > 0 ||
    normalizeTargetList(nested?.routes).length > 0 ||
    normalizeTargetList(nested?.target).length > 0 ||
    normalizeTargetList(nested?.provider).length > 0;
  if (hasNestedOrderedTargets) {
    return 'priority';
  }
  if (loadBalancing?.weights && Object.keys(loadBalancing.weights).length > 0) {
    return 'priority';
  }
  return undefined;
}

function normalizeRoutePoolLoadBalancing(input: unknown): RoutePoolLoadBalancingPolicy | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const strategy = normalizeWeightedStrategy(record.strategy);
  const weightsRaw = record.weights && typeof record.weights === 'object' && !Array.isArray(record.weights)
    ? (record.weights as Record<string, unknown>)
    : {};
  const weights: Record<string, number> = {};
  for (const [key, value] of Object.entries(weightsRaw)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      weights[key] = value;
    }
  }
  if (!strategy && Object.keys(weights).length === 0) {
    return undefined;
  }
  return {
    ...(strategy ? { strategy } : {}),
    ...(Object.keys(weights).length ? { weights } : {})
  };
}

function normalizeWeightedStrategy(value: unknown): 'round-robin' | 'weighted' | 'sticky' | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === 'weighted') {
    return 'weighted';
  }
  if (normalized === 'sticky') {
    return 'sticky';
  }
  if (normalized === 'round-robin' || normalized === 'round_robin' || normalized === 'roundrobin' || normalized === 'rr') {
    return 'round-robin';
  }
  return undefined;
}

function normalizeRoutePoolMode(value: unknown): 'round-robin' | 'priority' | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === 'priority') {
    return 'priority';
  }
  if (
    normalized === 'round-robin' ||
    normalized === 'round_robin' ||
    normalized === 'roundrobin' ||
    normalized === 'rr'
  ) {
    return 'round-robin';
  }
  return undefined;
}

function normalizeRouteTargets(record: Record<string, unknown>, loadBalancing?: RoutePoolLoadBalancingPolicy): string[] {
  const loadBalancingRecord = asLoadBalancingRecord(record.loadBalancing);
  const buckets = [
    record.targets,
    record.providers,
    record.pool,
    record.entries,
    record.items,
    record.routes,
    loadBalancingRecord?.targets,
    loadBalancingRecord?.providers,
    loadBalancingRecord?.order,
    loadBalancingRecord?.entries,
    loadBalancingRecord?.items,
    loadBalancingRecord?.routes
  ];
  const normalized: string[] = [];
  for (const bucket of buckets) {
    for (const target of normalizeTargetList(bucket)) {
      if (!normalized.includes(target)) {
        normalized.push(target);
      }
    }
  }
  const singular = [record.target, record.provider, loadBalancingRecord?.target, loadBalancingRecord?.provider];
  for (const candidate of singular) {
    for (const target of normalizeTargetList(candidate)) {
      if (!normalized.includes(target)) {
        normalized.push(target);
      }
    }
  }
  if (normalized.length === 0 && loadBalancing?.weights && Object.keys(loadBalancing.weights).length > 0) {
    for (const target of Object.keys(loadBalancing.weights)) {
      const trimmed = target.trim();
      if (trimmed && !normalized.includes(trimmed)) {
        normalized.push(trimmed);
      }
    }
  }
  return normalized;
}

function asLoadBalancingRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function hasExplicitRouteTargets(record: Record<string, unknown>): boolean {
  const explicitBuckets = [record.targets, record.providers, record.pool, record.entries, record.items, record.routes];
  if (explicitBuckets.some((bucket) => normalizeTargetList(bucket).length > 0)) {
    return true;
  }
  return normalizeTargetList(record.target).length > 0 || normalizeTargetList(record.provider).length > 0;
}

function normalizeTargetList(value: unknown): string[] {
  if (Array.isArray(value)) {
    const normalized: string[] = [];
    for (const entry of value) {
      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (trimmed && !normalized.includes(trimmed)) {
          normalized.push(trimmed);
        }
      }
    }
    return normalized;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (typeof value === 'number') {
    const str = String(value).trim();
    return str ? [str] : [];
  }
  return [];
}

function normalizePriorityValue(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return fallback;
}

function parseRouteEntry(
  entry: string,
  aliasIndex: Map<string, string[]>
): { providerId: string; keyAlias?: string; modelId: string; priority: number } | null {
  const value = typeof entry === 'string' ? entry.trim() : '';
  if (!value) return null;
  const firstDot = value.indexOf('.');
  if (firstDot <= 0 || firstDot === value.length - 1) return null;
  const providerId = value.slice(0, firstDot);
  const remainder = value.slice(firstDot + 1);

  const aliases = aliasIndex.get(providerId);
  if (aliases && aliases.length) {
    const secondDot = remainder.indexOf('.');
    if (secondDot > 0 && secondDot < remainder.length - 1) {
      const aliasCandidate = remainder.slice(0, secondDot);
      if (aliases.includes(aliasCandidate)) {
        const parsed = splitModelPriority(remainder.slice(secondDot + 1));
        return {
          providerId,
          keyAlias: aliasCandidate,
          modelId: parsed.modelId,
          priority: parsed.priority
        };
      }
    }
  }

  const parsed = splitModelPriority(remainder);
  return { providerId, modelId: parsed.modelId, priority: parsed.priority };
}

function splitModelPriority(raw: string): { modelId: string; priority: number } {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    return { modelId: value, priority: 100 };
  }
  const match = value.match(/^(.*):(\d+)$/);
  if (!match) {
    return { modelId: value, priority: 100 };
  }
  const modelId = (match[1] ?? '').trim();
  const priorityRaw = (match[2] ?? '').trim();
  const parsed = Number(priorityRaw);
  if (!modelId) {
    return { modelId: value, priority: 100 };
  }
  if (!Number.isFinite(parsed)) {
    return { modelId, priority: 100 };
  }
  return { modelId, priority: parsed };
}

export function parseTargetKey(targetKey: string): { providerId: string; keyAlias: string; modelId: string } | null {
  const value = typeof targetKey === 'string' ? targetKey.trim() : '';
  if (!value) return null;
  const firstDot = value.indexOf('.');
  if (firstDot <= 0 || firstDot === value.length - 1) return null;
  const providerId = value.slice(0, firstDot);
  const remainder = value.slice(firstDot + 1);
  const secondDot = remainder.indexOf('.');
  if (secondDot <= 0 || secondDot === remainder.length - 1) return null;
  return {
    providerId,
    keyAlias: remainder.slice(0, secondDot),
    modelId: remainder.slice(secondDot + 1)
  };
}

export function buildRuntimeKey(providerId: string, keyAlias: string): string {
  return `${providerId}.${keyAlias}`;
}
