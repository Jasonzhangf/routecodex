import { writeClientSnapshot } from '../../../../providers/core/utils/snapshot-writer.js';
import {
  evaluateSingletonRoutePoolExhaustionNative,
  planPrimaryExhaustedToDefaultPoolNative
} from '../../../../modules/llmswitch/bridge/native-exports.js';
import { asRecord } from '../provider-utils.js';
import type { PipelineExecutionInput } from '../../../handlers/types.js';
import { formatUnknownError, isRecord } from '../../../../utils/common-utils.js';


function logRequestExecutorCoreNonBlockingError(
  stage: string,
  error: unknown,
  details?: Record<string, unknown>
): void {
  try {
    const detailSuffix = details && Object.keys(details).length > 0 ? ` details=${JSON.stringify(details)}` : '';
    console.warn(
      `[request-executor-core] ${stage} failed (non-blocking): ${formatUnknownError(error)}${detailSuffix}`
    );
  } catch {
    // Never throw from non-blocking logging.
  }
}

export async function writeInboundClientSnapshot(options: {
  input: PipelineExecutionInput;
  initialMetadata: Record<string, unknown>;
  clientRequestId: string;
}): Promise<void> {
  const { input, initialMetadata, clientRequestId } = options;
  try {
    const headerUa =
      (typeof input.headers?.['user-agent'] === 'string' && input.headers['user-agent']) ||
      (typeof input.headers?.['User-Agent'] === 'string' && input.headers['User-Agent']);
    const headerOriginator =
      (typeof input.headers?.['originator'] === 'string' && input.headers['originator']) ||
      (typeof input.headers?.['Originator'] === 'string' && input.headers['Originator']);
    await writeClientSnapshot({
      entryEndpoint: input.entryEndpoint,
      requestId: input.requestId,
      headers: asRecord(input.headers),
      body: input.body,
      metadata: {
        ...initialMetadata,
        clientRequestId,
        userAgent: headerUa,
        clientOriginator: headerOriginator
      }
    });
  } catch (error) {
    logRequestExecutorCoreNonBlockingError('writeInboundClientSnapshot', error, {
      entryEndpoint: input.entryEndpoint,
      requestId: input.requestId,
      clientRequestId
    });
  }
}

export function isPoolExhaustedPipelineError(pipelineError: unknown): boolean {
  const pipelineErrorCode =
    typeof (pipelineError as { code?: unknown }).code === 'string'
      ? String((pipelineError as { code?: string }).code).trim()
      : '';
  const pipelineErrorMessage =
    pipelineError instanceof Error
      ? pipelineError.message
      : String(pipelineError ?? 'Unknown error');
  return (
    pipelineErrorCode === 'PROVIDER_NOT_AVAILABLE' ||
    pipelineErrorCode === 'HTTP_429' ||
    pipelineErrorCode === 'ERR_NO_PROVIDER_TARGET' ||
    /all providers unavailable/i.test(pipelineErrorMessage) ||
    /virtual router did not produce a provider target/i.test(pipelineErrorMessage)
  );
}

export interface ResolvePrimaryExhaustedPlanInput {
  route: string;
  exhaustedTargets: string[];
  knownTargets: string[];
  tiers: Array<{ id: string; targets: string[]; priority: number; backup?: boolean }>;
}

export interface ResolvePrimaryExhaustedPlanOutput {
  status: 'no_default_pool_needed' | 'default_pool' | 'unknown_target' | 'route_not_configured';
  defaultPoolTargets: string[];
  fromTierId?: string | null;
  fromTierPriority?: number | null;
}

export interface PrimaryExhaustedRoutingContext {
  route: string;
  exhaustedTargets: string[];
}

export interface ResolveSingletonRoutePoolExhaustionDecisionInput {
  pipelineError: unknown;
  initialRoutePoolLen?: number | null;
  explicitSingletonPool?: boolean;
  excludedProviderCount: number;
}

export interface ResolveSingletonRoutePoolExhaustionDecisionOutput {
  shouldBlock: boolean;
  waitMs?: number;
  candidateProviderCount?: number;
}

