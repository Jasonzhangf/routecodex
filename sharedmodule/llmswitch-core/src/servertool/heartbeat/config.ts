import type { HeartbeatConfigSnapshot } from "./types.js";

const DEFAULT_HEARTBEAT_TICK_MS = 15 * 60_000;
const MAX_HEARTBEAT_SCAN_MS = 60_000;

function normalizePositiveInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const floored = Math.floor(parsed);
  return floored > 0 ? floored : undefined;
}

export function normalizeHeartbeatConfig(input?: unknown): HeartbeatConfigSnapshot {
  const record =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const tickMs =
    normalizePositiveInt(record.tickMs) ||
    normalizePositiveInt(
      process.env.ROUTECODEX_HEARTBEAT_TICK_MS ||
        process.env.RCC_HEARTBEAT_TICK_MS,
    ) ||
    DEFAULT_HEARTBEAT_TICK_MS;
  return { tickMs };
}

export function resolveHeartbeatConfig(input?: unknown): HeartbeatConfigSnapshot {
  return normalizeHeartbeatConfig(input);
}

export function resolveHeartbeatScanMs(input?: unknown): number {
  const tickMs = normalizeHeartbeatConfig(input).tickMs;
  return Math.max(5_000, Math.min(tickMs, MAX_HEARTBEAT_SCAN_MS));
}
