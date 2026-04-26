/**
 * Compat Profile Registry — type definitions.
 *
 * Parallel implementation (Step A). These types describe the NEW config-driven
 * header policy and policy override structures. They do NOT affect existing
 * runtime code until Step B wires them in.
 */

// ---------------------------------------------------------------------------
// Header Policies — declarative header injection rules
// ---------------------------------------------------------------------------

export interface HeaderPolicyWhen {
  /** Match when the provider ID (lowercase) equals this value. */
  providerId?: string;
  /** Match when the provider type (lowercase) contains this substring. */
  providerTypeContains?: string;
}

export interface HeaderPolicyRule {
  /** Condition guard — ALL fields must match for the rule to fire. */
  when: HeaderPolicyWhen;
  /** Headers to set only if the key is NOT already present. */
  setIfMissing?: Record<string, string>;
  /** Headers to unconditionally set (overwrite). */
  set?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Policy Overrides — declarative observe/enforce skip rules
// ---------------------------------------------------------------------------

export interface PolicyPhaseOverride {
  /** When true, policy observation/enforcement is skipped for this profile. */
  skip: boolean;
}

export interface PolicyOverrideConfig {
  observe?: PolicyPhaseOverride;
  enforce?: PolicyPhaseOverride;
}

// ---------------------------------------------------------------------------
// Compat Profile — extended shape (superset of existing JSON)
// ---------------------------------------------------------------------------

export interface CompatProfileEntry {
  id: string;
  protocol: string;
  /** Declarative header injection rules evaluated at provider-normalization time. */
  headerPolicies?: HeaderPolicyRule[];
  /** Policy engine overrides evaluated at hub-policy time. */
  policyOverrides?: PolicyOverrideConfig;
  // request/response mappings are kept as-is (opaque here)
  request?: unknown;
  response?: unknown;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Provider Compat Block — for resolveCompatibilityProfile replacement
// ---------------------------------------------------------------------------

export interface ProviderCompatBlock {
  /** Provider ID pattern (lowercase exact match). */
  providerId?: string;
  /** Provider type pattern (lowercase substring match). */
  providerTypeContains?: string;
  /** The compatibility profile ID to resolve to. */
  compatibilityProfile: string;
  /** The outbound wire protocol to resolve to. */
  outboundProfile: string;
}

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

export interface CompatProfileRegistry {
  /** All loaded profiles keyed by id. */
  profiles: Map<string, CompatProfileEntry>;
  /** Provider compat blocks for default-profile resolution. */
  providerBlocks: ProviderCompatBlock[];
  /** Config-driven provider type / outbound / default-profile resolution. */
  providerResolutionConfig?: ProviderResolutionConfig;
}

// ---------------------------------------------------------------------------
// Provider Resolution Config — config-driven provider type detection
// ---------------------------------------------------------------------------

export interface TypeKeywordRule {
  keywords: string[];
  providerType: string;
}

export interface CompatibilityProfileBlock {
  providerId?: string;
  providerTypeContains?: string;
  compatibilityProfile: string;
}

export interface ProviderResolutionConfig {
  typeKeywords: TypeKeywordRule[];
  defaultProviderType: string;
  outboundProfiles: Record<string, string>;
  defaultOutboundProfile: string;
  compatibilityProfileBlocks: CompatibilityProfileBlock[];
  defaultCompatibilityProfile: string;
}
