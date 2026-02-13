/**
 * RouteCodex-X7E Feature Gate
 *
 * Provides runtime toggles for the x7e refactoring phases to enable safe rollout and rollback.
 * All gates default to ENABLED (true) for new code paths, with ability to disable via environment.
 */

// Phase 0: API Compatibility Gate (default: true = new paths)
const X7E_PHASE_0_ENABLED = resolveGate('ROUTECODEX_X7E_PHASE_0_ENABLED', true);

// Phase 1: QuotaManager SSOT Gate (default: true = unified quota)
const X7E_PHASE_1_UNIFIED_QUOTA_ENABLED = resolveGate('ROUTECODEX_X7E_PHASE_1_UNIFIED_QUOTA', true);

// Phase 2: Snapshot/Mutate Control Plane Gate (default: true = unified DTO)
const X7E_PHASE_2_UNIFIED_CONTROL_ENABLED = resolveGate('ROUTECODEX_X7E_PHASE_2_UNIFIED_CONTROL', true);

// Phase 3: Executor Boundary Gate (default: false = legacy executor path)
const X7E_PHASE_3_EXECUTOR_SEPARATION_ENABLED = resolveGate('ROUTECODEX_X7E_PHASE_3_EXECUTOR_SEPARATION', false);

// Phase 4: Unified Hit Logging Gate (default: false = legacy logging)
const X7E_PHASE_4_UNIFIED_LOGGING_ENABLED = resolveGate('ROUTECODEX_X7E_PHASE_4_UNIFIED_LOGGING', false);

function resolveGate(envVar: string, defaultValue: boolean): boolean {
  const raw = process.env[envVar];
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

/**
 * Gate export for use in handlers/bridge layer.
 * All phases use consistent interface for runtime toggling.
 */
export const x7eGate = {
  // Phase 0: x7e execution boundary (always true once we start migration)
  phase0Enabled: X7E_PHASE_0_ENABLED,

  // Phase 1: QuotaManager SSOT (legacy quota daemon vs core manager)
  phase1UnifiedQuota: X7E_PHASE_1_UNIFIED_QUOTA_ENABLED,

  // Phase 2: Unified control plane DTOs
  phase2UnifiedControl: X7E_PHASE_2_UNIFIED_CONTROL_ENABLED,

  // Phase 3: Executor boundary separation
  phase3ExecutorSeparation: X7E_PHASE_3_EXECUTOR_SEPARATION_ENABLED,

  // Phase 4: Unified hit event logging
  phase4UnifiedLogging: X7E_PHASE_4_UNIFIED_LOGGING_ENABLED,

  // Helper: check if ANY phase is disabled (for fallback paths)
  isLegacyMode: () => {
    return !X7E_PHASE_0_ENABLED ||
           !X7E_PHASE_1_UNIFIED_QUOTA_ENABLED ||
           !X7E_PHASE_2_UNIFIED_CONTROL_ENABLED;
  }
} as const;

/**
 * Gate state metadata for observability/debugging.
 */
export function getGateState(): Record<string, boolean | string> {
  return {
    phase0_enabled: X7E_PHASE_0_ENABLED,
    phase1_unifiedQuota: X7E_PHASE_1_UNIFIED_QUOTA_ENABLED,
    phase2_unifiedControl: X7E_PHASE_2_UNIFIED_CONTROL_ENABLED,
    phase3_executorSeparation: X7E_PHASE_3_EXECUTOR_SEPARATION_ENABLED,
    phase4_unifiedLogging: X7E_PHASE_4_UNIFIED_LOGGING_ENABLED,
    env_RAW_PHASE_0: process.env.ROUTECODEX_X7E_PHASE_0_ENABLED ?? '(default)',
    env_RAW_PHASE_1: process.env.ROUTECODEX_X7E_PHASE_1_UNIFIED_QUOTA ?? '(default)',
    env_RAW_PHASE_2: process.env.ROUTECODEX_X7E_PHASE_2_UNIFIED_CONTROL ?? '(default)',
    env_RAW_PHASE_3: process.env.ROUTECODEX_X7E_PHASE_3_EXECUTOR_SEPARATION ?? '(default)',
    env_RAW_PHASE_4: process.env.ROUTECODEX_X7E_PHASE_4_UNIFIED_LOGGING ?? '(default)'
  };
}
