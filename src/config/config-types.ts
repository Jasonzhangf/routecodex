/**
 * RouteCodex Configuration Types
 * Complete type definitions for the RouteCodex proxy server
 */

// Zod schema type placeholder

// Base configuration types
export interface BaseConfig {
  version: string;
  environment: 'development' | 'production' | 'test';
  debug: boolean;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
}

// Server configuration
export interface ServerConfig {
  host: string;
  port: number;
  cors: {
    enabled: boolean;
    origin: string | string[];
    credentials: boolean;
    methods: string[];
    allowedHeaders: string[];
  };
  rateLimit: {
    enabled: boolean;
    windowMs: number;
    max: number;
    skipSuccessfulRequests: boolean;
    skipFailedRequests: boolean;
  };
  compression: {
    enabled: boolean;
    threshold: number;
  };
  timeout: {
    request: number;
    response: number;
    keepAlive: number;
  };
}

// Provider configuration
export interface ProviderConfig {
  id: string;
  type: 'openai' | 'anthropic' | 'custom' | 'pass-through';
  enabled: boolean;
  baseUrl?: string;
  apiKey?: string;
  timeout: number;
  maxRetries: number;
  retryDelay: number;
  models: Record<string, ModelConfig>;
  headers?: Record<string, string>;
  healthCheck: {
    enabled: boolean;
    interval: number;
    endpoint?: string;
    timeout: number;
  };
}

export interface ModelConfig {
  maxTokens: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: string[];
  supportsStreaming: boolean;
  supportsFunctions: boolean;
  supportsVision: boolean;
  cost?: {
    input: number;
    output: number;
    currency: string;
  };
}

// Pass-through provider specific configuration
export interface PassThroughConfig {
  targetUrl: string;
  authentication?: {
    type: 'bearer' | 'basic' | 'custom';
    token?: string;
    username?: string;
    password?: string;
    headers?: Record<string, string>;
  };
  requestTransform?: {
    enabled: boolean;
    rules: Array<{
      path: string;
      operation: 'add' | 'remove' | 'replace';
      value: unknown;
    }>;
  };
  responseTransform?: {
    enabled: boolean;
    rules: Array<{
      path: string;
      operation: 'add' | 'remove' | 'replace';
      value: unknown;
    }>;
  };
}

// Routing configuration
export interface RoutingConfig {
  strategy: 'round-robin' | 'load-based' | 'priority' | 'custom';
  defaultProvider?: string;
  fallbackProvider?: string;
  rules: Array<{
    pattern: string;
    provider: string;
    priority: number;
    conditions?: Array<{
      field: string;
      operator: 'equals' | 'contains' | 'starts_with' | 'ends_with' | 'regex';
      value: string;
    }>;
  }>;
  loadBalancing: {
    enabled: boolean;
    algorithm: 'round-robin' | 'least-connections' | 'weighted';
    weights: Record<string, number>;
    healthCheck: {
      enabled: boolean;
      interval: number;
      timeout: number;
      unhealthyThreshold: number;
      healthyThreshold: number;
    };
  };
}

// Dynamic routing configuration
export interface DynamicRoutingConfig {
  enabled: boolean;
  categories: {
    default: {
      targets: Array<{
        providerId: string;
        modelId: string;
        priority: number;
      }>;
    };
    longcontext: {
      enabled: boolean;
      targets: Array<{
        providerId: string;
        modelId: string;
        priority: number;
      }>;
    };
    thinking: {
      enabled: boolean;
      targets: Array<{
        providerId: string;
        modelId: string;
        priority: number;
      }>;
    };
    background: {
      enabled: boolean;
      targets: Array<{
        providerId: string;
        modelId: string;
        priority: number;
      }>;
    };
    websearch: {
      enabled: boolean;
      targets: Array<{
        providerId: string;
        modelId: string;
        priority: number;
      }>;
    };
    vision: {
      enabled: boolean;
      targets: Array<{
        providerId: string;
        modelId: string;
        priority: number;
      }>;
    };
    coding: {
      enabled: boolean;
      targets: Array<{
        providerId: string;
        modelId: string;
        priority: number;
      }>;
    };
  };
}

