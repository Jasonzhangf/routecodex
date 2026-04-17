import type { LoadBalancingPolicy } from './types.js';

type StickyRouteEntry = {
  providerKey: string;
  updatedAtMs: number;
};

interface RouteState {
  pointer: number;
  stickyMap: Map<string, StickyRouteEntry>;
  weighted: {
    currentWeights: Map<string, number>;
  };
}

export interface LoadBalancingOptions {
  routeName: string;
  candidates: string[];
  stickyKey?: string;
  weights?: Record<string, number>;
  availabilityCheck: (providerKey: string) => boolean;
}

export interface GroupedLoadBalancingOptions {
  routeName: string;
  groups: Map<string, string[]>;
  stickyKey?: string;
  weights?: Record<string, number>;
  availabilityCheck: (providerKey: string) => boolean;
}

const DEFAULT_STICKY_TTL_MS = 30 * 60_000;
const DEFAULT_STICKY_MAX_ENTRIES = 4096;

function resolveStickyTtlMs(): number {
  const raw = process.env.ROUTECODEX_VR_STICKY_TTL_MS ?? process.env.RCC_VR_STICKY_TTL_MS;
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  if (Number.isFinite(parsed) && parsed >= 60_000) {
    return parsed;
  }
  return DEFAULT_STICKY_TTL_MS;
}

function resolveStickyMaxEntries(): number {
  const raw = process.env.ROUTECODEX_VR_STICKY_MAX_ENTRIES ?? process.env.RCC_VR_STICKY_MAX_ENTRIES;
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  if (Number.isFinite(parsed) && parsed >= 16) {
    return parsed;
  }
  return DEFAULT_STICKY_MAX_ENTRIES;
}

export class RouteLoadBalancer {
  private policy: LoadBalancingPolicy;
  private readonly states: Map<string, RouteState> = new Map();
  private readonly stickyTtlMs: number;
  private readonly stickyMaxEntries: number;

  constructor(policy?: LoadBalancingPolicy) {
    this.policy = policy ?? { strategy: 'round-robin' };
    this.stickyTtlMs = resolveStickyTtlMs();
    this.stickyMaxEntries = resolveStickyMaxEntries();
  }

  updatePolicy(policy?: LoadBalancingPolicy): void {
    if (policy) {
      this.policy = policy;
    }
  }

  getPolicy(): LoadBalancingPolicy {
    return this.policy;
  }

  select(options: LoadBalancingOptions, strategyOverride?: LoadBalancingPolicy['strategy']): string | null {
    const available = options.candidates.filter((candidate) => options.availabilityCheck(candidate));
    if (available.length === 0) {
      return null;
    }

    const strategy = strategyOverride ?? this.policy.strategy;
    switch (strategy) {
      case 'sticky':
        return this.selectSticky(options.routeName, available, options.stickyKey, options.weights ?? this.policy.weights);
      case 'weighted':
        return this.selectWeighted(options.routeName, available, options.weights ?? this.policy.weights);
      default:
        if (options.weights) {
          const distinct = new Set(available.map((candidate) => normalizeWeight(options.weights?.[candidate])));
          if (distinct.size > 1) {
            return this.selectWeighted(options.routeName, available, options.weights);
          }
        }
        return this.selectRoundRobin(options.routeName, available);
    }
  }

  selectGrouped(
    options: GroupedLoadBalancingOptions,
    strategyOverride?: LoadBalancingPolicy['strategy']
  ): string | null {
    const groupIds = Array.from(options.groups.keys()).filter((groupId) => {
      const members = options.groups.get(groupId) ?? [];
      return members.some((candidate) => options.availabilityCheck(candidate));
    });
    if (groupIds.length === 0) {
      return null;
    }

    const normalizedWeights = normalizeGroupWeights(groupIds, options.weights);
    const strategy = strategyOverride ?? this.policy.strategy;
    const groupRoute = `${options.routeName}:group`;

    let selectedGroup: string | null = null;
    switch (strategy) {
      case 'sticky':
        selectedGroup = this.selectSticky(groupRoute, groupIds, options.stickyKey, normalizedWeights);
        break;
      case 'weighted':
        selectedGroup = this.selectWeighted(groupRoute, groupIds, normalizedWeights);
        break;
      default:
        selectedGroup = this.selectRoundRobin(groupRoute, groupIds);
        break;
    }

    if (!selectedGroup) {
      return null;
    }
    const groupCandidates = (options.groups.get(selectedGroup) ?? []).filter((candidate) =>
      options.availabilityCheck(candidate)
    );
    if (groupCandidates.length === 0) {
      return null;
    }
    return this.selectRoundRobin(`${groupRoute}:${selectedGroup}`, groupCandidates);
  }

