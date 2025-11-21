/**
 * Debug/Snapshot feature flags
 *
 * 约定（兼容旧变量）：
 * - ROUTECODEX_DEBUGCENTER_ENABLED / ROUTECODEX_ENABLE_DEBUGCENTER
 * - ROUTECODEX_SNAPSHOT_ENABLED / ROUTECODEX_SNAPSHOTS
 */

function parseBool(v: unknown, defaultValue: boolean): boolean {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return defaultValue;
}

export function isDebugCenterEnabled(): boolean {
  // 优先新变量，其次兼容旧变量；默认关闭
  if (process.env.ROUTECODEX_DEBUGCENTER_ENABLED != null) {
    return parseBool(process.env.ROUTECODEX_DEBUGCENTER_ENABLED, false);
  }
  if (process.env.ROUTECODEX_ENABLE_DEBUGCENTER != null) {
    return parseBool(process.env.ROUTECODEX_ENABLE_DEBUGCENTER, false);
  }
  return false;
}

export function isSnapshotsEnabledDefaultOn(): boolean {
  // 默认开启；支持两个变量名
  if (process.env.ROUTECODEX_SNAPSHOT_ENABLED != null) {
    return parseBool(process.env.ROUTECODEX_SNAPSHOT_ENABLED, true);
  }
  if (process.env.ROUTECODEX_SNAPSHOTS != null) {
    return parseBool(process.env.ROUTECODEX_SNAPSHOTS, true);
  }
  return true;
}

