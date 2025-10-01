/**
 * RouteCodex Configuration Compatibility Layer
 * Preserves existing normalization logic while providing clean interface
 */

// Import required types and classes for local use
import type { CompatibilityOptions, CompatibilityResult } from './types/compatibility-types.js';
import { CompatibilityEngine } from './compatibility-engine.js';

// Main compatibility engine
export { CompatibilityEngine } from './compatibility-engine.js';

// Core types
export type {
  CompatibilityConfig,
  CompatibilityOptions,
  CompatibilityResult,
  CompatibilityWarning,
  KeyMappings,
  AuthMappings,
  RouteTarget,
  RouteTargetPool,
  PipelineConfig,
  PipelineConfigs,
  ModuleConfigs,
  ProviderNormalizationRule,
  EnvExpansionOptions,
  ThinkingConfigMerge
} from './types/compatibility-types.js';

// Normalization modules
export {
  // Provider type normalization
  normalizeProviderType,
  applyProviderTransformations,
  generateProviderAuth,
  normalizeLLMSwitchType,
  getDefaultLLMSwitchType
} from './normalization/provider-normalization.js';

export {
  // Key alias normalization
  expandEnvVar,
  generateKeyAliasMapping,
  getProviderKeyAliases,
  resolveKeyByAlias,
  parseRouteTarget,
  buildKeyMappings,
  resolveActualKey,
  hasAuthMapping,
  resolveOAuthTokenPath,
  normalizeOAuthConfig
} from './normalization/key-alias-normalization.js';

export {
  // Thinking configuration normalization
  mergeThinkingConfig,
  extractThinkingConfig,
  mergeGLMThinkingConfig,
  validateThinkingConfig,
  normalizeThinkingConfig,
  applyThinkingDefaults
} from './normalization/thinking-config-normalization.js';

// Direct API key configuration utilities (migration helpers)
export {
  DirectApiKeyConfig,
  type DirectConfigMigrationOptions,
  type DirectConfigMigrationResult,
  type ConfigValidationResult as DirectConfigValidationResult
} from './utils/direct-api-key-config.js';

export {
  // Compatibility string normalization
  parseCompatibilityString,
  normalizeCompatibilityType,
  compatibilityToString,
  mergeCompatibilityConfigs,
  validateCompatibilityConfig
} from './normalization/compatibility-string-normalization.js';

// Factory function for creating compatibility engine with options
export function createCompatibilityEngine(options?: CompatibilityOptions): CompatibilityEngine {
  return new CompatibilityEngine(options);
}

// Default compatibility options for common use cases
export const DEFAULT_COMPATIBILITY_OPTIONS: CompatibilityOptions = {
  expandEnvVars: true,
  normalizeProviderTypes: true,
  generateKeyAliases: true,
  processOAuth: true,
  defaultCompatibility: 'passthrough-compatibility',
  defaultLLMSwitch: 'llmswitch-openai-openai'
};

// Legacy compatibility options for backward compatibility
export const LEGACY_COMPATIBILITY_OPTIONS: CompatibilityOptions = {
  expandEnvVars: true,
  normalizeProviderTypes: true,
  generateKeyAliases: true,
  processOAuth: true,
  defaultCompatibility: 'passthrough-compatibility',
  defaultLLMSwitch: 'llmswitch-openai-openai'
};

// Strict compatibility options for new configurations
export const STRICT_COMPATIBILITY_OPTIONS: CompatibilityOptions = {
  expandEnvVars: false, // Require explicit keys
  normalizeProviderTypes: true,
  generateKeyAliases: true,
  processOAuth: true,
  defaultCompatibility: undefined, // Require explicit compatibility
  defaultLLMSwitch: undefined // Require explicit LLM switch
};

// Utility functions for common operations

/**
 * Quick compatibility processing with default options
 */
export async function processConfigWithDefaults(configString: string): Promise<CompatibilityResult> {
  const engine = createCompatibilityEngine(DEFAULT_COMPATIBILITY_OPTIONS);
  return await engine.processCompatibility(configString);
}

/**
 * Process configuration file with auto-discovery from ~/.routecodex/config/
 */
export async function processConfigFile(configName?: string): Promise<CompatibilityResult> {
  const engine = createCompatibilityEngine(DEFAULT_COMPATIBILITY_OPTIONS);
  const fs = await import('fs');
  const path = await import('path');
  const { homedir } = await import('os');

  const configDir = path.join(homedir(), '.routecodex', 'config');

  try {
    if (!fs.existsSync(configDir)) {
      return {
        isValid: false,
        errors: [{
          code: 'CONFIG_DIR_NOT_FOUND',
          message: `Configuration directory not found: ${configDir}`
        }],
        warnings: [],
        compatibilityWarnings: []
      };
    }

    const files = fs.readdirSync(configDir);
    const configFiles = files.filter(f => f.endsWith('.json'));

    if (configFiles.length === 0) {
      return {
        isValid: false,
        errors: [{
          code: 'NO_CONFIG_FILES',
          message: `No configuration files found in ${configDir}`
        }],
        warnings: [],
        compatibilityWarnings: []
      };
    }

    // If configName specified, try to find exact match
    if (configName) {
      const targetFile = configName.endsWith('.json') ? configName : `${configName}.json`;
      const targetPath = path.join(configDir, targetFile);

      if (fs.existsSync(targetPath)) {
        const configString = fs.readFileSync(targetPath, 'utf8');
        return await engine.processCompatibility(configString);
      }

      return {
        isValid: false,
        errors: [{
          code: 'CONFIG_FILE_NOT_FOUND',
          message: `Configuration file not found: ${targetPath}`
        }],
        warnings: [],
        compatibilityWarnings: []
      };
    }

    // Default to first .json file if no specific config requested
    const defaultConfig = path.join(configDir, configFiles[0]);
    const configString = fs.readFileSync(defaultConfig, 'utf8');
    return await engine.processCompatibility(configString);

  } catch (error) {
    return {
      isValid: false,
      errors: [{
        code: 'CONFIG_PROCESSING_ERROR',
        message: `Failed to process configuration: ${error instanceof Error ? error.message : 'Unknown error'}`
      }],
      warnings: [],
      compatibilityWarnings: []
    };
  }
}

// Version information
export const COMPATIBILITY_ENGINE_VERSION = '1.0.0';

// Export for backward compatibility
export { CompatibilityEngine as ConfigCompatLayer };

// Re-export commonly used config-engine types for convenience
export type {
  RouteCodexConfigType,
  ProviderConfigType,
  ConfigValidationResult,
  ConfigError,
  ConfigWarning
} from 'routecodex-config-engine';