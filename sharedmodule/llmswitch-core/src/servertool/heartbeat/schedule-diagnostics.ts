import { resolveHeartbeatScanMs } from "./config.js";
import type {
  HeartbeatConfigSnapshot,
  HeartbeatCronShadowDiagnostic,
  HeartbeatScheduleDiagnostic,
  HeartbeatSchedulePhase,
  HeartbeatState,
} from "./types.js";

function normalizeFiniteInt(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.floor(parsed);
}

function resolveEffectiveIntervalMs(
  state: HeartbeatState,
  config: HeartbeatConfigSnapshot,
): number {
  const override = normalizeFiniteInt(state.intervalMs);
  if (typeof override === "number" && override > 0) {
    return override;
  }
  const tickMs = normalizeFiniteInt(config.tickMs);
  return typeof tickMs === "number" && tickMs > 0 ? tickMs : 0;
}

function buildUnsupportedCronShadow(
  reason: string,
): HeartbeatCronShadowDiagnostic {
  return {
    supported: false,
    reason,
  };
}

function buildMinuteStepCronShadow(
  atMs: number,
  stepMinutes: number,
): HeartbeatCronShadowDiagnostic {
  const previous = new Date(atMs);
  previous.setSeconds(0, 0);
  previous.setMinutes(previous.getMinutes() - (previous.getMinutes() % stepMinutes));
  const previousBoundaryAtMs = previous.getTime();
  return {
    supported: true,
    expression: stepMinutes === 1 ? "* * * * *" : `*/${stepMinutes} * * * *`,
    timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
    previousBoundaryAtMs,
    nextBoundaryAtMs: previousBoundaryAtMs + stepMinutes * 60_000,
    offsetFromPreviousBoundaryMs: Math.max(0, atMs - previousBoundaryAtMs),
  };
}

function buildHourStepCronShadow(
  atMs: number,
  stepHours: number,
): HeartbeatCronShadowDiagnostic {
  const previous = new Date(atMs);
  previous.setMinutes(0, 0, 0);
  previous.setHours(previous.getHours() - (previous.getHours() % stepHours));
  const previousBoundaryAtMs = previous.getTime();
  return {
    supported: true,
    expression: stepHours === 24 ? "0 0 * * *" : `0 */${stepHours} * * *`,
    timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone || "local",
    previousBoundaryAtMs,
    nextBoundaryAtMs: previousBoundaryAtMs + stepHours * 60 * 60_000,
    offsetFromPreviousBoundaryMs: Math.max(0, atMs - previousBoundaryAtMs),
  };
}

export function buildHeartbeatCronShadowDiagnostic(args: {
  intervalMs: number;
  atMs: number;
}): HeartbeatCronShadowDiagnostic {
  const intervalMs = normalizeFiniteInt(args.intervalMs);
  const atMs = normalizeFiniteInt(args.atMs);
  if (typeof intervalMs !== "number" || intervalMs < 1) {
    return buildUnsupportedCronShadow("interval_missing");
  }
  if (typeof atMs !== "number") {
    return buildUnsupportedCronShadow("timestamp_missing");
  }
  if (intervalMs < 60_000) {
    return buildUnsupportedCronShadow("interval_lt_one_minute");
  }
  if (intervalMs % 60_000 !== 0) {
    return buildUnsupportedCronShadow("interval_not_full_minutes");
  }

  const intervalMinutes = intervalMs / 60_000;
  if (intervalMinutes <= 60 && 60 % intervalMinutes === 0) {
    return buildMinuteStepCronShadow(atMs, intervalMinutes);
  }
  if (intervalMinutes % 60 === 0) {
    const intervalHours = intervalMinutes / 60;
    if (intervalHours <= 24 && 24 % intervalHours === 0) {
      return buildHourStepCronShadow(atMs, intervalHours);
    }
  }
  return buildUnsupportedCronShadow("interval_not_cron_divisor");
}

export function buildHeartbeatScheduleDiagnostic(args: {
  state: HeartbeatState;
  config: HeartbeatConfigSnapshot;
  atMs: number;
  phase: HeartbeatSchedulePhase;
  reason?: string;
}): HeartbeatScheduleDiagnostic {
  const atMs = normalizeFiniteInt(args.atMs) ?? Date.now();
  const effectiveIntervalMs = resolveEffectiveIntervalMs(args.state, args.config);
  const lastTriggeredAtMs = normalizeFiniteInt(args.state.lastTriggeredAtMs);
  const updatedAtMs = normalizeFiniteInt(args.state.updatedAtMs);
  const anchorAtMs =
    typeof lastTriggeredAtMs === "number" ? lastTriggeredAtMs : updatedAtMs;
  const dueAtMs =
    typeof lastTriggeredAtMs === "number"
      ? lastTriggeredAtMs + effectiveIntervalMs
      : anchorAtMs;
  const dueInMs =
    typeof dueAtMs === "number" ? dueAtMs - atMs : undefined;
  const latenessMs =
    typeof dueAtMs === "number" && atMs >= dueAtMs ? atMs - dueAtMs : undefined;

  return {
    phase: args.phase,
    observedAtMs: atMs,
    daemonScanMs: resolveHeartbeatScanMs(args.config),
    effectiveIntervalMs,
    ...(typeof anchorAtMs === "number" ? { anchorAtMs } : {}),
    ...(typeof dueAtMs === "number" ? { dueAtMs } : {}),
    ...(typeof dueInMs === "number" ? { dueInMs } : {}),
    ...(typeof latenessMs === "number" ? { latenessMs } : {}),
    ...(typeof args.reason === "string" && args.reason.trim()
      ? { reason: args.reason.trim() }
      : {}),
    cronShadow: buildHeartbeatCronShadowDiagnostic({
      intervalMs: effectiveIntervalMs,
      atMs,
    }),
  };
}
