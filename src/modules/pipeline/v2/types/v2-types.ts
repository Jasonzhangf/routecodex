/**
 * V2 Pipeline Architecture Type Definitions
 *
 * Core types for V2 virtual pipeline architecture.
 */

import type { UnknownObject } from '../../../../types/common-types.js';

/**
 * V2 System Configuration
 */
export interface V2SystemConfig {
  version: '2.0';

  // System configuration
  system: {
    mode: 'v1' | 'v2' | 'hybrid';
    enableDryRun: boolean;
    featureFlags: Record<string, boolean>;
  };

  // Static instance pool configuration
  staticInstances: {
    preloadModules: string[];
    poolConfig: {
      maxInstancesPerType: number;
      warmupInstances: number;
      idleTimeout: number;
    };
  };

  // Virtual pipeline configuration
  virtualPipelines: {
    routeTable: RouteTableConfig;
    moduleRegistry: ModuleRegistryConfig;
  };

  // V1 configuration compatibility (auto convert)
  legacy?: UnknownObject;
}

/**
 * Route Table Configuration
 */
export interface RouteTableConfig {
  routes: RouteDefinition[];
  defaultRoute: string;
  // Note: No fallback strategies - fail fast when routing fails
}

/**
 * Route Definition
 */
export interface RouteDefinition {
  id: string;
  pattern: RequestPattern;
  modules: ModuleSpecification[];
  priority: number;
  metadata?: UnknownObject;
}

/**
 * Request Pattern for routing
 */
export interface RequestPattern {
  model?: RegExp | string;
  provider?: string;
  contentLength?: {
    min?: number;
    max?: number;
  };
  hasTools?: boolean;
  custom?: Record<string, unknown>;
}

/**
 * Module Specification
 */
export interface ModuleSpecification {
  // Module type
  type: string;

  // Configuration reference or inline configuration
  config?: ModuleConfig | string; // Support configuration ID reference

  // Conditional selection (based on request features) - Must match explicitly
  condition?: RequestCondition;

  // Note: No fallback - fail fast when condition not met
}

/**
 * Module Configuration
 */
export interface ModuleConfig {
  type: string;
  config: UnknownObject;
}

/**
 * Request Condition for module selection
 */
export interface RequestCondition {
  field: string;
  operator: 'equals' | 'contains' | 'matches' | 'exists' | 'gt' | 'lt';
  value: unknown;
  caseSensitive?: boolean;
}

/**
 * Module Registry Configuration
 */
export interface ModuleRegistryConfig {
  providers: Record<string, ProviderConfig>;
  compatibility: Record<string, CompatibilityConfig>;
  llmSwitch: Record<string, LLMSwitchConfig>;
}

/**
 * Provider Configuration
 */
export interface ProviderConfig {
  type: string;
  config: {
    providerType: string;
    baseUrl?: string;
    auth: {
      type: 'apikey' | 'oauth';
      apiKey?: string;
      clientId?: string;
      clientSecret?: string;
      tokenUrl?: string;
    };
    timeout?: number;
    maxRetries?: number;
    overrides?: {
      defaultModel?: string;
      headers?: Record<string, string>;
    };
    validation?: {
      requiredEnvVars?: string[];
      optionalEnvVars?: string[];
      validateAtRuntime?: boolean;
    };
  };
}

/**
 * Compatibility Configuration
 */
export interface CompatibilityConfig {
  type: string;
  config: {
    providerType: string;

    // Field mappings - Provider to OpenAI standard
    fieldMappings: {
      request: Record<string, string | null>;
      response: Record<string, string | null>;
    };

    // Format conversions
    formatConversions: Record<string, {
      source: string;
      target: string;
      transform: string;
    }>;

    // Provider specific processing
    providerSpecificProcessing: {
      cleanup: Array<{
        field: string;
        action: 'remove' | 'transform';
        value?: unknown;
      }>;
      conversions: Array<{
        from: string;
        to: string;
        when?: {
          field: string;
          exists?: boolean;
          equals?: unknown;
        };
      }>;
    };

    // Hooks configuration
    hooks?: {
      beforeFieldMapping?: Array<{
        name: string;
        enabled: boolean;
        config: UnknownObject;
      }>;
      afterFieldMapping?: Array<{
        name: string;
        enabled: boolean;
        config: UnknownObject;
      }>;
    };
  };
}

