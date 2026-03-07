import type { UnknownRecord } from '../commands/init/shared.js';

const OPTIONAL_POLICY_KEYS = [
  'loadBalancing',
  'classifier',
  'health',
  'contextRouting',
  'webSearch',
  'execCommandGuard',
  'session'
] as const;

const LEGACY_TOP_LEVEL_KEYS = [
  'oauthBrowser',
  'loadBalancing',
  'classifier',
  'providers',
  'routing',
  'quota',
  'session',
  'webSearch'
] as const;

export type RoutingConfig = Record<string, unknown>;
export type PolicyOptions = Partial<Record<(typeof OPTIONAL_POLICY_KEYS)[number], Record<string, unknown>>>;

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function cloneRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return { ...(value as Record<string, unknown>) };
}

function sanitizeTargets(targets: string[]): string[] {
  const unique = new Set<string>();
  for (const target of targets) {
    if (typeof target !== 'string') {
      continue;
    }
    const trimmed = target.trim();
    if (!trimmed) {
      continue;
    }
    unique.add(trimmed);
  }
  return Array.from(unique);
}

export function buildWeightedRoutePool(id: string, targets: string[]): Record<string, unknown> {
  const normalizedTargets = sanitizeTargets(targets);
  const weights = Object.fromEntries(normalizedTargets.map((target) => [target, 1]));
  return {
    id,
    targets: normalizedTargets,
    loadBalancing: {
      strategy: 'weighted',
      weights
    }
  };
}

export function buildInitRouting(args: {
  defaultTarget: string;
  thinkingTarget?: string;
  toolsTarget?: string;
  webSearchTargets?: string[];
}): RoutingConfig {
  const defaultTarget = args.defaultTarget.trim();
  const thinkingTarget = (args.thinkingTarget || defaultTarget).trim();
  const toolsTarget = (args.toolsTarget || defaultTarget).trim();
  const routing: RoutingConfig = {
    default: [buildWeightedRoutePool('primary', [defaultTarget])],
    thinking: [buildWeightedRoutePool('thinking-primary', [thinkingTarget])],
    tools: [buildWeightedRoutePool('tools-primary', [toolsTarget])]
  };
  const webSearchTargets = sanitizeTargets(args.webSearchTargets || []);
  if (webSearchTargets.length > 0) {
    routing.web_search = [buildWeightedRoutePool('web_search-primary', webSearchTargets)];
  }
  return routing;
}

function extractCurrentPolicyId(virtualRouter: UnknownRecord): string {
  const active = typeof virtualRouter.activeRoutingPolicyGroup === 'string'
    ? virtualRouter.activeRoutingPolicyGroup.trim()
    : '';
  return active || 'default';
}

function extractCurrentPolicyGroup(virtualRouter: UnknownRecord, policyId: string): UnknownRecord {
  const groups = asRecord(virtualRouter.routingPolicyGroups);
  if (isRecord(groups[policyId])) {
    return asRecord(groups[policyId]);
  }
  const currentPolicyId = extractCurrentPolicyId(virtualRouter);
  if (currentPolicyId !== policyId && isRecord(groups[currentPolicyId])) {
    return asRecord(groups[currentPolicyId]);
  }
  const materialized: UnknownRecord = {};
  for (const key of OPTIONAL_POLICY_KEYS) {
    const value = cloneRecord(virtualRouter[key]);
    if (value) {
      materialized[key] = value;
    }
  }
  return materialized;
}

function mergePolicyOptions(existingPolicy: UnknownRecord, explicit?: PolicyOptions): UnknownRecord {
  const nextPolicy: UnknownRecord = {};
  for (const key of OPTIONAL_POLICY_KEYS) {
    const explicitValue = explicit ? cloneRecord(explicit[key]) : undefined;
    if (explicitValue) {
      nextPolicy[key] = explicitValue;
      continue;
    }
    const existingValue = cloneRecord(existingPolicy[key]);
    if (existingValue) {
      nextPolicy[key] = existingValue;
    }
  }
  return nextPolicy;
}

export function buildV2ConfigObject(args: {
  host: string;
  port: number;
  routing: RoutingConfig;
  policyId?: string;
  policyOptions?: PolicyOptions;
  existing?: UnknownRecord;
}): UnknownRecord {
  const policyId = (args.policyId || 'default').trim() || 'default';
  const existing = asRecord(args.existing);
  const existingVirtualRouter = asRecord(existing.virtualrouter);
  const existingGroups = asRecord(existingVirtualRouter.routingPolicyGroups);
  const existingPolicy = extractCurrentPolicyGroup(existingVirtualRouter, policyId);
  const mergedPolicyOptions = mergePolicyOptions(existingPolicy, args.policyOptions);
  const nextPolicy: UnknownRecord = {
    ...mergedPolicyOptions,
    routing: args.routing
  };
  const nextGroups: UnknownRecord = {};
  for (const [groupId, groupNode] of Object.entries(existingGroups)) {
    if (!groupId.trim() || !isRecord(groupNode)) {
      continue;
    }
    nextGroups[groupId] = { ...(groupNode as Record<string, unknown>) };
  }
  nextGroups[policyId] = nextPolicy;

  const next: UnknownRecord = {
    ...existing,
    version: '2.0.0',
    virtualrouterMode: 'v2',
    httpserver: {
      ...asRecord(existing.httpserver),
      host: args.host,
      port: args.port
    },
    virtualrouter: {
      activeRoutingPolicyGroup: policyId,
      routingPolicyGroups: nextGroups
    }
  };

  for (const key of LEGACY_TOP_LEVEL_KEYS) {
    delete next[key];
  }

  return next;
}
