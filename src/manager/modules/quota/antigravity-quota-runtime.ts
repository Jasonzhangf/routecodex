import type { ProviderErrorEvent, ProviderSuccessEvent } from '../../../modules/llmswitch/bridge.js';
import type * as llmsBridge from '../../../modules/llmswitch/bridge.js';
import {
  buildAntigravitySnapshotKey,
  parseAntigravityProviderKey
} from './antigravity-quota-helpers.js';
import type { QuotaRecordLike } from './antigravity-quota-persistence.js';

type CoreQuotaManagerLike = {
  updateProviderPoolState?: (options: {
    providerKey: string;
    inPool: boolean;
    reason?: string | null;
    cooldownUntil?: number | null;
    blacklistUntil?: number | null;
  }) => void;
  getQuotaView?: () => (providerKey: string) => unknown;
  onProviderError?: (ev: ProviderErrorEvent) => void;
  onProviderSuccess?: (ev: ProviderSuccessEvent) => void;
};

export function handleQuotaPersistenceIssue(options: {
  reason: string;
  lastReason: string | null;
  quotaStorePath: string | null;
  clearSessionAliasPins: () => { clearedBySession?: unknown; clearedByAlias?: unknown } | undefined;
}): string | null {
  const issue = typeof options.reason === 'string' ? options.reason.trim() : '';
  if (!issue || options.lastReason === issue) {
    return options.lastReason;
  }
  let clearedBySession = 0;
  let clearedByAlias = 0;
  try {
    const out = options.clearSessionAliasPins();
    clearedBySession =
      typeof out?.clearedBySession === 'number' && Number.isFinite(out.clearedBySession)
        ? Math.max(0, Math.floor(out.clearedBySession))
        : 0;
    clearedByAlias =
      typeof out?.clearedByAlias === 'number' && Number.isFinite(out.clearedByAlias)
        ? Math.max(0, Math.floor(out.clearedByAlias))
        : 0;
  } catch {
    // best-effort only
  }
  const quotaPath = options.quotaStorePath || '(unknown)';
  console.warn(
    `[quota] persistence issue (${issue}); cleared antigravity session bindings for safety ` +
      `(sessionPins=${clearedBySession}, aliasPins=${clearedByAlias}, store=${quotaPath})`
  );
  return issue;
}

export async function subscribeToProviderCenters(options: {
  bridge: typeof llmsBridge;
  coreQuotaManager: CoreQuotaManagerLike | null;
}): Promise<{ providerErrorUnsub: (() => void) | null; providerSuccessUnsub: (() => void) | null }> {
  const mgr = options.coreQuotaManager;
  if (!mgr) {
    return { providerErrorUnsub: null, providerSuccessUnsub: null };
  }

  let providerErrorUnsub: (() => void) | null = null;
  let errorCenter: { subscribe?: (handler: (ev: ProviderErrorEvent) => void) => () => void } | null = null;
  try {
    errorCenter = (await options.bridge.getProviderErrorCenter()) as any;
  } catch {
    errorCenter = null;
  }
  if (errorCenter && typeof errorCenter.subscribe === 'function' && typeof mgr.onProviderError === 'function') {
    try {
      providerErrorUnsub = errorCenter.subscribe((ev: ProviderErrorEvent) => {
        try {
          mgr.onProviderError?.(ev);
        } catch {
          // ignore
        }
      });
    } catch {
      providerErrorUnsub = null;
    }
  }

  let providerSuccessUnsub: (() => void) | null = null;
  let successCenter: { subscribe?: (handler: (ev: ProviderSuccessEvent) => void) => () => void } | null = null;
  try {
    successCenter = (await options.bridge.getProviderSuccessCenter()) as any;
  } catch {
    successCenter = null;
  }
  if (successCenter && typeof successCenter.subscribe === 'function' && typeof mgr.onProviderSuccess === 'function') {
    try {
      providerSuccessUnsub = successCenter.subscribe((ev: ProviderSuccessEvent) => {
        try {
          mgr.onProviderSuccess?.(ev);
        } catch {
          // ignore
        }
      });
    } catch {
      providerSuccessUnsub = null;
    }
  }
  return { providerErrorUnsub, providerSuccessUnsub };
}

