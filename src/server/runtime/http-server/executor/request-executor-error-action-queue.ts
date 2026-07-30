import {
  abandonProviderActionAdmissionNative,
  beginProviderActionWaitNative,
  cancelProviderActionWaitNative,
  commitProviderActionTerminalNative,
  peekProviderActionWaitNative,
  pollProviderActionAdmissionNative,
  readProviderActionGateContractNative,
  recordProviderActionFailureNative,
  recordProviderActionSuccessNative,
  resetProviderActionGateNative
} from '../../../../modules/llmswitch/bridge/provider-action-gate-host.js';
import {
  throwIfClientAbortSignalAborted,
  waitWithClientAbortSignal
} from './request-executor-abort.js';

export const ERROR_ACTION_QUEUE_FEATURE_ID = 'feature_id: error.provider_action_gate';

export type ErrorActionCategory =
  | 'global_error'
  | 'session_storm'
  | 'servertool_followup';

export type ErrorActionQueueEvent =
  | {
      type: 'record';
      category: ErrorActionCategory;
      scopeKey: string;
      consecutive: number;
      delayMs: number;
    }
  | {
      type: 'wait_start' | 'wait_end';
      category: ErrorActionCategory;
      scopeKey: string;
      delayMs: number;
    };

type LogNonBlockingError = (stage: string, error: unknown, details?: Record<string, unknown>) => void;
type ErrorActionQueueHook = (event: ErrorActionQueueEvent) => void;
type AdmissionAbortRegistration = {
  category: ErrorActionCategory;
  laneKey: string;
  laneGroupKey?: string;
  actionScopeKey: string;
  generation: number;
  signal: AbortSignal;
  onAbort: () => void;
};

const hooks = new Set<ErrorActionQueueHook>();
const admissionAbortRegistrations = new Set<AdmissionAbortRegistration>();
let waiterSequence = 0;

export function describeErrorActionQueueContract(): {
  featureId: string;
  isolatedDelayMs: number;
  sustainedDelayMs: number;
  blockingWait: true;
  singleAdmissionPerGeneration: true;
  explicitAdmissionOwnership: true;
  wallClockExpiryForbidden: true;
  waiterOrder: 'fifo_ticket';
  abandonIsHealthNeutral: true;
  categories: ErrorActionCategory[];
  hookEvents: Array<ErrorActionQueueEvent['type']>;
} {
  const contract = readProviderActionGateContractNative();
  return {
    featureId: ERROR_ACTION_QUEUE_FEATURE_ID,
    isolatedDelayMs: contract.isolatedDelayMs,
    sustainedDelayMs: contract.sustainedDelayMs,
    blockingWait: true,
    singleAdmissionPerGeneration: contract.singleAdmissionPerGeneration,
    explicitAdmissionOwnership: contract.explicitAdmissionOwnership,
    wallClockExpiryForbidden: contract.wallClockExpiryForbidden,
    waiterOrder: contract.waiterOrder,
    abandonIsHealthNeutral: contract.abandonIsHealthNeutral,
    categories: [
      'global_error',
      'session_storm',
      'servertool_followup'
    ],
    hookEvents: ['record', 'wait_start', 'wait_end']
  };
}

function normalizeScopeKey(scopeKey: string): string {
  return scopeKey.trim() || 'unknown';
}

function buildQueueKey(category: ErrorActionCategory, scopeKey: string): string {
  return `${category}|${normalizeScopeKey(scopeKey)}`;
}

function readBackoffPortScope(metadata?: Record<string, unknown>): string {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return 'unknown-port';
  }
  const candidates = [
    metadata.routecodexRoutingPolicyGroup,
    metadata.routecodexPort,
    metadata.routecodexLocalPort,
    metadata.routecodexPortMode
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return String(Math.floor(candidate));
    }
  }
  return 'unknown-port';
}

export function resolveProviderTransportBackoffScopeKey(args: {
  providerTransportBackoffKey?: string;
  portScope?: string;
  metadata?: Record<string, unknown>;
  providerKey?: string;
}): string {
  if (typeof args.providerTransportBackoffKey === 'string' && args.providerTransportBackoffKey.trim()) {
    return args.providerTransportBackoffKey.trim();
  }
  const portScope =
    typeof args.portScope === 'string' && args.portScope.trim()
      ? args.portScope.trim()
      : readBackoffPortScope(args.metadata);
  const providerKey =
    typeof args.providerKey === 'string' && args.providerKey.trim()
      ? args.providerKey.trim()
      : 'unknown-provider';
  return `${normalizeScopeKey(portScope)}|${normalizeScopeKey(providerKey)}|transport`;
}

export function resolveProviderSwitchBackoffScopeKey(args: {
  providerSwitchBackoffKey?: string;
  portScope?: string;
  metadata?: Record<string, unknown>;
  routeName?: string;
}): string {
  if (typeof args.providerSwitchBackoffKey === 'string' && args.providerSwitchBackoffKey.trim()) {
    return args.providerSwitchBackoffKey.trim();
  }
  const portScope =
    typeof args.portScope === 'string' && args.portScope.trim()
      ? args.portScope.trim()
      : readBackoffPortScope(args.metadata);
  const routeName =
    typeof args.routeName === 'string' && args.routeName.trim()
      ? args.routeName.trim()
      : 'unknown-route';
  return `${normalizeScopeKey(portScope)}|${normalizeScopeKey(routeName)}|provider-switch`;
}

