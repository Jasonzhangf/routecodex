/**
 * RouteCodex Configuration Version Management
 * Handles schema versioning and version assertions for configurations
 */

import { ConfigError } from '../types/config-types.js';

// Supported schema versions
export const SUPPORTED_SCHEMA_VERSIONS = ['1.0.0', '1.1.0', '2.0.0'];

// Current schema version
export const CURRENT_SCHEMA_VERSION = '2.0.0';

// Version compatibility matrix
export const VERSION_COMPATIBILITY: Record<string, string[]> = {
  '1.0.0': ['1.0.0'],
  '1.1.0': ['1.0.0', '1.1.0'],
  '2.0.0': ['1.0.0', '1.1.0', '2.0.0'],
};

// Version deprecation warnings
export const DEPRECATED_VERSIONS: Record<string, string> = {
  '1.0.0': 'Schema version 1.0.0 is deprecated. Please upgrade to 2.0.0.',
  '1.1.0': 'Schema version 1.1.0 is deprecated. Please upgrade to 2.0.0.',
};

// Version feature flags
export const VERSION_FEATURES: Record<string, string[]> = {
  '1.0.0': ['basic-routing', 'provider-config', 'validation'],
  '1.1.0': ['basic-routing', 'provider-config', 'validation', 'oauth-support', 'compatibility-layers'],
  '2.0.0': ['basic-routing', 'provider-config', 'validation', 'oauth-support', 'compatibility-layers', 'schema-versioning', 'stable-sorting', 'thinking-modes'],
};

/**
 * Validates that a schema version is supported
 */
export function validateSchemaVersion(version: string | undefined): ConfigError[] {
  const errors: ConfigError[] = [];

  if (!version) {
    // schemaVersion is optional for backward compatibility
    return [];
  }

  if (!SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
    errors.push({
      code: 'UNSUPPORTED_SCHEMA_VERSION',
      message: `Unsupported schema version: ${version}. Supported versions: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
      path: '/schemaVersion',
      value: version,
      expected: `One of: ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`,
    });
  }

  return errors;
}

/**
 * Gets version compatibility information
 */
export function getVersionCompatibility(version: string): {
  compatible: boolean;
  warnings: string[];
  features: string[];
} {
  const compatible = VERSION_COMPATIBILITY[CURRENT_SCHEMA_VERSION]?.includes(version) || false;
  const warnings: string[] = [];
  const features = VERSION_FEATURES[version] || [];

  if (DEPRECATED_VERSIONS[version]) {
    warnings.push(DEPRECATED_VERSIONS[version]);
  }

  if (!compatible) {
    warnings.push(`Schema version ${version} may not be fully compatible with current version ${CURRENT_SCHEMA_VERSION}`);
  }

  return { compatible, warnings, features };
}

/**
 * Creates a version assertion for configuration validation
 */
export function createVersionAssertion(config: any): {
  errors: ConfigError[];
  warnings: string[];
  versionInfo: {
    configVersion: string;
    schemaVersion?: string;
    currentSchemaVersion: string;
    compatible: boolean;
    features: string[];
  };
} {
  const errors: ConfigError[] = [];
  const warnings: string[] = [];

  const configVersion = config.version || 'unknown';
  const schemaVersion = config.schemaVersion;
  const currentSchemaVersion = CURRENT_SCHEMA_VERSION;

  // Validate schema version if present
  const schemaVersionErrors = validateSchemaVersion(schemaVersion);
  errors.push(...schemaVersionErrors);

  // Get compatibility information
  const compatibility = schemaVersion ? getVersionCompatibility(schemaVersion) : {
    compatible: true,
    warnings: [],
    features: VERSION_FEATURES['1.0.0'] || [],
  };

  warnings.push(...compatibility.warnings);

  // Basic version format validation
  if (configVersion && !/^\d+\.\d+\.\d+$/.test(configVersion)) {
    errors.push({
      code: 'INVALID_VERSION_FORMAT',
      message: `Invalid version format: ${configVersion}. Expected format: X.Y.Z`,
      path: '/version',
      value: configVersion,
      expected: 'Semantic version format (X.Y.Z)',
    });
  }

  return {
    errors,
    warnings,
    versionInfo: {
      configVersion,
      schemaVersion,
      currentSchemaVersion,
      compatible: compatibility.compatible,
      features: compatibility.features,
    },
  };
}

/**
 * Auto-upgrades configuration from older schema versions
 */
export function autoUpgradeConfiguration(config: any): any {
  const schemaVersion = config.schemaVersion || '1.0.0';

  // If already at current version, return as-is
  if (schemaVersion === CURRENT_SCHEMA_VERSION) {
    return config;
  }

  const upgraded = JSON.parse(JSON.stringify(config));

  // Add schemaVersion field if missing
  if (!upgraded.schemaVersion) {
    upgraded.schemaVersion = schemaVersion;
  }

  // Apply version-specific upgrades
  switch (schemaVersion) {
    case '1.0.0':
      // Upgrade from 1.0.0 to 1.1.0
      // Do NOT inject any default compatibility. Compatibility is loaded only when explicitly configured.
      upgraded.schemaVersion = '1.1.0';
      // falls through

    case '1.1.0':
      // Intentional fallthrough from 1.0.0 to 1.1.0 to 2.0.0
      // Upgrade from 1.1.0 to 2.0.0
      // Add stable sorting configuration
      if (!upgraded.stableSorting) {
        upgraded.stableSorting = {
          enabled: true,
          sortProviders: true,
          sortRouting: true,
          sortKeyMappings: true,
        };
      }
      upgraded.schemaVersion = '2.0.0';
      break;
  }

  return upgraded;
}

/**
 * Gets the recommended schema version for a configuration
 */
export function getRecommendedSchemaVersion(config: any): string {
  // Check for features that require newer schema versions
  const hasOAuth = Object.values(config.virtualrouter?.providers || {}).some(
    (provider: any) => provider.oauth || provider.auth?.type === 'oauth'
  );

  const hasThinking = Object.values(config.virtualrouter?.providers || {}).some(
    (provider: any) => Object.values(provider.models || {}).some(
      (model: any) => model.thinking?.enabled
    )
  );

  const hasCompatibility = Object.values(config.virtualrouter?.providers || {}).some(
    (provider: any) => provider.compatibility
  );

  if (hasThinking) {
    return '2.0.0';
  }

  if (hasOAuth || hasCompatibility) {
    return '1.1.0';
  }

  return '1.0.0';
}
