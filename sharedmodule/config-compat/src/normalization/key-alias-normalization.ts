/**
 * Key Alias Normalization
 * Handles key alias generation and resolution based on existing logic
 */

import { KeyMappings } from '../types/compatibility-types.js';

/**
 * Environment variable expansion logic extracted from existing UserConfigParser
 */
export function expandEnvVar(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();
  const m = trimmed.match(/^\$\{?([A-Za-z0-9_]+)\}?$/);

  if (!m) {
    return trimmed;
  }

  const envName = m[1];
  const envVal = process.env[envName];

  if (typeof envVal === 'string' && envVal.length > 0) {
    return envVal;
  }

  return trimmed;
}

/**
 * Generate key alias mapping for a provider
 * Creates sequential aliases: key1, key2, key3... mapping to real keys
 */
export function generateKeyAliasMapping(
  _providerId: string,
  providerConfig: any
): Record<string, string> {
  // Always produce at least one alias to keep downstream stable
  if (!providerConfig || (!providerConfig.apiKey && !providerConfig.auth && !providerConfig.oauth)) {
    return { key1: 'default' };
  }

  // OAuth-first fallback
  if ((providerConfig.auth && providerConfig.auth.type === 'oauth') || providerConfig.oauth) {
    return { key1: 'auth-default' };
  }

  const mapping: Record<string, string> = {};

  // Handle both string and array apiKey configurations
  const apiKeyValues = Array.isArray(providerConfig.apiKey)
    ? providerConfig.apiKey
    : [providerConfig.apiKey];

  // Generate sequential aliases for each real key
  apiKeyValues.forEach((realKey: string, index: number) => {
    const alias = `key${index + 1}`;
    mapping[alias] = expandEnvVar(realKey);
  });

  return mapping;
}

/**
 * Get all key aliases for a provider
 */
export function getProviderKeyAliases(
  providerId: string,
  providerConfig: any
): string[] {
  const mapping = generateKeyAliasMapping(providerId, providerConfig);
  return Object.keys(mapping);
}

/**
 * Resolve real key by alias
 */
export function resolveKeyByAlias(
  providerId: string,
  keyAlias: string,
  providerConfig: any
): string {
  const mapping = generateKeyAliasMapping(providerId, providerConfig);
  const realKey = mapping[keyAlias];
  // If not found, fall back to alias itself to avoid hard failure in OAuth scenarios
  return realKey || keyAlias || 'key1';
}

/**
 * Build comprehensive key mappings for all providers
 */
export function buildKeyMappings(
  providers: Record<string, any>
): KeyMappings {
  const keyMappings: KeyMappings = {
    providers: {},
    global: {},
    oauth: {}
  };

  for (const [providerId, providerConfig] of Object.entries(providers)) {
    // Generate key alias mappings for this provider
    const aliasMapping = generateKeyAliasMapping(providerId, providerConfig);
    keyMappings.providers[providerId] = aliasMapping;

    // Add global mappings for provider-specific aliases
    for (const [alias, realKey] of Object.entries(aliasMapping)) {
      // Only add to global if not already present
      if (!keyMappings.global[alias]) {
        keyMappings.global[alias] = realKey;
      }
    }

    // Process OAuth configurations
    if (providerConfig.oauth) {
      for (const [oauthName, oauthConfig] of Object.entries(providerConfig.oauth)) {
        const oauthAuthId = `auth-${providerId}-${oauthName}`;
        keyMappings.oauth[oauthAuthId] = normalizeOAuthConfig(oauthConfig);
      }
    }
  }

  return keyMappings;
}

/**
 * Parse route target with alias support
 * Supports formats:
 * - provider.model -> expands to all keys (key1, key2...)
 * - provider.model.key1/key2 -> uses specified alias
 */
