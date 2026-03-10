import type { ClockConfigSnapshot } from './types.js';
import { resolveClockConfigWithNative } from '../../router/virtual-router/engine-selection/native-chat-process-clock-reminder-semantics.js';

export const CLOCK_CONFIG_DEFAULTS = {
  retentionMs: 20 * 60_000,
  dueWindowMs: 0,
  tickMs: 60_000,
  holdNonStreaming: true,
  holdMaxMs: 60_000
} as const;

function toClockConfigSnapshot(value: Record<string, unknown> | null): ClockConfigSnapshot | null {
  if (!value) {
    return null;
  }
  if (
    value.enabled !== true ||
    typeof value.retentionMs !== 'number' ||
    typeof value.dueWindowMs !== 'number' ||
    typeof value.tickMs !== 'number' ||
    typeof value.holdNonStreaming !== 'boolean' ||
    typeof value.holdMaxMs !== 'number'
  ) {
    return null;
  }
  return {
    enabled: true,
    retentionMs: value.retentionMs,
    dueWindowMs: value.dueWindowMs,
    tickMs: value.tickMs,
    holdNonStreaming: value.holdNonStreaming,
    holdMaxMs: value.holdMaxMs
  };
}

export function normalizeClockConfig(raw: unknown): ClockConfigSnapshot | null {
  const resolved = resolveClockConfigWithNative(raw, false);
  return toClockConfigSnapshot(resolved);
}

/**
 * Resolve the effective clock config for a request/session.
 *
 * - If a config object exists and enabled=true -> return normalized config.
 * - If the config is absent (undefined) -> default-enable using CLOCK_CONFIG_DEFAULTS.
 * - If the config is explicitly present but disabled/invalid -> return null.
 */
export function resolveClockConfig(raw: unknown): ClockConfigSnapshot | null {
  const resolved = resolveClockConfigWithNative(raw, raw === undefined);
  const normalized = toClockConfigSnapshot(resolved);
  if (normalized) {
    return normalized;
  }
  return null;
}
