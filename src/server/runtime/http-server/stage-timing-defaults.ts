import { buildInfo } from '../../../build-info.js';

export function resolveRuntimeBuildMode(): 'dev' | 'release' {
  const raw = String(process.env.ROUTECODEX_BUILD_MODE ?? process.env.BUILD_MODE ?? '').trim().toLowerCase();
  if (raw === 'release') {
    return 'release';
  }
  if (raw === 'dev' || raw === 'development') {
    return 'dev';
  }
  return buildInfo.mode === 'release' ? 'release' : 'dev';
}

export function applyDefaultStageTimingMode(): void {
  if (!process.env.ROUTECODEX_HUB_STAGE_TIMING_DETAIL) {
    process.env.ROUTECODEX_HUB_STAGE_TIMING_DETAIL = '0';
  }
}