export function parseRouteTarget(
  target: string,
  providers: Record<string, any>
): {
  providerId: string;
  modelId: string;
  keyAlias?: string;
} {
  const firstDotIndex = target.indexOf('.');

  if (firstDotIndex === -1) {
    throw new Error(`Invalid route target format: ${target}`);
  }

  const providerId = target.substring(0, firstDotIndex);
  const remaining = target.substring(firstDotIndex + 1);

  // Check if provider exists
  const providerConfig = providers[providerId];
  if (!providerConfig) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  // Find model in remaining string
  let modelId = '';
  let keyAlias = '';

  // Try to match known model names (sorted by length descending)
  const knownModels = Object.keys(providerConfig.models || {});
  const sortedModels = knownModels.sort((a, b) => b.length - a.length);

  let foundModel = null;
  for (const model of sortedModels) {
    if (remaining.startsWith(`${model}.`) || remaining === model) {
      foundModel = model;
      break;
    }
  }

  if (foundModel) {
    modelId = foundModel;
    const afterModel = remaining.substring(modelId.length);

    // Extract key alias if present
    if (afterModel.startsWith('.') && afterModel.length > 1) {
      const possibleKeyAlias = afterModel.substring(1);
      // Validate key alias format (key1, key2, etc.)
      if (possibleKeyAlias.match(/^key\d+$/)) {
        keyAlias = possibleKeyAlias;
      }
    }
  } else {
    // No known model found, use simple heuristic
    const lastDotIndex = remaining.lastIndexOf('.');

    if (lastDotIndex === -1) {
      // No key part, entire remaining is model
      modelId = remaining;
    } else {
      modelId = remaining.substring(0, lastDotIndex);
      keyAlias = remaining.substring(lastDotIndex + 1);
    }
  }

  return {
    providerId,
    modelId,
    keyAlias
  };
}

/**
 * Normalize OAuth configuration
 */
export function normalizeOAuthConfig(oauthConfig: unknown): any {
  if (!oauthConfig || typeof oauthConfig !== 'object') {
    return { value: oauthConfig };
  }

  try {
    return JSON.parse(JSON.stringify(oauthConfig));
  } catch {
    return { ...oauthConfig };
  }
}

/**
 * Resolve actual key considering auth mappings
 */
export function resolveActualKey(
  providerId: string,
  keyId: string,
  keyMappings: KeyMappings,
  _authMappings: Record<string, string>
): string {
  // Check if keyId is already an auth mapping
  if (keyId.startsWith('auth-')) {
    return keyId;
  }

  // Check provider-specific mappings
  const providerMapping = keyMappings.providers[providerId]?.[keyId];
  if (providerMapping) {
    return providerMapping;
  }

  // Check global mappings
  const globalMapping = keyMappings.global[keyId];
  if (globalMapping) {
    return globalMapping;
  }

  // Return original keyId if no mapping found
  return keyId;
}

/**
 * Check if provider has auth mapping for a key
 */
export function hasAuthMapping(
  providerId: string,
  keyId: string,
  keyMappings: KeyMappings
): boolean {
  if (keyId.startsWith('auth-')) {
    return true;
  }

  const providerMapping = keyMappings.providers[providerId]?.[keyId];
  if (providerMapping) {
    return true;
  }

  return Boolean(keyMappings.global[keyId]);
}

/**
 * Resolve OAuth token file path
 */
import { homedir } from 'os';
import path from 'path';

export function resolveOAuthTokenPath(
  providerId: string,
  oauthName: string,
  oauthConfig: any
): string {
  if (oauthConfig && typeof oauthConfig.tokenFile === 'string' && oauthConfig.tokenFile.trim()) {
    const rawPath = oauthConfig.tokenFile.trim();
    if (rawPath.startsWith('~')) {
      return path.join(homedir(), rawPath.slice(1));
    }
    return rawPath;
  }

  if (oauthConfig && Array.isArray(oauthConfig.tokens) && oauthConfig.tokens.length > 0) {
    const tokenCandidate = oauthConfig.tokens.find(
      (token: unknown) => typeof token === 'string' && token.trim()
    );
    if (typeof tokenCandidate === 'string') {
      return tokenCandidate.trim();
    }
  }

  // Fallback defaults per provider family
  const home = homedir();

  if (providerId.toLowerCase().includes('qwen')) {
    return path.join(home, '.qwen', 'oauth_creds.json');
  }

  if (providerId.toLowerCase().includes('iflow')) {
    return path.join(home, '.iflow', 'oauth_creds.json');
  }

  // Generic fallback under .routecodex/tokens
  return path.join(home, '.routecodex', 'tokens', `${providerId}-${oauthName}.json`);
}
