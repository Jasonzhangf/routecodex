import { getProviderModelId, extractProviderId } from './key-parsing.js';
import type { SelectionDeps } from './selection-deps.js';
import {
  lookupAntigravityPinnedAliasForSessionIdWithNative,
  unpinAntigravitySessionAliasForSessionIdWithNative
} from './native-router-hotpath.js';
import {
  lookupAntigravityPinnedAliasForSessionId,
  unpinAntigravitySessionAliasForSessionId
} from '../../../conversion/compat/antigravity-session-signature.js';

const DEFAULT_ANTIGRAVITY_ALIAS_SESSION_COOLDOWN_MS = 5 * 60_000;

export function isAntigravityGeminiModelKey(providerKey: string, deps: SelectionDeps): boolean {
  if ((extractProviderId(providerKey) ?? '') !== 'antigravity') {
    return false;
  }
  const modelId = getProviderModelId(providerKey, deps.providerRegistry) ?? '';
  return modelId.trim().toLowerCase().startsWith('gemini-');
}

function extractAntigravityRuntimeBase(providerKey: string): string | null {
  const value = typeof providerKey === 'string' ? providerKey.trim() : '';
  if (!value) return null;
  const firstDot = value.indexOf('.');
  if (firstDot <= 0 || firstDot === value.length - 1) return null;
  const secondDot = value.indexOf('.', firstDot + 1);
  if (secondDot <= firstDot + 1) return null;
  const providerId = value.slice(0, firstDot);
  const alias = value.slice(firstDot + 1, secondDot);
  if (!providerId || !alias) return null;
  return `${providerId}.${alias}`;
}

function buildAntigravityLeaseRuntimeKey(runtimeBase: string): string {
  return `${runtimeBase}::gemini`;
}

function isAntigravityGeminiSessionBindingDisabled(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') {
    return false;
  }
  const rtRaw = (metadata as Record<string, unknown>).__rt;
  if (!rtRaw || typeof rtRaw !== 'object' || Array.isArray(rtRaw)) {
    return false;
  }
  const rt = rtRaw as Record<string, unknown>;
  if (rt.disableAntigravitySessionBinding === true) {
    return true;
  }
  const mode = rt.antigravitySessionBinding;
  if (mode === false) {
    return true;
  }
  if (typeof mode === 'string' && ['0', 'false', 'off', 'disabled', 'none'].includes(mode.trim().toLowerCase())) {
    return true;
  }
  return false;
}

function resolveSessionScopeKey(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }
  const record = metadata as Record<string, unknown>;
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
  if (sessionId) {
    return `session:${sessionId}`;
  }
  const conversationId = typeof record.conversationId === 'string' ? record.conversationId.trim() : '';
  if (conversationId) {
    return `conversation:${conversationId}`;
  }
  const antigravitySessionId =
    typeof (record as any).antigravitySessionId === 'string'
      ? String((record as any).antigravitySessionId).trim()
      : '';
  if (antigravitySessionId) {
    return `session:${antigravitySessionId}`;
  }
  return null;
}

function buildScopedSessionKey(sessionKey: string): string {
  return `${sessionKey}::gemini`;
}

export function extractLeaseRuntimeKey(providerKey: string, deps: SelectionDeps): string | null {
  const base = extractAntigravityRuntimeBase(providerKey);
  if (!base) return null;
  if ((extractProviderId(providerKey) ?? '') !== 'antigravity') return base;
  if (!isAntigravityGeminiModelKey(providerKey, deps)) {
    return null;
  }
  return buildAntigravityLeaseRuntimeKey(base);
}