export function recordProviderTransportBackoff(args: {
  providerKey?: string;
  portScope?: string;
  metadata?: Record<string, unknown>;
  providerTransportBackoffKey?: string;
}): number {
  return recordErrorActionBackoff({
    category: 'global_error',
    scopeKey: resolveProviderTransportBackoffScopeKey(args)
  });
}

export function recordProviderSwitchBackoff(args: {
  routeName?: string;
  portScope?: string;
  metadata?: Record<string, unknown>;
  providerSwitchBackoffKey?: string;
}): number {
  return recordErrorActionBackoff({
    category: 'global_error',
    scopeKey: resolveProviderSwitchBackoffScopeKey(args)
  });
}

export async function waitProviderTransportBackoffWithGate(args: {
  providerKey?: string;
  portScope?: string;
  metadata?: Record<string, unknown>;
  providerTransportBackoffKey?: string;
  signal?: AbortSignal;
  logNonBlockingError?: LogNonBlockingError;
}): Promise<number> {
  return waitErrorActionBackoffWithGate({
    category: 'global_error',
    scopeKey: resolveProviderTransportBackoffScopeKey(args),
    signal: args.signal,
    logNonBlockingError: args.logNonBlockingError
  });
}

export async function waitProviderSwitchBackoffWithGate(args: {
  routeName?: string;
  portScope?: string;
  metadata?: Record<string, unknown>;
  providerSwitchBackoffKey?: string;
  signal?: AbortSignal;
  logNonBlockingError?: LogNonBlockingError;
}): Promise<number> {
  return waitErrorActionBackoffWithGate({
    category: 'global_error',
    scopeKey: resolveProviderSwitchBackoffScopeKey(args),
    signal: args.signal,
    logNonBlockingError: args.logNonBlockingError
  });
}

function emitHook(event: ErrorActionQueueEvent): void {
  for (const hook of hooks) {
    hook(event);
  }
}

function disposeAdmissionAbortRegistrations(
  matches: (registration: {
    category: ErrorActionCategory;
    laneKey: string;
    laneGroupKey?: string;
    actionScopeKey: string;
  }) => boolean
): void {
  for (const registration of admissionAbortRegistrations) {
    if (!matches(registration)) {
      continue;
    }
    registration.signal.removeEventListener('abort', registration.onAbort);
    admissionAbortRegistrations.delete(registration);
  }
}

export function recordErrorActionBackoff(args: {
  category: ErrorActionCategory;
  scopeKey: string;
  laneGroupKey?: string;
  actionScopeKey?: string;
}): number {
  const scopeKey = normalizeScopeKey(args.scopeKey);
  const recorded = recordProviderActionFailureNative(
    buildQueueKey(args.category, scopeKey),
    args.laneGroupKey
      ? buildQueueKey(args.category, args.laneGroupKey)
      : undefined,
    args.actionScopeKey
  );
  if (args.actionScopeKey) {
    const laneGroupKey = args.laneGroupKey
      ? buildQueueKey(args.category, args.laneGroupKey)
      : undefined;
    disposeAdmissionAbortRegistrations((registration) =>
      registration.category === args.category
      && registration.actionScopeKey === args.actionScopeKey
      && (
        laneGroupKey
          ? registration.laneGroupKey === laneGroupKey
          : registration.laneKey === buildQueueKey(args.category, scopeKey)
      )
    );
  }
  emitHook({
    type: 'record',
    category: args.category,
    scopeKey,
    consecutive: recorded.generation,
    delayMs: recorded.minimumDelayMs
  });
  return recorded.minimumDelayMs;
}

export function peekErrorActionBackoffWaitMs(args: {
  category: ErrorActionCategory;
  scopeKey: string;
}): number {
  return peekProviderActionWaitNative(buildQueueKey(args.category, args.scopeKey));
}

export function resetErrorActionBackoff(args: {
  category?: ErrorActionCategory;
  scopeKey?: string;
} = {}): void {
  if (args.category && args.scopeKey) {
    const laneKey = buildQueueKey(args.category, args.scopeKey);
    resetProviderActionGateNative({
      laneKey
    });
    disposeAdmissionAbortRegistrations((registration) => registration.laneKey === laneKey);
    return;
  }
  if (args.category) {
    resetProviderActionGateNative({ lanePrefix: `${args.category}|` });
    disposeAdmissionAbortRegistrations(
      (registration) => registration.category === args.category
    );
    return;
  }
  if (args.scopeKey) {
    throw new Error('reset by scopeKey requires an explicit error action category');
  }
  resetProviderActionGateNative({});
  disposeAdmissionAbortRegistrations(() => true);
}

