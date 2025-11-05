/**
 * Configuration Types for RouteCodex
 * Extended with Unimplemented Module Support
 */

// Local placeholder for ProviderConfig to avoid dependency on old server types
type ProviderConfig = Record<string, unknown>;
import { type UnimplementedModuleConfig } from '../modules/unimplemented-module.js';
// UnimplementedProviderConfig dependency removed; use generic shape to avoid tight coupling
type UnimplementedProviderConfig = Record<string, unknown>;

/**
 * Module configuration types
 */
export type ModuleType = 'provider' | 'core' | 'unimplemented' | 'custom';

/**
 * Base module configuration
 */
export interface BaseModuleConfig {
  id: string;
  name: string;
  type: ModuleType;
  enabled: boolean;
  description?: string;
  version?: string;
}

/**
 * Unimplemented module configuration
 */
export interface UnimplementedModuleConfiguration extends BaseModuleConfig {
  type: 'unimplemented';
  unimplementedConfig: UnimplementedModuleConfig;
}

/**
 * Provider module configuration with unimplemented support
 */
export interface ProviderModuleConfiguration extends BaseModuleConfig {
  type: 'provider';
  providerConfig: ProviderConfig | UnimplementedProviderConfig;
  fallbackToUnimplemented?: boolean;
}

/**
 * Core module configuration
 */
export interface CoreModuleConfiguration extends BaseModuleConfig {
  type: 'core';
  coreConfig: Record<string, unknown>;
}

/**
 * Custom module configuration
 */
export interface CustomModuleConfiguration extends BaseModuleConfig {
  type: 'custom';
  customConfig: Record<string, unknown>;
}

/**
 * Union type for all module configurations
 */
export type ModuleConfiguration =
  | UnimplementedModuleConfiguration
  | ProviderModuleConfiguration
  | CoreModuleConfiguration
  | CustomModuleConfiguration;

/**
 * Unimplemented module factory configuration
 */
export interface UnimplementedModuleFactoryConfig {
  enabled: boolean;
  maxModules?: number;
  cleanupInterval?: number;
  maxModuleAge?: number;
  defaultLogLevel?: 'debug' | 'info' | 'warn' | 'error';
  defaultMaxCallerHistory?: number;
  enableMetrics?: boolean;
  enableAutoCleanup?: boolean;
}

/**
 * Enhanced provider manager configuration
 */
export interface EnhancedProviderManagerConfig {
  enableUnimplementedProviders: boolean;
  autoCreateUnimplemented: boolean;
  unimplementedProviderDefaults?: {
    unimplementedMessage?: string;
    logUnimplementedCalls?: boolean;
    trackCallerInfo?: boolean;
  };
  unimplementedModuleFactory?: UnimplementedModuleFactoryConfig;
}

/**
 * Global unimplemented module configuration
 */
export interface GlobalUnimplementedConfig {
  enabled: boolean;
  factory?: UnimplementedModuleFactoryConfig;
  providerManager?: EnhancedProviderManagerConfig;
  defaultModuleConfig?: Partial<UnimplementedModuleConfig>;
}

/**
 * Extended server configuration with unimplemented module support
 */
export interface ExtendedServerConfig {
  modules?: ModuleConfiguration[];
  unimplementedModules?: GlobalUnimplementedConfig;
  enableUnimplementedTracking?: boolean;
  unimplementedCallThreshold?: number;
  autoGenerateUnimplemented?: boolean;
}

/**
 * Unimplemented call analytics
 */
export interface UnimplementedCallAnalytics {
  totalUnimplementedCalls: number;
  uniqueModulesCalled: number;
  mostCalledModules: Array<{
    moduleId: string;
    callCount: number;
    lastCalled: string;
  }>;
  callsByTime: Record<string, number>;
  callerDistribution: Record<string, number>;
  implementationPriority: Array<{
    moduleId: string;
    priority: number;
    callCount: number;
    lastCalled: string;
    callerCount: number;
  }>;
}

/**
 * Module usage statistics
 */