export function resolveRoutePoolAuthoritativeForRetry(args: {
  routingDecision?: Record<string, unknown>;
  routePoolForAttempt: string[];
  routeTiersForAttempt?: Array<{ targets: string[]; backup?: boolean }>;
  defaultTierAvailable: boolean;
  excludedProviderKeys: Set<string>;
}): boolean {
  const decisionRoutePool = args.routingDecision?.routePool;
  if (!Array.isArray(decisionRoutePool) || decisionRoutePool.length === 0) {
    return false;
  }
  if (args.routePoolForAttempt.length > 1) {
    return true;
  }
  const configuredCandidateCount =
    Array.isArray(args.routeTiersForAttempt) && args.routeTiersForAttempt.length > 0
      ? new Set(
        args.routeTiersForAttempt
          .flatMap((tier) => Array.isArray(tier.targets) ? tier.targets : [])
          .filter((target): target is string => typeof target === 'string' && target.trim().length > 0)
          .map((target) => target.trim())
      ).size
      : null;
  return args.routePoolForAttempt.length === 1
    && configuredCandidateCount === 1
    && args.defaultTierAvailable === false
    && args.excludedProviderKeys.size === 0;
}

export function isReselectedExcludedProviderVerifiedLastProvider(args: {
  providerKey: string;
  routingDecision?: Record<string, unknown>;
  routePoolForAttempt: string[];
  routeTiersForAttempt?: Array<{ targets: string[]; backup?: boolean }>;
  defaultTierAvailable: boolean;
}): boolean {
  const decisionRoutePool = args.routingDecision?.routePool;
  if (!Array.isArray(decisionRoutePool) || decisionRoutePool.length === 0) {
    return false;
  }
  const routePool = args.routePoolForAttempt
    .map((target) => typeof target === 'string' ? target.trim() : '')
    .filter((target) => target.length > 0);
  if (routePool.length !== 1 || routePool[0] !== args.providerKey) {
    return false;
  }
  const configuredCandidates = new Set(
    (args.routeTiersForAttempt ?? [])
      .flatMap((tier) => Array.isArray(tier.targets) ? tier.targets : [])
      .filter((target): target is string => typeof target === 'string' && target.trim().length > 0)
      .map((target) => target.trim())
  );
  return configuredCandidates.size === 1
    && configuredCandidates.has(args.providerKey)
    && args.defaultTierAvailable === false;
}

function normalizePrimaryExhaustedRouteName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const bare = trimmed.split('/').map((part) => part.trim()).find(Boolean);
  return bare || undefined;
}

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readPrimaryExhaustedTargets(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || out.includes(trimmed)) {
      continue;
    }
    out.push(trimmed);
  }
  return out;
}

export function resolvePrimaryExhaustedRoutingContextFromError(
  error: unknown,
): PrimaryExhaustedRoutingContext | null {
  const details = asObjectRecord((error as { details?: unknown } | null | undefined)?.details);
  if (!details) {
    return null;
  }

  const route = normalizePrimaryExhaustedRouteName(details.primaryExhaustedRouteName);
  let exhaustedTargets = readPrimaryExhaustedTargets(details.primaryExhaustedTargets);

  if ((!route || exhaustedTargets.length === 0) && Array.isArray(details.unavailableRoutePools)) {
    const firstRouteName = details.unavailableRoutePools
      .map((entry) => asObjectRecord(entry))
      .map((entry) => normalizePrimaryExhaustedRouteName(entry?.routeName))
      .find((value): value is string => Boolean(value));
    if (firstRouteName) {
      const derivedTargets: string[] = [];
      for (const rawEntry of details.unavailableRoutePools) {
        const entry = asObjectRecord(rawEntry);
        if (!entry) {
          continue;
        }
        if (normalizePrimaryExhaustedRouteName(entry.routeName) !== firstRouteName) {
          continue;
        }
        for (const target of readPrimaryExhaustedTargets(entry.poolTargets)) {
          if (!derivedTargets.includes(target)) {
            derivedTargets.push(target);
          }
        }
      }
      exhaustedTargets = exhaustedTargets.length > 0 ? exhaustedTargets : derivedTargets;
      return exhaustedTargets.length > 0 ? { route: route ?? firstRouteName, exhaustedTargets } : null;
    }
  }

  if (!route || exhaustedTargets.length === 0) {
    return null;
  }
  return { route, exhaustedTargets };
}

export function collectPrimaryExhaustedKnownTargets(
  tiers: Array<{ targets: string[] }>,
): string[] {
  const knownTargets: string[] = [];
  for (const tier of tiers) {
    if (!Array.isArray(tier.targets)) {
      continue;
    }
    for (const target of tier.targets) {
      if (typeof target !== 'string' || !target.trim() || knownTargets.includes(target)) {
        continue;
      }
      knownTargets.push(target);
    }
  }
  return knownTargets;
}