/**
 * LLM Switch Configuration
 */
export interface LLMSwitchConfig {
  type: string;
  config: {
    conversionType: string;
    protocol: string;
    profile?: UnknownObject;
  };
}

/**
 * Pipeline Request
 */
export interface PipelineRequest {
  id: string;
  method: string;
  headers: Record<string, string>;
  body: UnknownObject;
  metadata: {
    timestamp: number;
    traceId?: string;
    source?: string;
  };
}

/**
 * Pipeline Response
 */
export interface PipelineResponse {
  id: string;
  status: number;
  headers: Record<string, string>;
  body: UnknownObject;
  metadata: {
    timestamp: number;
    duration?: number;
    source?: string;
    traceId?: string;
    processingSteps?: ProcessingStep[];
  };
}

/**
 * Processing Step for tracking
 */
export interface ProcessingStep {
  module: string;
  step: string;
  timestamp: number;
  duration?: number;
  input?: UnknownObject;
  output?: UnknownObject;
  error?: string;
}

/**
 * Request Context
 */
export interface RequestContext {
  requestId: string;
  routeId?: string;
  chainId?: string;
  moduleId?: string;
  position?: number;
  totalModules?: number;
  connectionId?: string;
  ephemeral?: boolean; // Mark as one-time processing context
  fromModule?: string;
  toModule?: string;
}

/**
 * Module Processing Context
 */
export interface ModuleContext extends RequestContext {
  config: ModuleConfig;
  dependencies: UnknownObject;
  metrics?: UnknownObject;
}

/**
 * Validation Result
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings?: string[];
}

/**
 * Configuration Validation Error
 */
export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly configPath: string[]
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Connection Error
 */
export class V2ConnectionError extends Error {
  constructor(
    message: string,
    public readonly context: {
      connectionId: string;
      position: number;
      moduleType: string;
      moduleId: string;
      originalError: string;
      timestamp: string;
    }
  ) {
    super(message);
    this.name = 'V2ConnectionError';
  }

  toJSON(): UnknownObject {
    return {
      name: this.name,
      message: this.message,
      context: this.context,
      stack: this.stack
    };
  }
}

/**
 * Switch Options
 */
export interface SwitchOptions {
  validateCompatibility?: boolean;
  trafficShift?: {
    percentage: number;
    duration?: number;
  };
  manualRollback?: boolean;
}

/**
 * Switch Report
 */
export interface SwitchReport {
  from: string;
  to: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  steps: string[];
  success: boolean;
  error?: string;
  manualRollbackExecuted?: boolean;
}

/**
 * Pre-run Report
 */
export interface PreRunReport {
  totalRoutes: number;
  successfulRoutes: number;
  failedRoutes: Array<{
    routeId: string;
    error: string;
    recoverable: boolean;
  }>;
  warnings: string[];
}

/**
 * Warmup Report
 */
export interface WarmupReport {
  startTime: number;
  endTime?: number;
  duration?: number;
  preloadedInstances: number;
  failedInstances: Array<{
    module: string;
    error: string;
    recoverable: boolean;
  }>;
  warnings: string[];
  success: boolean;
}

/**
 * Module Connection Status
 */
export interface ConnectionStatus {
  id: string;
  instanceCount: number;
  connectionCount: number;
  allConnected: boolean;
  establishedAt?: number;
  metadata: UnknownObject;
}

/**
 * Module Metrics
 */
export interface ModuleMetrics {
  created: number;
  active: number;
  errors: number;
  lastActivity: number;
}
