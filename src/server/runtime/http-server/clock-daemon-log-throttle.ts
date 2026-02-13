export type ClockDaemonInjectSkipLogInput = {
  sessionId?: string;
  injectReason?: string;
  bindReason?: string;
};

const DEFAULT_SKIP_LOG_COOLDOWN_MS = 30_000;
const BENIGN_SKIP_LOG_COOLDOWN_MS = 10 * 60_000;
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

export function shouldClearClockTasksForInjectSkip(input: ClockDaemonInjectSkipLogInput): boolean {
  const injectReason = normalizeToken(input.injectReason);
  const bindReason = normalizeToken(input.bindReason);
  return injectReason === 'no_matching_tmux_session_daemon' && bindReason === 'no_binding_candidate';
}