export interface ModuleUsageStats {
  moduleId: string;
  moduleName: string;
  moduleType: ModuleType;
  totalCalls: number;
  lastCallTime?: string;
  firstCallTime?: string;
  averageCallsPerDay: number;
  uniqueCallers: number;
  isImplemented: boolean;
  implementationPriority: number;
}

/**
 * Configuration validation result
 */
export interface ConfigValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  suggestions: string[];
}

/**
 * Configuration helper types
 */
export type ModuleConfigType = 'unimplemented' | 'provider' | 'core' | 'custom';
export type UnimplementedLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type UnimplementedCallTracking = 'none' | 'basic' | 'detailed' | 'full';

/**
 * Configuration presets for common scenarios
 */
export interface UnimplementedConfigPresets {
  development: GlobalUnimplementedConfig;
  staging: GlobalUnimplementedConfig;
  production: GlobalUnimplementedConfig;
  minimal: GlobalUnimplementedConfig;
  comprehensive: GlobalUnimplementedConfig;
}

/**
 * Default configuration values
 */
export const DEFAULT_UNIMPLEMENTED_CONFIG: GlobalUnimplementedConfig = {
  enabled: true,
  factory: {
    enabled: true,
    maxModules: 1000,
    cleanupInterval: 24 * 60 * 60 * 1000, // 24 hours
    maxModuleAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    defaultLogLevel: 'info',
    defaultMaxCallerHistory: 100,
    enableMetrics: true,
    enableAutoCleanup: true,
  },
  providerManager: {
    enableUnimplementedProviders: true,
    autoCreateUnimplemented: true,
    unimplementedProviderDefaults: {
      unimplementedMessage: 'This provider functionality is not yet implemented',
      logUnimplementedCalls: true,
      trackCallerInfo: true,
    },
  },
  defaultModuleConfig: {
    logLevel: 'info',
    maxCallerHistory: 100,
    customMessage: 'This functionality is not yet implemented',
  },
};

/**
 * Configuration presets
 */
export const UNIMPLEMENTED_CONFIG_PRESETS: UnimplementedConfigPresets = {
  development: {
    ...DEFAULT_UNIMPLEMENTED_CONFIG,
    factory: {
      ...DEFAULT_UNIMPLEMENTED_CONFIG.factory!,
      defaultLogLevel: 'debug',
      enableMetrics: true,
    },
  },
  staging: {
    ...DEFAULT_UNIMPLEMENTED_CONFIG,
    factory: {
      ...DEFAULT_UNIMPLEMENTED_CONFIG.factory!,
      defaultLogLevel: 'info',
      cleanupInterval: 12 * 60 * 60 * 1000, // 12 hours
    },
  },
  production: {
    ...DEFAULT_UNIMPLEMENTED_CONFIG,
    factory: {
      ...DEFAULT_UNIMPLEMENTED_CONFIG.factory!,
      defaultLogLevel: 'warn',
      enableAutoCleanup: true,
      maxModuleAge: 3 * 24 * 60 * 60 * 1000, // 3 days
    },
  },
  minimal: {
    enabled: true,
    factory: {
      enabled: true,
      maxModules: 100,
      defaultLogLevel: 'error',
      enableMetrics: false,
      enableAutoCleanup: false,
    },
    providerManager: {
      enableUnimplementedProviders: true,
      autoCreateUnimplemented: false,
      unimplementedProviderDefaults: {
        logUnimplementedCalls: false,
        trackCallerInfo: false,
      },
    },
  },
  comprehensive: {
    ...DEFAULT_UNIMPLEMENTED_CONFIG,
    factory: {
      ...DEFAULT_UNIMPLEMENTED_CONFIG.factory!,
      maxModules: 5000,
      defaultLogLevel: 'info',
      enableMetrics: true,
      enableAutoCleanup: true,
      cleanupInterval: 6 * 60 * 60 * 1000, // 6 hours
    },
    providerManager: {
      enableUnimplementedProviders: true,
      autoCreateUnimplemented: true,
      unimplementedProviderDefaults: {
        unimplementedMessage:
          'This functionality is currently unavailable. Implementation priority has been logged.',
        logUnimplementedCalls: true,
        trackCallerInfo: true,
      },
    },
  },
};
