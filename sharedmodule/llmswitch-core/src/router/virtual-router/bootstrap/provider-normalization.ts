/**
 * Provider normalization logic for Virtual Router bootstrap.
 * Extracted from bootstrap.ts to improve modularity and testability.
 *
 * Step B: Hardcoded if-chains replaced with config-driven compat profile registry.
 * - detectProviderType → detectProviderTypeFromConfig (provider-resolution-config.json)
 * - mapOutboundProfile → resolveOutboundProfileFromConfig (provider-resolution-config.json)
 * - resolveCompatibilityProfile defaults → resolveDefaultCompatibilityProfileFromConfig
 * - maybeInjectQwenHeaders / maybeInjectClaudeCodeHeaders → applyHeaderPolicies (profile JSONs)
 */
import {
  VirtualRouterError,
  VirtualRouterErrorCode,
  type ProviderAuthConfig,
  type ProviderRuntimeProfile,
  type DeepSeekCompatRuntimeOptions,
  type ResponsesProviderConfig,
  type ModelCapability,
  type AnthropicThinkingConfig,
  type AnthropicThinkingBudgetMap
} from '../types.js';
import { normalizeAnthropicThinking, normalizeModelCapabilities, normalizeResponsesConfig, resolveProviderStreamingPreference } from './responses-helpers.js';
import { normalizeModelStreaming, normalizeModelContextTokens, normalizeModelOutputTokens } from './streaming-helpers.js';

// Step B: Config-driven compat registry
import { loadCompatProfileRegistry, getHeaderPolicies, getProfile } from '../../../conversion/compat/profile-registry/registry.js';
import { applyHeaderPolicies } from '../../../conversion/compat/profile-registry/header-policies.js';
import {
  detectProviderTypeFromConfig,
  resolveOutboundProfileFromConfig,
  resolveDefaultCompatibilityProfileFromConfig
} from '../../../conversion/compat/profile-registry/provider-resolver.js';

const DEFAULT_PROVIDER_MAX_OUTPUT_TOKENS = 8192;

// Load compat registry at module level (singleton, fail-fast on missing config)
const compatRegistry = loadCompatProfileRegistry();
const resolutionConfig = compatRegistry.providerResolutionConfig;
if (!resolutionConfig) {
  throw new Error(
    '[provider-normalization] provider-resolution-config.json not found. ' +
    'This file is required for config-driven provider type / outbound / compatibility resolution.'
  );
}

export interface ProviderAuthEntry {
  keyAlias: string;
  auth: ProviderAuthConfig;
}

export interface NormalizedProvider {
  providerId: string;
  providerType: string;
  endpoint: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  outboundProfile: string;
  compatibilityProfile: string;
  processMode: 'chat' | 'passthrough';
  responsesConfig?: ResponsesProviderConfig;
  streaming?: 'always' | 'auto' | 'never';
  modelStreaming?: Record<string, 'always' | 'auto' | 'never'>;
  modelOutputTokens?: Record<string, number>;
  defaultOutputTokens?: number;
  modelContextTokens?: Record<string, number>;
  defaultContextTokens?: number;
  modelAnthropicThinkingConfig?: Record<string, AnthropicThinkingConfig>;
  defaultAnthropicThinkingConfig?: AnthropicThinkingConfig;
  modelAnthropicThinking?: Record<string, string>;
  defaultAnthropicThinking?: string;
  modelAnthropicThinkingBudgets?: Record<string, AnthropicThinkingBudgetMap>;
  defaultAnthropicThinkingBudgets?: AnthropicThinkingBudgetMap;
  deepseek?: DeepSeekCompatRuntimeOptions;
  serverToolsDisabled?: boolean;
  modelCapabilities?: Record<string, ModelCapability[]>;
}

export interface ProviderRuntimeBuildResult {
  runtimeEntries: Record<string, ProviderRuntimeProfile>;
  aliasIndex: Map<string, string[]>;
  modelIndex: Map<string, { declared: boolean; models: string[] }>;
}

/**
 * Normalize a raw provider configuration into a NormalizedProvider.
 */
