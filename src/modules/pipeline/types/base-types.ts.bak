/**
 * Pipeline Module - Base Type Definitions
 *
 * Base type definitions to avoid circular dependencies between modules.
 */

/**
 * Base provider configuration interface
 */
export interface BaseProviderConfig {
  /** Provider identifier */
  id: string;
  /** Provider type */
  type: string;
  /** Base URL */
  baseUrl: string;
  /** Authentication configuration */
  auth: any;
  /** Model configurations */
  models?: Record<string, any>;
  /** Compatibility configuration */
  compatibility?: any;
}

/**
 * Base transformation rule interface
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