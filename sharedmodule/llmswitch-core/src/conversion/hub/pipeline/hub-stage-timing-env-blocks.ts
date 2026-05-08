const truthy = new Set(["1", "true", "yes", "on"]);
const falsy = new Set(["0", "false", "no", "off"]);

const DEFAULT_HUB_STAGE_LOG_MIN_MS = 50;
const DEFAULT_HUB_STAGE_TOP_N = 5;
const DEFAULT_HUB_STAGE_TOP_MIN_MS = 5;

function resolveBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (truthy.has(normalized)) {
    return true;
  }
  if (falsy.has(normalized)) {
    return false;
  }
  return fallback;
}

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = Number.parseInt(String(raw ?? "").trim(), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

export function isHubStageTimingEnabled(): boolean {
  const explicit =
    process.env.ROUTECODEX_STAGE_TIMING ??
    process.env.RCC_STAGE_TIMING ??
    process.env.ROUTECODEX_HUB_STAGE_TIMING ??
    process.env.RCC_HUB_STAGE_TIMING;
  return explicit !== undefined ? resolveBool(explicit, false) : false;
}

export function isHubStageTimingVerboseEnabled(): boolean {
  const explicit =
    process.env.ROUTECODEX_STAGE_TIMING_VERBOSE ??
    process.env.RCC_STAGE_TIMING_VERBOSE ??
    process.env.ROUTECODEX_HUB_STAGE_TIMING_VERBOSE ??
    process.env.RCC_HUB_STAGE_TIMING_VERBOSE;
  return explicit !== undefined ? resolveBool(explicit, false) : false;
}

export function isHubStageTimingDetailEnabled(): boolean {
  const explicit =
    process.env.ROUTECODEX_STAGE_TIMING_DETAIL ??
    process.env.RCC_STAGE_TIMING_DETAIL ??
    process.env.ROUTECODEX_HUB_STAGE_TIMING_DETAIL ??
    process.env.RCC_HUB_STAGE_TIMING_DETAIL;
  return explicit !== undefined ? resolveBool(explicit, false) : false;
}

export function resolveHubStageTimingMinMs(): number {
  const raw =
    process.env.ROUTECODEX_STAGE_TIMING_MIN_MS ??
    process.env.RCC_STAGE_TIMING_MIN_MS ??
    process.env.ROUTECODEX_HUB_STAGE_TIMING_MIN_MS ??
    process.env.RCC_HUB_STAGE_TIMING_MIN_MS;
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }
  return DEFAULT_HUB_STAGE_LOG_MIN_MS;
}

export function resolveHubStageTopN(
  override?: number,
): number {
  return Math.max(
    1,
    override ??
      readIntEnv("ROUTECODEX_HUB_STAGE_TOP_N", DEFAULT_HUB_STAGE_TOP_N),
  );
}

export function resolveHubStageTopMinMs(
  override?: number,
): number {
  return Math.max(
    0,
    override ??
      readIntEnv(
        "ROUTECODEX_HUB_STAGE_TOP_MIN_MS",
        DEFAULT_HUB_STAGE_TOP_MIN_MS,
      ),
  );
}
