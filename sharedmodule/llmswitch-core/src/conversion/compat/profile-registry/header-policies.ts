/**
 * Header Policies — pure functions for config-driven header injection.
 *
 * Replaces the hardcoded maybeInjectQwenHeaders / maybeInjectClaudeCodeHeaders
 * functions in provider-normalization.ts. These functions are pure: they take
 * data in, return data out, no global state, no side effects.
 */

import type { HeaderPolicyRule, HeaderPolicyWhen } from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lowered = name.trim().toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.trim().toLowerCase() === lowered) {
      const value = headers[key];
      if (typeof value === 'string' && value.trim()) {
        return true;
      }
    }
  }
  return false;
}

function matchesWhen(
  when: HeaderPolicyWhen,
  ctx: { providerId: string; providerType: string }
): boolean {
  if (when.providerId !== undefined) {
    if (ctx.providerId !== when.providerId.toLowerCase()) {
      return false;
    }
  }
  if (when.providerTypeContains !== undefined) {
    if (!ctx.providerType.includes(when.providerTypeContains.toLowerCase())) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply header policy rules to an existing headers record.
 *
 * @param existingHeaders - Current headers (may be undefined/empty)
 * @param rules - Header policy rules from the compat profile config
 * @param ctx - Provider context for matching
 * @returns New headers record, or the original if no rules matched
 */
export function applyHeaderPolicies(
  existingHeaders: Record<string, string> | undefined,
  rules: HeaderPolicyRule[] | undefined,
  ctx: { providerId: string; providerType: string }
): Record<string, string> | undefined {
  if (!rules || rules.length === 0) {
    return existingHeaders;
  }

  const providerIdLower = ctx.providerId.trim().toLowerCase();
  const providerTypeLower = ctx.providerType.trim().toLowerCase();
  const matchCtx = { providerId: providerIdLower, providerType: providerTypeLower };

  let result: Record<string, string> | undefined = existingHeaders;

  for (const rule of rules) {
    if (!matchesWhen(rule.when, matchCtx)) {
      continue;
    }
    // At least one rule matched — ensure we have a mutable copy
    if (result === existingHeaders) {
      result = { ...(existingHeaders ?? {}) };
    }
    // setIfMissing: only set if header is not already present
    if (rule.setIfMissing) {
      for (const [key, value] of Object.entries(rule.setIfMissing)) {
        if (!hasHeader(result, key)) {
          result[key] = value;
        }
      }
    }
    // set: unconditionally overwrite
    if (rule.set) {
      for (const [key, value] of Object.entries(rule.set)) {
        result[key] = value;
      }
    }
  }

  return result;
}
