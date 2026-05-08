const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);
const DEFAULT_INPUT_TOKEN_THRESHOLD = 120_000;

function readBooleanEnv(names: string[], fallback: boolean): boolean {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined) continue;
    const normalized = String(raw).trim().toLowerCase();
    if (TRUTHY.has(normalized)) return true;
    if (FALSY.has(normalized)) return false;
  }
  return fallback;
}

function readPositiveIntEnv(names: string[], fallback: number): number {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined) continue;
    const parsed = Number.parseInt(String(raw).trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function getConfig() {
  return {
    enabled: readBooleanEnv(
      ["ROUTECODEX_HUB_FASTPATH_HEAVY_INPUT", "RCC_HUB_FASTPATH_HEAVY_INPUT"],
      true,
    ),
    inputTokenThreshold: readPositiveIntEnv(
      [
        "ROUTECODEX_HUB_FASTPATH_INPUT_TOKEN_THRESHOLD",
        "RCC_HUB_FASTPATH_INPUT_TOKEN_THRESHOLD",
      ],
      DEFAULT_INPUT_TOKEN_THRESHOLD,
    ),
  };
}

export function isHeavyInputFastpathEnabled(): boolean {
  return getConfig().enabled;
}

export function resolveHeavyInputTokenThreshold(): number {
  return getConfig().inputTokenThreshold;
}