export function normalizeProvider(providerId: string, raw: unknown): NormalizedProvider {
  const provider = asRecord(raw);
  const enabled =
    typeof provider.enabled === 'boolean'
      ? provider.enabled
      : typeof provider.enabled === 'string'
        ? provider.enabled.trim().toLowerCase() !== 'false'
        : undefined;
  const providerType = detectProviderType(provider);
  const endpoint =
    typeof provider.endpoint === 'string' && provider.endpoint.trim()
      ? provider.endpoint.trim()
      : typeof provider.baseURL === 'string' && provider.baseURL.trim()
        ? provider.baseURL.trim()
        : typeof provider.baseUrl === 'string' && provider.baseUrl.trim()
          ? provider.baseUrl.trim()
          : '';
  const compatibilityProfile = resolveCompatibilityProfile(providerId, provider);
  const headers = applyProfileHeaders(
    providerId,
    providerType,
    compatibilityProfile,
    normalizeHeaders(provider.headers)
  );
  const responsesNode = asRecord(provider.responses);
  const responsesConfig = normalizeResponsesConfig({
    providerId,
    providerType,
    compatibilityProfile,
    provider,
    node: responsesNode
  });
  const processMode = normalizeProcessMode(provider.process);
  const streaming = resolveProviderStreamingPreference(provider, responsesNode);
  const modelStreaming = normalizeModelStreaming(provider);
  const { modelContextTokens, defaultContextTokens } = normalizeModelContextTokens(provider);
  const { modelOutputTokens, defaultOutputTokens: explicitDefaultOutputTokens } = normalizeModelOutputTokens(provider);
  const {
    modelAnthropicThinkingConfig,
    defaultAnthropicThinkingConfig,
    modelAnthropicThinking,
    defaultAnthropicThinking,
    modelAnthropicThinkingBudgets,
    defaultAnthropicThinkingBudgets
  } = normalizeAnthropicThinking(provider, providerType);
  const defaultOutputTokens =
    explicitDefaultOutputTokens ??
    (processMode === 'passthrough' ? undefined : DEFAULT_PROVIDER_MAX_OUTPUT_TOKENS);
  const deepseek = normalizeDeepSeekOptions(provider);
  const serverToolsDisabled =
    provider.serverToolsDisabled === true ||
    (typeof provider.serverToolsDisabled === 'string' &&
      provider.serverToolsDisabled.trim().toLowerCase() === 'true') ||
    (provider.serverTools &&
      typeof provider.serverTools === 'object' &&
      (provider.serverTools as Record<string, unknown>).enabled === false);
  const modelCapabilities = normalizeModelCapabilities(provider);
  return {
    providerId,
    providerType,
    endpoint,
    headers,
    ...(enabled !== undefined ? { enabled } : {}),
    outboundProfile: mapOutboundProfile(providerType),
    compatibilityProfile,
    processMode,
    responsesConfig,
    streaming,
    modelStreaming,
    modelOutputTokens,
    defaultOutputTokens,
    modelContextTokens,
    defaultContextTokens,
    modelAnthropicThinkingConfig,
    defaultAnthropicThinkingConfig,
    modelAnthropicThinking,
    defaultAnthropicThinking,
    modelAnthropicThinkingBudgets,
    defaultAnthropicThinkingBudgets,
    ...(deepseek ? { deepseek } : {}),
    ...(serverToolsDisabled ? { serverToolsDisabled: true } : {}),
    ...(modelCapabilities ? { modelCapabilities } : {})
  };
}

// ---------------------------------------------------------------------------
// Config-driven header injection
// Replaces: maybeInjectQwenHeaders + maybeInjectClaudeCodeHeaders
// ---------------------------------------------------------------------------

function applyProfileHeaders(
  providerId: string,
  providerType: string,
  compatibilityProfile: string,
  headers: Record<string, string> | undefined
): Record<string, string> | undefined {
  // Look up header policy rules from the compat profile registry
  const rules = getHeaderPolicies(compatRegistry, compatibilityProfile);
  const result = applyHeaderPolicies(headers, rules, { providerId, providerType });
  return result;
}

// ---------------------------------------------------------------------------
// Config-driven detectProviderType
// Delegates to detectProviderTypeFromConfig using provider-resolution-config.json
// ---------------------------------------------------------------------------

