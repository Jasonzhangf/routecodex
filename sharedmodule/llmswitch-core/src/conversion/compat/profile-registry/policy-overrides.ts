/**
 * Policy Overrides — pure functions for config-driven policy skip/apply.
 *
 * Replaces the hardcoded profile string checks in policy-engine.ts
 * (chat:deepseek-web skip). These functions are pure:
 * data in, data out, no global state.
 */

import type { PolicyOverrideConfig } from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether the policy phase should be skipped for a given profile.
 *
 * @param overrides - Policy override config from the compat profile
 * @param phase - The policy phase to check ('observe' | 'enforce')
 * @returns true if the phase should be skipped for this profile
 */
export function shouldSkipPolicy(
  overrides: PolicyOverrideConfig | undefined,
  phase: 'observe' | 'enforce'
): boolean {
  if (!overrides) {
    return false;
  }
  const phaseOverride = overrides[phase];
  if (!phaseOverride) {
    return false;
  }
  return phaseOverride.skip === true;
}