export function resetErrorActionBackoffByScopePrefix(args: {
  category: ErrorActionCategory;
  scopePrefix: string;
}): void {
  const scopePrefix = normalizeScopeKey(args.scopePrefix);
  resetProviderActionGateNative({
    lanePrefix: `${args.category}|${scopePrefix}`
  });
  const lanePrefix = `${args.category}|${scopePrefix}`;
  disposeAdmissionAbortRegistrations(
    (registration) => registration.laneKey.startsWith(lanePrefix)
  );
}

export function resetErrorActionBackoffByLaneGroup(args: {
  category: ErrorActionCategory;
  laneGroupKey: string;
}): void {
  const laneGroupKey = buildQueueKey(args.category, args.laneGroupKey);
  resetProviderActionGateNative({
    laneGroupKey
  });
  disposeAdmissionAbortRegistrations(
    (registration) => registration.laneGroupKey === laneGroupKey
  );
}

export function recordErrorActionSuccessByLaneGroup(args: {
  category: ErrorActionCategory;
  laneGroupKey: string;
  actionScopeKey: string;
}): boolean {
  const laneGroupKey = buildQueueKey(args.category, args.laneGroupKey);
  const actionScopeKey = normalizeScopeKey(args.actionScopeKey);
  const recorded = recordProviderActionSuccessNative(laneGroupKey, actionScopeKey);
  if (recorded.accepted) {
    disposeAdmissionAbortRegistrations((registration) =>
      registration.laneGroupKey === laneGroupKey
      && registration.actionScopeKey === actionScopeKey
    );
  }
  return recorded.accepted;
}

export async function waitErrorActionBackoffWithGate(args: {
  category: ErrorActionCategory;
  scopeKey: string;
  laneGroupKey?: string;
  actionScopeKey?: string;
  terminalProjection?: boolean;
  signal?: AbortSignal;
  logNonBlockingError?: LogNonBlockingError;
}): Promise<number> {
  const scopeKey = normalizeScopeKey(args.scopeKey);
  const laneKey = buildQueueKey(args.category, scopeKey);
  const laneGroupKey = args.laneGroupKey
    ? buildQueueKey(args.category, args.laneGroupKey)
    : undefined;
  const logNonBlockingError = args.logNonBlockingError ?? (() => undefined);
  let totalWaitMs = 0;
  for (;;) {
    const waiterId = `${process.pid}:${++waiterSequence}`;
    const actionScopeKey = normalizeScopeKey(args.actionScopeKey ?? waiterId);
    let poll = beginProviderActionWaitNative(laneKey, waiterId, actionScopeKey);
    try {
      while (poll.state === 'wait') {
        const waitMs = Math.max(1, Math.floor(poll.waitMs));
        emitHook({ type: 'wait_start', category: args.category, scopeKey, delayMs: waitMs });
        await waitWithClientAbortSignal(waitMs, args.signal, logNonBlockingError);
        totalWaitMs += waitMs;
        emitHook({ type: 'wait_end', category: args.category, scopeKey, delayMs: waitMs });
        poll = pollProviderActionAdmissionNative(laneKey, waiterId, actionScopeKey);
      }
      if (!args.terminalProjection) {
        if (poll.state === 'admitted' && args.signal) {
          let registration: AdmissionAbortRegistration | undefined;
          const abandon = (): void => {
            if (registration) {
              admissionAbortRegistrations.delete(registration);
            }
            abandonProviderActionAdmissionNative(
              laneKey,
              poll.generation,
              actionScopeKey
            );
          };
          if (args.signal.aborted) {
            abandon();
            throwIfClientAbortSignalAborted(args.signal);
          } else {
            registration = {
              category: args.category,
              laneKey,
              laneGroupKey,
              actionScopeKey,
              generation: poll.generation,
              signal: args.signal,
              onAbort: abandon
            };
            admissionAbortRegistrations.add(registration);
            args.signal.addEventListener('abort', abandon, { once: true });
            if (args.signal.aborted) {
              abandon();
              throwIfClientAbortSignalAborted(args.signal);
            }
          }
        }
        return totalWaitMs;
      }
      if (
        poll.state === 'admitted'
        && commitProviderActionTerminalNative(
          laneKey,
          poll.generation,
          actionScopeKey
        )
      ) {
        disposeAdmissionAbortRegistrations((registration) =>
          registration.laneKey === laneKey
          && registration.actionScopeKey === actionScopeKey
        );
        return totalWaitMs;
      }
    } finally {
      cancelProviderActionWaitNative(laneKey, waiterId, actionScopeKey);
    }
    const recorded = recordProviderActionFailureNative(
      laneKey,
      laneGroupKey,
      actionScopeKey
    );
    emitHook({
      type: 'record',
      category: args.category,
      scopeKey,
      consecutive: recorded.generation,
      delayMs: recorded.minimumDelayMs
    });
  }
}

export function registerErrorActionQueueHook(hook: ErrorActionQueueHook): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

export function resetErrorActionQueueStateForTests(): void {
  resetProviderActionGateNative({});
  disposeAdmissionAbortRegistrations(() => true);
  hooks.clear();
  waiterSequence = 0;
}
