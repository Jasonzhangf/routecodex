/**
 * Transformation Module - Type Definitions
 *
 * Type definitions for transformation rules, engines, and related functionality.
 */

import type { TransformationLog } from '../interfaces/pipeline-interfaces.js';
import type { TransformationRule as TransformationRuleInterface } from '../interfaces/pipeline-interfaces.js';

/**
 * Base transformation rule interface (local copy to avoid circular dependency)
 */
export interface BaseTransformationRule {
  /** Rule identifier */
  readonly id: string;
  /** Transformation type */
  readonly transform: 'mapping' | 'rename' | 'extract' | 'combine' | 'conditional' | 'custom' | 'structure';
  /** Source path (JSON path) */
  readonly sourcePath?: string;
  /** Target path (JSON path) */
  readonly targetPath?: string;
  /** Mapping configuration */
  readonly mapping?: Record<string, any>;
  /** Default value */
  readonly defaultValue?: any;
  /** Condition for transformation */
  readonly condition?: {
    field: string;
    operator: 'equals' | 'contains' | 'exists' | 'gt' | 'lt' | 'regex';
    value: any;
  };
  /** Whether to remove source after transformation */
  readonly removeSource?: boolean;
  /** Structure configuration for structure transformations */
  readonly structure?: Record<string, any>;
  /** Source paths for combine transformations */
  readonly sourcePaths?: string[];
  /** Combiner configuration for combine transformations */
  readonly combiner?: string;
  /** Separator for combine transformations */
  readonly separator?: string;
  /** Preserve unknown fields for structure transformations */
  readonly preserveUnknown?: boolean;
  /** Strict validation for structure transformations */
  readonly strict?: boolean;
}

/**
 * Transformation rule interface (export for compatibility)
 */
export type TransformationRule = TransformationRuleInterface;

/**
 * JSON path expression type
 */
export type JSONPath = string;

/**
 * Transformation operation type
 */
export type TransformationOperation =
  | 'set'
  | 'delete'
  | 'move'
  | 'copy'
  | 'rename'
  | 'extract'
  | 'combine'
  | 'split'
  | 'transform'
  | 'validate';

/**
 * Transformation function type
 */
export type TransformationFunction = (value: any, context: TransformationContext) => Promise<any>;

/**
 * Transformation condition type
 */
export type TransformationCondition = (data: any, context: TransformationContext) => Promise<boolean>;

/**
 * Transformation mapping type
 */
export type TransformationMapping = Record<string, any> | Map<string, any>;

/**
 * Transformation rule variants
 */
export type TransformationRuleVariant =
  | MappingTransformationRule
  | RenameTransformationRule
  | ExtractTransformationRule
  | CombineTransformationRule
  | ConditionalTransformationRule
  | StructureTransformationRule
  | CustomTransformationRule;

/**
 * Mapping transformation rule
 */
export interface MappingTransformationRule extends TransformationRule {
  transform: 'mapping';
  mapping: Record<string, any>;
  sourcePath: JSONPath;
  targetPath: JSONPath;
  defaultValue?: any;
}

/**
 * Rename transformation rule
 */
export interface RenameTransformationRule extends TransformationRule {
  transform: 'rename';
  sourcePath: JSONPath;
  targetPath: JSONPath;
  removeSource?: boolean;
}

/**
 * Extract transformation rule
 */
export interface ExtractTransformationRule extends TransformationRule {
  transform: 'extract';
  sourcePath: JSONPath;
  targetPath: JSONPath;
  extractor: 'regex' | 'jsonpath' | 'custom';
  pattern?: string;
}

/**
 * Combine transformation rule
 */
export interface CombineTransformationRule extends TransformationRule {
  transform: 'combine';
  sourcePaths: JSONPath[];
  targetPath: JSONPath;
  combiner: 'concat' | 'merge' | 'custom';
  separator?: string;
}

/**
 * Conditional transformation rule
 */
export interface ConditionalTransformationRule extends TransformationRule {
  transform: 'conditional';
  condition: {
    field: JSONPath;
    operator: 'equals' | 'contains' | 'exists' | 'gt' | 'lt' | 'regex';
    value: any;
  };
  thenRule: TransformationRuleVariant;
  elseRule?: TransformationRuleVariant;
}

/**
 * Custom transformation rule
 */
export interface CustomTransformationRule extends TransformationRule {
  transform: 'custom';
  customFunction: TransformationFunction;
  context?: Record<string, any>;
}

/**
 * Structure transformation rule
 */
export interface StructureTransformationRule extends TransformationRule {
  transform: 'structure';
  structure: Record<string, any>;
  preserveUnknown?: boolean;
  strict?: boolean;
}

/**
 * Transformation context interface
 */
export interface TransformationContext {
  /** Pipeline context */
  pipelineContext: {
    pipelineId: string;
    requestId: string;
    timestamp: number;
  };
  /** Transformation metadata */
  metadata: {
    ruleId: string;
    ruleType: string;
    attempt: number;
  };
  /** Shared state */
  state: Record<string, any>;
  /** Logger function */
  logger: (message: string, level?: 'info' | 'warn' | 'error') => void;
}

/**
 * Transformation engine configuration
 */
export interface TransformationEngineConfig {
  /** Maximum transformation depth */
  maxDepth?: number;
  /** Maximum transformation time */
  maxTimeMs?: number;
  /** Enable transformation caching */
  enableCache?: boolean;
  /** Cache size */
  cacheSize?: number;
  /** Custom transformation functions */
  customFunctions?: Record<string, TransformationFunction>;
  /** Validation rules */
  validationRules?: TransformationValidationRule[];
}

