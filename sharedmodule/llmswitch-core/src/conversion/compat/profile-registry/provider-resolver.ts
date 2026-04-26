/**
 * Provider Resolver — config-driven replacements for hardcoded if-chains
 * in provider-normalization.ts:
 * - detectProviderType → detectProviderTypeFromConfig
 * - mapOutboundProfile → resolveOutboundProfileFromConfig
 * - resolveCompatibilityProfile (default part) → resolveDefaultCompatibilityProfileFromConfig
 *
 * Pure functions: data in, data out, no global state.
 */

import type { ProviderResolutionConfig } from './types.js';

/**
 * Detect provider type from provider config using keyword rules.
 * Replaces hardcoded keyword if-chain in detectProviderType.
 */
export function detectProviderTypeFromConfig(
  config: ProviderResolutionConfig,
  provider: Record<string, unknown>
): string {
  const raw = (provider.providerType || provider.protocol || provider.type || '').toString().toLowerCase();
  const id = (provider.providerId || provider.id || '').toString().toLowerCase();
  const source = `${raw}|${id}`;
  const lexicon = source.trim();
  if (!lexicon) return config.defaultProviderType;

  for (const rule of config.typeKeywords) {
    for (const keyword of rule.keywords) {
      if (lexicon.includes(keyword.toLowerCase())) {
        return rule.providerType;
      }
    }
  }

  return raw || config.defaultProviderType;
}

/**
 * Resolve outbound wire protocol from provider type using config mapping.
 * Replaces hardcoded if-chain in mapOutboundProfile.
 */
export function resolveOutboundProfileFromConfig(
  config: ProviderResolutionConfig,
  providerType: string
): string {
  const value = providerType.toLowerCase();
  return config.outboundProfiles[value] ?? config.defaultOutboundProfile;
}

/**
 * Resolve default compatibility profile from provider ID and config.
 * Replaces hardcoded antigravity/gemini-cli if-chain in resolveCompatibilityProfile.
 * Only handles the DEFAULT resolution — explicit compatibilityProfile from provider config takes precedence.
 */
export function resolveDefaultCompatibilityProfileFromConfig(
  config: ProviderResolutionConfig,
  providerId: string,
  provider: Record<string, unknown>
): string {
  const normalizedId = providerId.trim().toLowerCase();
  const providerType = String(provider.providerType ?? provider.type ?? provider.protocol ?? '').toLowerCase();

  for (const block of config.compatibilityProfileBlocks) {
    if (block.providerId !== undefined) {
      if (normalizedId === block.providerId.toLowerCase()) {
        return block.compatibilityProfile;
      }
    }
    if (block.providerTypeContains !== undefined) {
      if (providerType.includes(block.providerTypeContains.toLowerCase())) {
        return block.compatibilityProfile;
      }
    }
  }

  return config.defaultCompatibilityProfile;
}