export function applyAntigravityAliasSessionLeases(targets: string[], deps: SelectionDeps, metadata: unknown): {
  targets: string[];
  blocked: number;
  preferredPinned: boolean;
  pinnedStrict: boolean;
  preferredRuntimeKey?: string;
} {
  if (!Array.isArray(targets) || targets.length === 0) {
    return { targets, blocked: 0, preferredPinned: false, pinnedStrict: false };
  }
  if (isAntigravityGeminiSessionBindingDisabled(metadata)) {
    return { targets, blocked: 0, preferredPinned: false, pinnedStrict: false };
  }
  const leaseStore = deps.antigravityAliasLeaseStore;
  const sessionAliasStore = deps.antigravitySessionAliasStore;
  if (!leaseStore || !sessionAliasStore) {
    return { targets, blocked: 0, preferredPinned: false, pinnedStrict: false };
  }
  const sessionKey = resolveSessionScopeKey(metadata);
  if (!sessionKey) {
    return { targets, blocked: 0, preferredPinned: false, pinnedStrict: false };
  }
  const cooldownMs =
    typeof deps.antigravityAliasReuseCooldownMs === 'number' && Number.isFinite(deps.antigravityAliasReuseCooldownMs)
      ? Math.max(0, Math.floor(deps.antigravityAliasReuseCooldownMs))
      : DEFAULT_ANTIGRAVITY_ALIAS_SESSION_COOLDOWN_MS;
  const now = Date.now();
  const bindingModeRaw =
    (deps.loadBalancer.getPolicy().aliasSelection as unknown as { antigravitySessionBinding?: unknown } | undefined)
      ?.antigravitySessionBinding;
  const strictRequested =
    typeof bindingModeRaw === 'string' && bindingModeRaw.trim().toLowerCase() === 'strict';

  const agSessionId =
    metadata && typeof metadata === 'object' && typeof (metadata as any).antigravitySessionId === 'string'
      ? String((metadata as any).antigravitySessionId).trim()
      : '';
  const hasAntigravityGeminiTargets = targets.some((key) => isAntigravityGeminiModelKey(key, deps));
  const lookupPinnedRuntimeKey = (): string | undefined => {
    if (!(strictRequested && agSessionId && hasAntigravityGeminiTargets)) {
      return undefined;
    }
    const nativePinned = lookupAntigravityPinnedAliasForSessionIdWithNative(agSessionId, { hydrate: true });
    if (nativePinned && nativePinned.trim()) {
      return nativePinned.trim();
    }
    const persistedPinned = lookupAntigravityPinnedAliasForSessionId(agSessionId, { hydrate: true });
    if (!persistedPinned || !persistedPinned.trim()) {
      return undefined;
    }
    return persistedPinned.trim();
  };
  let pinnedRuntimeKey =
    lookupPinnedRuntimeKey();
  const pinnedLeaseKey = pinnedRuntimeKey ? buildAntigravityLeaseRuntimeKey(pinnedRuntimeKey) : undefined;

  if (pinnedRuntimeKey && deps.quotaView && agSessionId) {
    const pinnedKeys = targets.filter(
      (key) => isAntigravityGeminiModelKey(key, deps) && extractLeaseRuntimeKey(key, deps) === pinnedLeaseKey
    );
    if (pinnedKeys.length > 0) {
      const allOutOfPool = pinnedKeys.every((key) => deps.quotaView?.(key)?.inPool === false);
      if (allOutOfPool) {
        const releasedRuntimeKey = pinnedRuntimeKey;
        unpinAntigravitySessionAliasForSessionIdWithNative(agSessionId);
        unpinAntigravitySessionAliasForSessionId(agSessionId);
        pinnedRuntimeKey = undefined;
        sessionAliasStore.delete(buildScopedSessionKey(sessionKey));
        try {
          const raw = String(process.env.ROUTECODEX_STAGE_LOG || process.env.RCC_STAGE_LOG || '').trim().toLowerCase();
          const enabled = raw !== '' && raw !== '0' && raw !== 'false' && raw !== 'no';
          if (enabled) {
            console.log(
              '[virtual-router][antigravity-session-binding] unpin',
              JSON.stringify({ agSessionId, runtimeKey: releasedRuntimeKey })
            );
          }
        } catch {
          // ignore
        }
      }
    }
  }

  const strictBinding = strictRequested && Boolean(pinnedLeaseKey);
  const geminiSessionKey = buildScopedSessionKey(sessionKey);

  let preferredGeminiRuntimeKey = pinnedLeaseKey || sessionAliasStore.get(geminiSessionKey);
  if (preferredGeminiRuntimeKey && !preferredGeminiRuntimeKey.includes('::')) {
    preferredGeminiRuntimeKey = buildAntigravityLeaseRuntimeKey(preferredGeminiRuntimeKey);
  }
  if (preferredGeminiRuntimeKey && !pinnedLeaseKey) {
    const lease = leaseStore.get(preferredGeminiRuntimeKey);
    if (lease && lease.sessionKey !== geminiSessionKey && now - lease.lastSeenAt < cooldownMs) {
      preferredGeminiRuntimeKey = undefined;
    }
  }

  if (deps.quotaView && !pinnedLeaseKey && preferredGeminiRuntimeKey) {
    const pinnedKeys = targets.filter(
      (key) => isAntigravityGeminiModelKey(key, deps) && extractLeaseRuntimeKey(key, deps) === preferredGeminiRuntimeKey
    );
    if (pinnedKeys.length > 0) {
      const allOutOfPool = pinnedKeys.every((key) => deps.quotaView?.(key)?.inPool === false);
      if (allOutOfPool) {
        const releasedRuntimeKey = preferredGeminiRuntimeKey;
        sessionAliasStore.delete(geminiSessionKey);
        preferredGeminiRuntimeKey = undefined;
        try {
          const raw = String(process.env.ROUTECODEX_STAGE_LOG || process.env.RCC_STAGE_LOG || '').trim().toLowerCase();
          const enabled = raw !== '' && raw !== '0' && raw !== 'false' && raw !== 'no';
          if (enabled) {
            console.log(
              '[virtual-router][antigravity-session-binding] release',
              JSON.stringify({ sessionKey: geminiSessionKey, runtimeKey: releasedRuntimeKey })
            );
          }
        } catch {
          // ignore
        }
      }
    }
  }

  const pinnedGemini = preferredGeminiRuntimeKey
    ? targets.filter(
        (key) => isAntigravityGeminiModelKey(key, deps) && extractLeaseRuntimeKey(key, deps) === preferredGeminiRuntimeKey
      )
    : [];

  const preferredPinned = pinnedGemini.length > 0;
  const pinnedSet = preferredPinned ? new Set([...pinnedGemini]) : null;
  const candidates = preferredPinned
    ? [...pinnedGemini, ...targets.filter((key) => !(pinnedSet as Set<string>).has(key))]
    : targets;
  const pinnedStrict = strictBinding && Boolean(preferredGeminiRuntimeKey);

  let blocked = 0;
  const filtered = candidates.filter((key) => {
    const providerId = extractProviderId(key);
    if (providerId !== 'antigravity') {
      return true;
    }
    if (!isAntigravityGeminiModelKey(key, deps)) {
      return true;
    }
    const scopedSessionKey = geminiSessionKey;
    const runtimeKey = extractLeaseRuntimeKey(key, deps);
    if (!runtimeKey) {
      return true;
    }
    if (pinnedStrict) {
      if (!isAntigravityGeminiModelKey(key, deps)) {
        return true;
      }
      if (preferredGeminiRuntimeKey && runtimeKey !== preferredGeminiRuntimeKey) {
        return false;
      }
    }
    const lease = leaseStore.get(runtimeKey);
    if (!lease) {
      return true;
    }
    if (lease.sessionKey === scopedSessionKey) {
      return true;
    }
    if (now - lease.lastSeenAt >= cooldownMs) {
      return true;
    }
    blocked += 1;
    return false;
  });

  return { targets: filtered, blocked, preferredPinned, pinnedStrict, preferredRuntimeKey: preferredGeminiRuntimeKey };
}