// Security configuration
export interface SecurityConfig {
  authentication: {
    enabled: boolean;
    type: 'api-key' | 'jwt' | 'oauth' | 'custom';
    apiKey?: string;
    jwt?: {
      secret: string;
      expiresIn: string;
      issuer: string;
      audience: string;
    };
    oauth?: {
      clientId: string;
      clientSecret: string;
      authUrl: string;
      tokenUrl: string;
      scopes: string[];
    };
  };
  authorization: {
    enabled: boolean;
    type: 'rbac' | 'acl' | 'custom';
    rules: Array<{
      resource: string;
      action: string;
      effect: 'allow' | 'deny';
      conditions?: Record<string, unknown>;
    }>;
  };
  encryption: {
    enabled: boolean;
    algorithm: string;
    keyRotationDays: number;
  };
  rateLimit: {
    enabled: boolean;
    requests: number;
    windowMs: number;
    skipSuccessfulRequests: boolean;
    skipFailedRequests: boolean;
  };
  cors: {
    enabled: boolean;
    origin: string | string[];
    credentials: boolean;
    methods: string[];
    allowedHeaders: string[];
    exposedHeaders: string[];
    maxAge: number;
  };
}

// Monitoring and logging configuration
export interface MonitoringConfig {
  enabled: boolean;
  metrics: {
    enabled: boolean;
    endpoint: string;
    interval: number;
  };
  logging: {
    level: 'error' | 'warn' | 'info' | 'debug';
    format: 'json' | 'text';
    outputs: Array<{
      type: 'console' | 'file' | 'remote';
      config: Record<string, unknown>;
    }>;
  };
  tracing: {
    enabled: boolean;
    sampler: number;
    exporter: string;
  };
  health: {
    enabled: boolean;
    endpoint: string;
    detailed: boolean;
  };
}

// Cache configuration
export interface CacheConfig {
  enabled: boolean;
  type: 'memory' | 'redis' | 'file';
  ttl: number;
  maxSize: number;
  compression: boolean;
  redis?: {
    host: string;
    port: number;
    password?: string;
    db: number;
  };
  file?: {
    path: string;
    maxSize: number;
  };
}

// Main configuration interface
export interface RouteCodexConfig extends BaseConfig {
  server: ServerConfig;
  providers: Record<string, ProviderConfig>;
  routing: RoutingConfig;
  dynamicRouting: DynamicRoutingConfig;
  security: SecurityConfig;
  monitoring: MonitoringConfig;
  cache: CacheConfig;
  modules: {
    [key: string]: {
      enabled: boolean;
      config: Record<string, unknown>;
    };
  };
}

// Configuration validation schema
export interface ConfigValidationSchema {
  schema: unknown; // ZodSchema placeholder
  validators: Array<{
    name: string;
    validate: (config: RouteCodexConfig) => boolean | Promise<boolean>;
    message: string;
  }>;
}

// Configuration manager interface
export interface ConfigManager {
  config: RouteCodexConfig;
  load(path?: string): Promise<RouteCodexConfig>;
  save(path?: string): Promise<void>;
  validate(config: RouteCodexConfig): Promise<boolean>;
  update(updates: Partial<RouteCodexConfig>): Promise<void>;
  watch(callback: (config: RouteCodexConfig) => void): () => void;
  get<K extends keyof RouteCodexConfig>(key: K): RouteCodexConfig[K];
  set<K extends keyof RouteCodexConfig>(key: K, value: RouteCodexConfig[K]): void;
  reset(): void;
  registerProvider(provider: ConfigProvider): void;
}

// Configuration events
export interface ConfigEvents {
  loaded: (config: RouteCodexConfig) => void;
  updated: (config: RouteCodexConfig, changes: Partial<RouteCodexConfig>) => void;
  validated: (config: RouteCodexConfig, isValid: boolean, errors: string[]) => void;
  error: (error: Error, context: string) => void;
}

// Configuration provider interface
export interface ConfigProvider {
  name: string;
  priority: number;
  canHandle(path: string): boolean;
  load(path: string): Promise<RouteCodexConfig>;
  save(path: string, config: RouteCodexConfig): Promise<void>;
}

// Environment-specific configuration
export interface EnvironmentConfig {
  overrides: {
    development?: Partial<RouteCodexConfig>;
    production?: Partial<RouteCodexConfig>;
    test?: Partial<RouteCodexConfig>;
  };
  variables: {
    [key: string]: {
      type: 'string' | 'number' | 'boolean';
      required: boolean;
      default?: unknown;
      description: string;
    };
  };
}

// Configuration presets
export interface ConfigPreset {
  name: string;
  description: string;
  config: Partial<RouteCodexConfig>;
  tags: string[];
}

// Configuration migration
export interface ConfigMigration {
  version: string;
  description: string;
  migrate: (config: unknown) => Promise<RouteCodexConfig>;
}

// Configuration utilities
export interface ConfigUtils {
  merge(base: RouteCodexConfig, override: Partial<RouteCodexConfig>): RouteCodexConfig;
  clone(config: RouteCodexConfig): RouteCodexConfig;
  sanitize(config: RouteCodexConfig): RouteCodexConfig;
  expandEnvVars(config: RouteCodexConfig): RouteCodexConfig;
  validateSchema(config: RouteCodexConfig): { valid: boolean; errors: string[] };
}