  private selectRoundRobin(routeName: string, candidates: string[]): string {
    const state = this.getState(routeName);
    const choice = candidates[state.pointer % candidates.length];
    state.pointer = (state.pointer + 1) % candidates.length;
    return choice;
  }

  private selectWeighted(routeName: string, candidates: string[], weights?: Record<string, number>): string {
    // Deterministic smooth weighted round-robin (no randomness) so routing behavior is testable and stable.
    // Each candidate with a positive weight is guaranteed to be selected eventually.
    const state = this.getState(routeName);
    const current = state.weighted.currentWeights;

    const candidateSet = new Set(candidates);
    for (const existing of Array.from(current.keys())) {
      if (!candidateSet.has(existing)) {
        current.delete(existing);
      }
    }
    for (const key of candidates) {
      if (!current.has(key)) {
        current.set(key, 0);
      }
    }

    const candidateWeights = candidates.map((candidate) => normalizeWeight(weights?.[candidate]));
    const totalWeight = candidateWeights.reduce((sum, w) => sum + w, 0);
    if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
      return this.selectRoundRobin(routeName, candidates);
    }

    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < candidates.length; i += 1) {
      const key = candidates[i];
      const w = candidateWeights[i];
      const next = (current.get(key) ?? 0) + w;
      current.set(key, next);
      if (next > bestScore) {
        bestScore = next;
        bestIndex = i;
      }
    }

    const selectedKey = candidates[bestIndex];
    current.set(selectedKey, (current.get(selectedKey) ?? 0) - totalWeight);
    return selectedKey;
  }

  private selectSticky(routeName: string, candidates: string[], stickyKey?: string, weights?: Record<string, number>): string {
    if (!stickyKey) {
      return this.selectRoundRobin(routeName, candidates);
    }
    const state = this.getState(routeName);
    const nowMs = Date.now();
    this.pruneStickyEntries(state, nowMs);
    const pinned = state.stickyMap.get(stickyKey);
    if (pinned && candidates.includes(pinned.providerKey)) {
      pinned.updatedAtMs = nowMs;
      return pinned.providerKey;
    }
    const choice =
      weights && Object.keys(weights).length > 0
        ? this.selectWeighted(`${routeName}:sticky`, candidates, weights)
        : this.selectRoundRobin(routeName, candidates);
    state.stickyMap.set(stickyKey, {
      providerKey: choice,
      updatedAtMs: nowMs
    });
    this.pruneStickyEntries(state, nowMs);
    return choice;
  }

  private pruneStickyEntries(state: RouteState, nowMs: number): void {
    for (const [key, entry] of state.stickyMap.entries()) {
      if (!entry || typeof entry.providerKey !== 'string' || nowMs - entry.updatedAtMs >= this.stickyTtlMs) {
        state.stickyMap.delete(key);
      }
    }
    if (state.stickyMap.size <= this.stickyMaxEntries) {
      return;
    }
    const sorted = Array.from(state.stickyMap.entries()).sort((a, b) => a[1].updatedAtMs - b[1].updatedAtMs);
    while (state.stickyMap.size > this.stickyMaxEntries && sorted.length > 0) {
      const [oldestKey] = sorted.shift()!;
      state.stickyMap.delete(oldestKey);
    }
  }

  private getState(routeName: string): RouteState {
    if (!this.states.has(routeName)) {
      this.states.set(routeName, { pointer: 0, stickyMap: new Map(), weighted: { currentWeights: new Map() } });
    }
    return this.states.get(routeName)!;
  }
}

function normalizeWeight(value: number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  return 1;
}

function normalizeGroupWeights(groupIds: string[], weights?: Record<string, number>): Record<string, number> | undefined {
  if (!weights || groupIds.length === 0) {
    return undefined;
  }
  const normalized: Record<string, number> = {};
  let total = 0;
  for (const id of groupIds) {
    const raw = weights[id];
    const value = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
    if (value > 0) {
      normalized[id] = value;
      total += value;
    }
  }
  if (!Number.isFinite(total) || total <= 0) {
    return undefined;
  }
  for (const id of Object.keys(normalized)) {
    normalized[id] = normalized[id] / total;
  }
  return normalized;
}