export function scheduleNextRefresh(options: {
  currentTimer: NodeJS.Timeout | null;
  getRefreshDisabled: () => boolean;
  getRefreshFailures: () => number;
  refreshAllAntigravityQuotas: () => Promise<{ attempted: number; successCount: number; failureCount: number }>;
  onRefreshFailuresChange: (nextFailures: number) => void;
  onRefreshDisabledChange: (nextDisabled: boolean) => void;
  onReschedule: () => void;
}): NodeJS.Timeout | null {
  if (options.currentTimer) {
    clearTimeout(options.currentTimer);
  }
  if (options.getRefreshDisabled()) {
    return null;
  }
  const delayMs = 5 * 60 * 1000;
  const timer = setTimeout(() => {
    void options
      .refreshAllAntigravityQuotas()
      .then((result) => {
        if (result.attempted > 0 && result.successCount === 0) {
          const nextFailures = options.getRefreshFailures() + 1;
          options.onRefreshFailuresChange(nextFailures);
          if (nextFailures >= 3) {
            options.onRefreshDisabledChange(true);
          }
        } else if (result.successCount > 0) {
          options.onRefreshFailuresChange(0);
        }
      })
      .catch(() => {
        const nextFailures = options.getRefreshFailures() + 1;
        options.onRefreshFailuresChange(nextFailures);
        if (nextFailures >= 3) {
          options.onRefreshDisabledChange(true);
        }
      })
      .finally(() => {
        if (!options.getRefreshDisabled()) {
          options.onReschedule();
        }
      });
  }, delayMs);
  timer.unref?.();
  return timer;
}

export function reconcileProtectedStates(options: {
  coreQuotaManager: CoreQuotaManagerLike | null;
  protectedReason: string;
  registeredProviderKeys: Set<string>;
  adminSnapshot: Record<string, unknown>;
  isModelProtected: (alias: string, modelId: string) => boolean;
  getSnapshotRecord: (alias: string, modelId: string) => QuotaRecordLike | null;
  applyQuotaRecord: (providerKey: string, record: QuotaRecordLike) => void;
}): void {
  const mgr = options.coreQuotaManager;
  if (!mgr || typeof mgr.updateProviderPoolState !== 'function') {
    return;
  }
  const keys = new Set<string>(options.registeredProviderKeys);
  for (const providerKey of Object.keys(options.adminSnapshot)) {
    keys.add(providerKey);
  }

  for (const providerKey of keys) {
    const parsed = parseAntigravityProviderKey(providerKey);
    if (!parsed) {
      continue;
    }
    if (options.isModelProtected(parsed.alias, parsed.modelId)) {
      mgr.updateProviderPoolState({
        providerKey,
        inPool: false,
        reason: options.protectedReason,
        cooldownUntil: null,
        blacklistUntil: null
      });
      continue;
    }

    let currentReason = '';
    try {
      const viewFn = typeof mgr.getQuotaView === 'function' ? mgr.getQuotaView() : null;
      const current = typeof viewFn === 'function' ? (viewFn(providerKey) as { reason?: unknown } | null) : null;
      currentReason = typeof current?.reason === 'string' ? current.reason.trim().toLowerCase() : '';
    } catch {
      currentReason = '';
    }
    if (currentReason !== options.protectedReason) {
      continue;
    }

    const snapshotRecord = options.getSnapshotRecord(parsed.alias, parsed.modelId);
    if (snapshotRecord) {
      options.applyQuotaRecord(providerKey, snapshotRecord);
      continue;
    }
    mgr.updateProviderPoolState({
      providerKey,
      inPool: false,
      reason: 'quotaDepleted',
      cooldownUntil: null,
      blacklistUntil: null
    });
  }
}

export function getSnapshotRecordByAliasAndModel(
  snapshot: Record<string, QuotaRecordLike>,
  alias: string,
  modelId: string
): QuotaRecordLike | null {
  const key = buildAntigravitySnapshotKey(alias, modelId);
  return snapshot[key] ?? null;
}
