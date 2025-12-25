import { buildInfo } from '../build-info.js';

type FlagName = 'snapshotsEnabled' | 'verboseErrors';

function resolveBoolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

const defaultSnapshot = buildInfo.mode !== 'release';
const defaultVerbose = buildInfo.mode !== 'release';

const snapshotsEnabled = resolveBoolFromEnv(
  process.env.ROUTECODEX_SNAPSHOT ?? process.env.ROUTECODEX_SNAPSHOTS,
  defaultSnapshot
);

const verboseErrors = resolveBoolFromEnv(
  process.env.ROUTECODEX_VERBOSE_ERRORS,
  defaultVerbose
);

if (!snapshotsEnabled) {
  const hubFlag = process.env.ROUTECODEX_HUB_SNAPSHOTS;
  if (!hubFlag || !hubFlag.trim().length) {
    process.env.ROUTECODEX_HUB_SNAPSHOTS = '0';
  }
}

export const runtimeFlags: Record<FlagName, boolean> = {
  snapshotsEnabled,
  verboseErrors
};

export function setRuntimeFlag(name: FlagName, value: boolean): void {
  runtimeFlags[name] = value;
}
