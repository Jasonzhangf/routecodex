import { writeClientSnapshot } from '../../../../providers/core/utils/snapshot-writer.js';
import {
  evaluateSingletonRoutePoolExhaustionNative,
  planPrimaryExhaustedToDefaultPoolNative,
  resolveErrorErr05RouteAvailabilityDecisionNative
} from '../../../../modules/llmswitch/bridge/route-availability-host.js';
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

export interface RouteAvailabilityDecisionNativeArgs {
  routeName?: string;
  routePool?: string[];
  routeTiers?: Array<{ id?: string; targets: string[]; priority?: number; backup?: boolean }>;
  defaultRouteTiers?: Array<{ id?: string; targets: string[]; priority?: number; backup?: boolean }>;
  excludedProviderKeys: Set<string>;
  providerKey?: string;
  routingDecisionRoutePoolPresent?: boolean;
}

export interface RouteAvailabilityDecisionNativeResult {
  routePoolRemainingAfterExclusion: string[];
  remainingRouteCandidates: number;
  defaultPoolAvailable: boolean;
  policyExhausted: boolean;
  mayProject: boolean;
  routePoolAuthoritative: boolean;
  verifiedLastProvider: boolean;
  hasAlternativeCandidate: boolean;
  reasonCode: string;
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

export function resolveErrorErr05RouteAvailabilityDecision(
  input: RouteAvailabilityDecisionNativeArgs
): RouteAvailabilityDecisionNativeResult {
  return resolveErrorErr05RouteAvailabilityDecisionNative({
    routeName: input.routeName,
    routePool: input.routePool ?? [],
    routeTiers: input.routeTiers ?? [],
    defaultRouteTiers: input.defaultRouteTiers ?? [],
    excludedProviderKeys: input.excludedProviderKeys,
    providerKey: input.providerKey,
    routingDecisionRoutePoolPresent: input.routingDecisionRoutePoolPresent === true,
  });
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