export function detectProviderType(provider: Record<string, unknown>): string {
  return detectProviderTypeFromConfig(resolutionConfig, provider);
}

// ---------------------------------------------------------------------------
// Config-driven mapOutboundProfile
// Delegates to resolveOutboundProfileFromConfig using provider-resolution-config.json
// ---------------------------------------------------------------------------

export function mapOutboundProfile(providerType: string): string {
  return resolveOutboundProfileFromConfig(resolutionConfig, providerType);
}

// ---------------------------------------------------------------------------
// Config-driven resolveCompatibilityProfile
// Explicit compatibilityProfile from provider config takes precedence.
// Default resolution uses config-driven compatibilityProfileBlocks.
// ---------------------------------------------------------------------------

function resolveCompatibilityProfile(providerId: string, provider: Record<string, unknown>): string {
  if (typeof provider.compatibilityProfile === 'string' && provider.compatibilityProfile.trim()) {
    return provider.compatibilityProfile.trim();
  }
  const legacyFields: string[] = [];
  if (typeof provider.compat === 'string') {
    legacyFields.push('compat');
  }
  if (typeof provider.compatibility_profile === 'string') {
    legacyFields.push('compatibility_profile');
  }
  if (legacyFields.length > 0) {
    throw new VirtualRouterError(
      `Provider "${providerId}" uses legacy compatibility field(s): ${legacyFields.join(
        ', '
      )}. Rename to "compatibilityProfile".`,
      VirtualRouterErrorCode.CONFIG_ERROR
    );
  }
  // Config-driven default resolution (replaces hardcoded antigravity/gemini-cli if-chain)
  return resolveDefaultCompatibilityProfileFromConfig(resolutionConfig, providerId, provider);
}

// ---------------------------------------------------------------------------
// Utilities (unchanged)
// ---------------------------------------------------------------------------

function normalizeDeepSeekOptions(
  provider: Record<string, unknown>
): DeepSeekCompatRuntimeOptions | undefined {
  const direct = asRecord(provider.deepseek);
  const ext = asRecord(asRecord(provider.extensions)?.deepseek);
  const source = Object.keys(direct).length ? direct : ext;
  if (!source || !Object.keys(source).length) {
    return undefined;
  }
  const strictToolRequired =
    typeof source.strictToolRequired === 'boolean'
      ? source.strictToolRequired
      : typeof source.strictToolRequired === 'string'
        ? source.strictToolRequired.trim().toLowerCase() === 'true'
        : undefined;
  const toolProtocolRaw =
    typeof source.toolProtocol === 'string' ? source.toolProtocol.trim().toLowerCase() : '';
  let toolProtocol: DeepSeekCompatRuntimeOptions['toolProtocol'];
  if (toolProtocolRaw === 'text' || toolProtocolRaw === 'native') {
    toolProtocol = toolProtocolRaw;
  }
  const legacyTextToolFallback =
    typeof source.textToolFallback === 'boolean'
      ? source.textToolFallback
      : typeof source.textToolFallback === 'string'
        ? source.textToolFallback.trim().toLowerCase() === 'true'
        : undefined;
  if (toolProtocol === undefined && legacyTextToolFallback !== undefined) {
    toolProtocol = legacyTextToolFallback ? 'text' : 'native';
  }
  if (strictToolRequired === undefined && toolProtocol === undefined) {
    return undefined;
  }
  return {
    ...(strictToolRequired !== undefined ? { strictToolRequired } : {}),
    ...(toolProtocol !== undefined ? { toolProtocol } : {})
  };
}

function normalizeProcessMode(value: unknown): 'chat' | 'passthrough' {
  if (typeof value !== 'string') {
    return 'chat';
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'passthrough') {
    return 'passthrough';
  }
  return 'chat';
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  if (!headers) {
    return false;
  }
  const lowered = name.trim().toLowerCase();
  if (!lowered) {
    return false;
  }
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

export function normalizeHeaders(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === 'string') {
      entries[key] = value;
    }
  }
  return Object.keys(entries).length ? entries : undefined;
}
function asRecord<T extends Record<string, unknown>>(value: unknown): T {
  return (value && typeof value === 'object' ? value : {}) as T;
}
