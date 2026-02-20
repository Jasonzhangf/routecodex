export type ClockDaemonInjectSkipLogInput = {
  sessionId?: string;
  injectReason?: string;
  bindReason?: string;
};

export type ClockDaemonCleanupAuditLogInput = {
  managedTerminationEnabled: boolean;
  staleRemovedDaemonIds?: string[];
  staleRemovedTmuxSessionIds?: string[];
  deadRemovedDaemonIds?: string[];
  deadRemovedTmuxSessionIds?: string[];
  failedKillTmuxSessionIds?: string[];
  failedKillManagedClientPids?: number[];
};

const DEFAULT_SKIP_LOG_COOLDOWN_MS = 30_000;
const BENIGN_SKIP_LOG_COOLDOWN_MS = 10 * 60_000;
const CLEANUP_AUDIT_LOG_COOLDOWN_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 2048;

function normalizeToken(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().toLowerCase();
}

function resolveCooldownMs(input: ClockDaemonInjectSkipLogInput): number {
  if (shouldClearClockTasksForInjectSkip(input)) {
    return BENIGN_SKIP_LOG_COOLDOWN_MS;
  }
  return DEFAULT_SKIP_LOG_COOLDOWN_MS;
}

function buildCacheKey(input: ClockDaemonInjectSkipLogInput): string {
  const sessionId = normalizeToken(input.sessionId) || 'unknown_session';
  const injectReason = normalizeToken(input.injectReason) || 'unknown_inject_reason';
  const bindReason = normalizeToken(input.bindReason) || 'unknown_bind_reason';
  return `${sessionId}|${injectReason}|${bindReason}`;
}

function normalizeIdList(values: unknown[] | undefined): string {
  if (!Array.isArray(values) || values.length < 1) {
    return '';
  }
  const normalized = values
    .map((value) => normalizeToken(value))
    .filter(Boolean)
    .sort();
  if (normalized.length < 1) {
    return '';
  }
  return normalized.join(',');
}

function buildCleanupAuditCacheKey(input: ClockDaemonCleanupAuditLogInput): string {
  const managedTerminationEnabled = input.managedTerminationEnabled ? '1' : '0';
  const staleRemovedDaemonIds = normalizeIdList(input.staleRemovedDaemonIds);
  const staleRemovedTmuxSessionIds = normalizeIdList(input.staleRemovedTmuxSessionIds);
  const deadRemovedDaemonIds = normalizeIdList(input.deadRemovedDaemonIds);
  const deadRemovedTmuxSessionIds = normalizeIdList(input.deadRemovedTmuxSessionIds);
  const failedKillTmuxSessionIds = normalizeIdList(input.failedKillTmuxSessionIds);
  const failedKillManagedClientPids = normalizeIdList(input.failedKillManagedClientPids);
  return [
    `managed:${managedTerminationEnabled}`,
    `stale_daemon:${staleRemovedDaemonIds}`,
    `stale_tmux:${staleRemovedTmuxSessionIds}`,
    `dead_daemon:${deadRemovedDaemonIds}`,
    `dead_tmux:${deadRemovedTmuxSessionIds}`,
    `failed_tmux:${failedKillTmuxSessionIds}`,
    `failed_pid:${failedKillManagedClientPids}`
  ].join('|');
}

function trimCache(cache: Map<string, number>, maxEntries: number): void {
  if (cache.size <= maxEntries) {
    return;
  }
  const overflow = cache.size - maxEntries;
  let removed = 0;
  for (const key of cache.keys()) {
    cache.delete(key);
    removed += 1;
    if (removed >= overflow) {
      break;
    }
  }
}

export function shouldLogClockDaemonInjectSkip(args: {
  cache: Map<string, number>;
  input: ClockDaemonInjectSkipLogInput;
  nowMs?: number;
  maxEntries?: number;
}): boolean {
  const nowMs = typeof args.nowMs === 'number' && Number.isFinite(args.nowMs) ? args.nowMs : Date.now();
  const maxEntries =
    typeof args.maxEntries === 'number' && Number.isFinite(args.maxEntries) && args.maxEntries > 0
      ? Math.floor(args.maxEntries)
      : MAX_CACHE_ENTRIES;
  const key = buildCacheKey(args.input);
  const cooldownMs = resolveCooldownMs(args.input);
  const lastMs = args.cache.get(key);
  if (typeof lastMs === 'number' && Number.isFinite(lastMs) && nowMs - lastMs < cooldownMs) {
    return false;
  }
  args.cache.set(key, nowMs);
  trimCache(args.cache, maxEntries);
  return true;
}

export function shouldLogClockDaemonCleanupAudit(args: {
  cache: Map<string, number>;
  input: ClockDaemonCleanupAuditLogInput;
  nowMs?: number;
  maxEntries?: number;
  cooldownMs?: number;
}): boolean {
  const nowMs = typeof args.nowMs === 'number' && Number.isFinite(args.nowMs) ? args.nowMs : Date.now();
  const maxEntries =
    typeof args.maxEntries === 'number' && Number.isFinite(args.maxEntries) && args.maxEntries > 0
      ? Math.floor(args.maxEntries)
      : MAX_CACHE_ENTRIES;
  const cooldownMs =
    typeof args.cooldownMs === 'number' && Number.isFinite(args.cooldownMs) && args.cooldownMs >= 0
      ? Math.floor(args.cooldownMs)
      : CLEANUP_AUDIT_LOG_COOLDOWN_MS;
  const key = buildCleanupAuditCacheKey(args.input);
  const lastMs = args.cache.get(key);
  if (typeof lastMs === 'number' && Number.isFinite(lastMs) && nowMs - lastMs < cooldownMs) {
    return false;
  }
  args.cache.set(key, nowMs);
  trimCache(args.cache, maxEntries);
  return true;
}

export function shouldClearClockTasksForInjectSkip(input: ClockDaemonInjectSkipLogInput): boolean {
  const injectReason = normalizeToken(input.injectReason);
  const bindReason = normalizeToken(input.bindReason);
  return injectReason === 'no_matching_tmux_session_daemon' && bindReason === 'no_binding_candidate';
}