export function resolveDefaultTierAvailableForErrorErr05(args: {
  tiers?: Array<{ targets: string[]; backup?: boolean }>;
  routePool?: string[];
  excludedProviderKeys: Set<string>;
}): boolean {
  const tiers = Array.isArray(args.tiers) ? args.tiers : [];
  const defaultTier = tiers.find((tier) => tier.backup === true);
  if (!defaultTier || !Array.isArray(defaultTier.targets)) {
    return false;
  }
  const routePool = new Set(
    (Array.isArray(args.routePool) ? args.routePool : [])
      .filter((target): target is string => typeof target === 'string' && target.trim().length > 0)
      .map((target) => target.trim())
  );
  for (const target of defaultTier.targets) {
    if (typeof target !== 'string') {
      continue;
    }
    const normalized = target.trim();
    if (!normalized || args.excludedProviderKeys.has(normalized)) {
      continue;
    }
    if (routePool.has(normalized)) {
      continue;
    }
    return true;
  }
  return false;
}

export function buildErrorErr05DefaultAvailabilityTiers(args: {
  routeName?: string;
  routeTiers?: Array<{ id?: string; targets: string[]; priority?: number; backup?: boolean }>;
  defaultRouteTiers?: Array<{ id?: string; targets: string[]; priority?: number; backup?: boolean }>;
}): Array<{ id?: string; targets: string[]; priority?: number; backup?: boolean }> {
  const routeTiers = Array.isArray(args.routeTiers) ? args.routeTiers : [];
  const defaultRouteTiers = Array.isArray(args.defaultRouteTiers) ? args.defaultRouteTiers : [];
  const routeName = typeof args.routeName === 'string' ? args.routeName.trim().toLowerCase() : '';
  if (!routeName || routeName === 'default' || defaultRouteTiers.length === 0) {
    return routeTiers;
  }
  return [
    ...routeTiers,
    ...defaultRouteTiers.map((tier) => ({
      ...tier,
      backup: true,
    })),
  ];
}

export function resolveErrorErr05RoutingPolicyGroup(args: {
  metadata?: Record<string, unknown>;
  portRoutingPolicyGroup?: string;
}): string | undefined {
  const metadataGroup = args.metadata?.routecodexRoutingPolicyGroup;
  if (typeof metadataGroup === 'string' && metadataGroup.trim()) {
    return metadataGroup.trim();
  }
  const portGroup = args.portRoutingPolicyGroup;
  return typeof portGroup === 'string' && portGroup.trim() ? portGroup.trim() : undefined;
}

/**
 * Host-side adapter around `evaluateSingletonRoutePoolExhaustionNative` (Rust).
 *
 * The singleton/default availability-floor decision belongs to Rust VR. The
 * executor may only consume the native decision and perform wait/log IO.
 */
export function resolveSingletonRoutePoolExhaustionDecision(
  input: ResolveSingletonRoutePoolExhaustionDecisionInput
): ResolveSingletonRoutePoolExhaustionDecisionOutput {
  return evaluateSingletonRoutePoolExhaustionNative({
    pipelineError: input.pipelineError,
    initialRoutePoolLen: input.initialRoutePoolLen,
    explicitSingletonPool: input.explicitSingletonPool === true,
    excludedProviderCount: input.excludedProviderCount
  });
}

/**
 * Host-side adapter around `planPrimaryExhaustedToDefaultPoolNative` (Rust).
 *
 * Per `docs/goals/provider-error-chain-direct-relay-audit-2026-06-15.md` G3:
 * the host MUST consult the Rust VR default-pool planner whenever a primary
 * route pool is exhausted; the host MUST NOT synthesize a default target list
 * locally. This helper is the only sanctioned host bridge.
 */
export function resolvePrimaryExhaustedPlan(
  input: ResolvePrimaryExhaustedPlanInput
): ResolvePrimaryExhaustedPlanOutput {
  return planPrimaryExhaustedToDefaultPoolNative({
    route: input.route,
    tiers: input.tiers,
    exhaustedTargets: input.exhaustedTargets,
    knownTargets: input.knownTargets
  });
}

export function mergeMetadataPreservingDefined(
  base: Record<string, unknown>,
  overlay?: Record<string, unknown> | null
): Record<string, unknown> {
  const merged: Record<string, unknown> = Object.create(Object.getPrototypeOf(base) ?? Object.prototype);
  for (const key of Reflect.ownKeys(base)) {
    const descriptor = Object.getOwnPropertyDescriptor(base, key);
    if (descriptor) {
      Object.defineProperty(merged, key, descriptor);
    }
  }
  if (!overlay || typeof overlay !== 'object') {
    return merged;
  }
  for (const key of Reflect.ownKeys(overlay)) {
    const value = Reflect.get(overlay, key);
    if (value !== undefined) {
      Reflect.set(merged, key, value);
    }
  }
  return merged;
}

export function asFlatRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