/**
 * Transformation validation rule
 */
export interface TransformationValidationRule {
  /** Rule identifier */
  id: string;
  /** Rule type */
  type: 'required' | 'type' | 'format' | 'custom';
  /** Target path */
  targetPath: JSONPath;
  /** Validation parameters */
  parameters: Record<string, any>;
  /** Error message */
  errorMessage: string;
}

/**
 * Transformation result interface
 */
export interface TransformationResult {
  /** Transformed data */
  data: any;
  /** Transformation logs */
  logs: TransformationLog[];
  /** Validation results */
  validations: ValidationResult[];
  /** Performance metrics */
  metrics: {
    totalTransformations: number;
    totalTime: number;
    averageTime: number;
    cacheHits: number;
    cacheMisses: number;
  };
  tools?: any[];
}

/**
 * Validation result interface
 */
export interface ValidationResult {
  /** Rule identifier */
  ruleId: string;
  /** Whether validation passed */
  isValid: boolean;
  /** Error message */
  errorMessage?: string;
  /** Validation context */
  context: Record<string, any>;
}

/**
 * Transformation batch interface
 */
export interface TransformationBatch {
  /** Batch identifier */
  id: string;
  /** Items to transform */
  items: TransformationItem[];
  /** Transformation rules */
  rules: TransformationRuleVariant[];
  /** Batch configuration */
  config?: {
    parallel?: boolean;
    continueOnError?: boolean;
    maxConcurrency?: number;
  };
}

/**
 * Transformation item interface
 */
export interface TransformationItem {
  /** Item identifier */
  id: string;
  /** Item data */
  data: any;
  /** Item metadata */
  metadata?: Record<string, any>;
}

/**
 * Transformation batch result interface
 */
export interface TransformationBatchResult {
  /** Batch identifier */
  batchId: string;
  /** Item results */
  results: TransformationItemResult[];
  /** Batch metrics */
  metrics: {
    totalItems: number;
    successfulItems: number;
    failedItems: number;
    totalTime: number;
    averageTime: number;
  };
}

/**
 * Transformation item result interface
 */
export interface TransformationItemResult {
  /** Item identifier */
  itemId: string;
  /** Whether transformation was successful */
  success: boolean;
  /** Transformed data */
  data?: any;
  /** Error message */
  error?: string;
  /** Transformation logs */
  logs: TransformationLog[];
  /** Processing time */
  processingTime: number;
}

/**
 * Transformation cache interface
 */
export interface TransformationCache {
  /**
   * Get cached transformation result
   */
  get(key: string): Promise<TransformationResult | null>;

  /**
   * Set transformation result in cache
   */
  set(key: string, result: TransformationResult, ttl?: number): Promise<void>;

  /**
   * Clear cache
   */
  clear(): Promise<void>;

  /**
   * Get cache statistics
   */
  getStats(): Promise<{
    size: number;
    hits: number;
    misses: number;
    hitRate: number;
  }>;
}

/**
 * Transformation performance metrics
 */
export interface TransformationMetrics {
  /** Total transformations performed */
  totalTransformations: number;
  /** Successful transformations */
  successfulTransformations: number;
  /** Failed transformations */
  failedTransformations: number;
  /** Average transformation time */
  averageTime: number;
  /** P95 transformation time */
  p95Time: number;
  /** P99 transformation time */
  p99Time: number;
  /** Cache statistics */
  cache: {
    hits: number;
    misses: number;
    hitRate: number;
  };
  /** Memory usage */
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
}

/**
 * Transformation statistics interface
 */
export interface TransformationStatistics {
  //** Rule usage statistics */
  ruleUsage: Record<string, {
    count: number;
    successRate: number;
    averageTime: number;
  }>;
  /** Path usage statistics */
  pathUsage: Record<string, {
    readCount: number;
    writeCount: number;
    averageTime: number;
  }>;
  /** Error statistics */
  errors: {
    total: number;
    byType: Record<string, number>;
    byRule: Record<string, number>;
  };
  /** Performance metrics */
  performance: TransformationMetrics;
}

/**
 * Transformation schema interface
 */
export interface TransformationSchema {
  /** Schema identifier */
  id: string;
  /** Schema version */
  version: string;
  /** Schema definition */
  definition: {
    type: 'object' | 'array' | 'string' | 'number' | 'boolean';
    properties?: Record<string, TransformationSchema>;
    items?: TransformationSchema;
    required?: string[];
    additionalProperties?: boolean | TransformationSchema;
  };
  /** Transformation rules */
  transformations: TransformationRuleVariant[];
  /** Validation rules */
  validations: TransformationValidationRule[];
}

/**
 * Transformation engine interface
 */
export interface TransformationEngine {
  /**
   * Apply transformation rules to data
   */
  transform(data: any, rules: TransformationRuleVariant[], context?: Partial<TransformationContext>): Promise<TransformationResult>;

  /**
   * Validate data against schema
   */
  validate(data: any, schema: TransformationSchema): Promise<ValidationResult[]>;

  /**
   * Process transformation batch
   */
  processBatch(batch: TransformationBatch): Promise<TransformationBatchResult>;

  /**
   * Get transformation statistics
   */
  getStatistics(): Promise<TransformationStatistics>;

  /**
   * Clear cache and reset statistics
   */
  reset(): Promise<void>;
}