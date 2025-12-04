/**
 * Field Mapping Compatibility Implementation
 *
 * Provides JSON-based field mapping and transformation capabilities.
 * Supports various transformation types including mapping, renaming, extraction,
 * combination, and conditional transformations.
 */

import type {
  CompatibilityModule,
  ModuleConfig,
  ModuleDependencies,
  PipelineDebugLogger,
  TransformationRule
} from '../../modules/pipeline/interfaces/pipeline-interfaces.js';
import { TransformationEngine } from '../core/utils/transformation-engine.js';
import type { SharedPipelineRequest, SharedPipelineResponse } from '../../modules/pipeline/types/shared-dtos.js';
import type { LogData } from '../../types/common-types.js';

interface FieldMappingModuleSettings {
  rules?: TransformationRule[];
  responseMappings?: ResponseMappingRule[];
  enableValidation?: boolean;
  continueOnError?: boolean;
  maxTransformations?: number;
}

interface ResponseMappingRule {
  id?: string;
  transform?: TransformationRule['transform'];
  sourcePath?: string;
  targetPath?: string;
  mapping?: TransformationRule['mapping'];
  defaultValue?: unknown;
  condition?: TransformationRule['condition'];
  removeSource?: boolean;
}

interface TransformationContextPayload {
  pipelineContext: {
    pipelineId: string;
    requestId: string;
    timestamp: number;
  };
  metadata: {
    ruleId: string;
    ruleType: string;
    attempt: number;
  };
  state: Record<string, unknown>;
  logger: (message: string, level?: 'info' | 'warn' | 'error' | 'debug') => void;
}

const DEFAULT_ROUTE = {
  providerId: 'unknown',
  modelId: 'unknown',
  requestId: 'unknown'
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSharedPipelineRequest(value: unknown): value is SharedPipelineRequest {
  return isRecord(value) && 'data' in value && 'route' in value && 'metadata' in value && 'debug' in value;
}

function isSharedPipelineResponse(value: unknown): value is SharedPipelineResponse<unknown> {
  return isRecord(value) && 'data' in value && 'metadata' in value;
}

function toLogData(value: unknown): LogData | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value as LogData;
  }
  if (isRecord(value)) {
    return value as LogData;
  }
  return undefined;
}

function createAnonymousRequest(data: unknown): SharedPipelineRequest {
  return {
    data,
    route: {
      ...DEFAULT_ROUTE,
      timestamp: Date.now()
    },
    metadata: {},
    debug: {
      enabled: false,
      stages: {}
    }
  };
}

function createAnonymousResponse(data: unknown): SharedPipelineResponse<unknown> {
  return {
    data,
    metadata: {
      pipelineId: 'field-mapping',
      processingTime: 0,
      stages: [],
      requestId: DEFAULT_ROUTE.requestId
    }
  };
}

/**
 * Field Mapping Compatibility Module
 */
export class FieldMappingCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'field-mapping';
  readonly rules: TransformationRule[];
  readonly config: ModuleConfig;

  private isInitialized = false;
  private readonly transformationEngine: TransformationEngine;
  private readonly logger: PipelineDebugLogger;

  constructor(config: ModuleConfig, dependencies: ModuleDependencies) {
    this.logger = dependencies.logger;
    this.id = `compatibility-${Date.now()}`;
    this.config = config;
    const settings = this.settings;
    this.rules = Array.isArray(settings.rules) ? [...settings.rules] : [];
    this.transformationEngine = new TransformationEngine();
  }

  /**
   * Initialize the module
   */
  async initialize(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'initializing', {
        config: this.config,
        ruleCount: this.rules.length
      });

      this.validateConfig();
      this.validateRules();

      await this.transformationEngine.initialize({
        maxDepth: 10,
        maxTimeMs: 5000,
        enableCache: true,
        cacheSize: 1000
      });

      this.isInitialized = true;
      this.logger.logModule(this.id, 'initialized', {
        rulesValidated: true,
        engineInitialized: true
      });

    } catch (error) {
      this.logger.logModule(this.id, 'initialization-error', { error });
      throw error;
    }
  }

  /**
   * Process incoming request - Apply field transformations
   */
  async processIncoming(requestParam: SharedPipelineRequest | Record<string, unknown>): Promise<SharedPipelineRequest> {
    if (!this.isInitialized) {
      throw new Error('Field Mapping Compatibility is not initialized');
    }

    try {
      const dto = this.normalizeRequestEnvelope(requestParam);

      if (this.rules.length === 0) {
        this.logger.logModule(this.id, 'no-request-transformations', {
          ruleCount: this.rules.length
        });
        return dto;
      }

      const transformedRequest = await this.applyTransformations(dto.data, this.rules, dto.route.requestId);
      this.logger.logTransformation(
        dto.route.requestId,
        'request-field-mapping',
        toLogData(dto.data),
        toLogData(transformedRequest)
      );

      return { ...dto, data: transformedRequest };

    } catch (error) {
      this.logger.logModule(this.id, 'request-transform-error', { error });
      throw error;
    }
  }

  /**
   * Process outgoing response - Apply response transformations
   */
  async processOutgoing(response: SharedPipelineResponse<unknown>): Promise<SharedPipelineResponse<unknown>>;
  async processOutgoing(
    response: SharedPipelineResponse<unknown> | Record<string, unknown>
  ): Promise<SharedPipelineResponse<unknown>>;
  async processOutgoing(
    response: SharedPipelineResponse<unknown> | Record<string, unknown>
  ): Promise<SharedPipelineResponse<unknown>> {
    if (!this.isInitialized) {
      throw new Error('Field Mapping Compatibility is not initialized');
    }

    try {
      const { dto, payload } = this.unwrapResponseEnvelope(response);
      const responseRules = this.getResponseRules();

      if (responseRules.length === 0) {
        this.logger.logModule(this.id, 'no-response-transformations', {
          ruleCount: responseRules.length
        });
        return dto ?? createAnonymousResponse(payload);
      }

      const transformedPayload = await this.applyTransformations(payload, responseRules, dto?.metadata.requestId);
      this.logger.logTransformation(
        dto?.metadata.requestId || 'unknown',
        'response-field-mapping',
        toLogData(payload),
        toLogData(transformedPayload)
      );

      return dto ? { ...dto, data: transformedPayload } : createAnonymousResponse(transformedPayload);

    } catch (error) {
      this.logger.logModule(this.id, 'response-transform-error', { error, response });
      throw error;
    }
  }

  /**
   * Apply compatibility transformations
   */
  async applyTransformations<T>(data: T, rules: TransformationRule[], requestId?: string): Promise<T> {
    try {
      const context = this.createTransformationContext(requestId);
      const result = await this.transformationEngine.transform<T>(data, rules, context);
      return result.data;
    } catch (error) {
      return this.handleTransformationError(error, data, rules);
    }
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'cleanup-start');
      this.isInitialized = false;
      await this.transformationEngine.cleanup();
      this.logger.logModule(this.id, 'cleanup-complete');

    } catch (error) {
      this.logger.logModule(this.id, 'cleanup-error', { error });
      throw error;
    }
  }

  /**
   * Get module status
   */
  getStatus(): {
    id: string;
    type: string;
    isInitialized: boolean;
    ruleCount: number;
    lastActivity: number;
    engineStatus: LogData;
  } {
    return {
      id: this.id,
      type: this.type,
      isInitialized: this.isInitialized,
      ruleCount: this.rules.length,
      lastActivity: Date.now(),
      engineStatus: this.transformationEngine.getStatus()
    };
  }

  /**
   * Get transformation statistics
   */
  async getTransformationStats(): Promise<LogData> {
    return this.transformationEngine.getStatistics();
  }

  /**
   * Add transformation rule dynamically
   */
  addRule(rule: TransformationRule): void {
    this.rules.push(rule);
    this.logger.logModule(this.id, 'rule-added', { rule });
  }

  /**
   * Remove transformation rule
   */
  removeRule(ruleId: string): boolean {
    const index = this.rules.findIndex(rule => rule.id === ruleId);
    if (index >= 0) {
      const removed = this.rules.splice(index, 1)[0];
      this.logger.logModule(this.id, 'rule-removed', { rule: removed });
      return true;
    }
    return false;
  }

  /**
   * Validate module configuration
   */
  private validateConfig(): void {
    if (!this.config.type || this.config.type !== 'field-mapping') {
      throw new Error('Invalid Compatibility type configuration');
    }

    if (!this.config.config) {
      this.config.config = {};
    }

    const config = this.settings;
    config.enableValidation = config.enableValidation ?? true;
    config.continueOnError = config.continueOnError ?? false;
    config.maxTransformations = config.maxTransformations ?? 100;

    this.logger.logModule(this.id, 'config-validation-success', {
      type: this.config.type,
      enableValidation: config.enableValidation,
      continueOnError: config.continueOnError,
      maxTransformations: config.maxTransformations
    });
  }

  /**
   * Validate transformation rules
   */
  private validateRules(): void {
    const errors: string[] = [];

    this.rules.forEach((rule, index) => {
      try {
        this.validateTransformationRule(rule);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push(`Rule ${index} (${rule.id}): ${errorMessage}`);
      }
    });

    if (errors.length > 0) {
      throw new Error(`Transformation rule validation failed:\n${errors.join('\n')}`);
    }

    this.logger.logModule(this.id, 'rules-validation-success', {
      ruleCount: this.rules.length,
      errors: errors.length
    });
  }

  /**
   * Validate individual transformation rule
   */
  private validateTransformationRule(rule: TransformationRule): void {
    if (!rule.id) {
      throw new Error('Rule ID is required');
    }

    if (!rule.transform) {
      throw new Error('Rule transform type is required');
    }

    switch (rule.transform) {
      case 'mapping':
        if (!rule.sourcePath) {
          throw new Error('Mapping transformation requires source path');
        }
        if (!rule.targetPath) {
          throw new Error('Mapping transformation requires target path');
        }
        if (!rule.mapping) {
          throw new Error('Mapping transformation requires mapping configuration');
        }
        break;

      case 'conditional':
        if (!rule.condition) {
          throw new Error('Conditional transformation requires condition configuration');
        }
        break;

      case 'combine':
        if (!rule.sourcePaths || !Array.isArray(rule.sourcePaths)) {
          throw new Error('Combine transformation requires sourcePaths array');
        }
        if (!rule.targetPath) {
          throw new Error('Combine transformation requires target path');
        }
        break;

      case 'structure':
        if (!rule.structure) {
          throw new Error('Structure transformation requires structure configuration');
        }
        break;

      default:
        if (!rule.sourcePath) {
          throw new Error(`${rule.transform} transformation requires source path`);
        }
        if (!rule.targetPath) {
          throw new Error(`${rule.transform} transformation requires target path`);
        }
        break;
    }
  }

  /**
   * Get response transformation rules
   */
  private getResponseRules(): TransformationRule[] {
    const responseMappings = Array.isArray(this.settings.responseMappings)
      ? this.settings.responseMappings
      : [];

    return responseMappings.map((mapping, index) => ({
      id: mapping.id || `response-${Date.now()}-${index}`,
      transform: mapping.transform || 'mapping',
      sourcePath: mapping.sourcePath,
      targetPath: mapping.targetPath,
      mapping: mapping.mapping,
      defaultValue: mapping.defaultValue,
      condition: mapping.condition,
      removeSource: mapping.removeSource ?? false
    })) as TransformationRule[];
  }

  /**
   * Create default transformation rules
   */
  private createDefaultRules(): TransformationRule[] {
    return [
      {
        id: 'model-mapping',
        transform: 'mapping',
        sourcePath: 'model',
        targetPath: 'model',
        mapping: {
          'gpt-4': 'qwen3-coder-plus',
          'gpt-3.5-turbo': 'qwen-turbo'
        }
      },
      {
        id: 'max-tokens-mapping',
        transform: 'mapping',
        sourcePath: 'max_tokens',
        targetPath: 'max_tokens',
        mapping: {
          '4096': 8192,
          '8192': 16384,
          '16384': 32768
        }
      }
    ];
  }

  /**
   * Extract transformation metadata for debugging
   */
  private extractTransformationMetadata(data: unknown): Record<string, unknown> {
    let size = 0;
    try {
      size = JSON.stringify(data).length;
    } catch {
      size = 0;
    }

    return {
      dataType: typeof data,
      isArray: Array.isArray(data),
      isObject: isRecord(data) && !Array.isArray(data),
      keys: isRecord(data) ? Object.keys(data) : [],
      size,
      timestamp: Date.now()
    };
  }

  /**
   * Handle transformation errors gracefully
   */
  private async handleTransformationError<T>(error: unknown, data: T, rules: TransformationRule[]): Promise<T> {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    const errorInfo = {
      error: errorMessage,
      stack: errorStack,
      dataType: typeof data,
      ruleCount: rules.length,
      timestamp: Date.now()
    };

    this.logger.logModule(this.id, 'transformation-error', errorInfo);

    if (this.settings.continueOnError) {
      this.logger.logModule(this.id, 'transformation-error-continue', {
        message: 'Returning original data due to continueOnError flag'
      });
      return data;
    }

    throw error;
  }

  /**
   * Create transformation context
   */
  private createTransformationContext(requestId?: string): TransformationContextPayload {
    const id = requestId || 'unknown';
    return {
      pipelineContext: {
        pipelineId: this.id,
        requestId: id,
        timestamp: Date.now()
      },
      metadata: {
        ruleId: 'field-mapping',
        ruleType: 'compatibility',
        attempt: 1
      },
      state: {},
      logger: (message: string, level: 'info' | 'warn' | 'error' | 'debug' = 'info') => {
        this.logger.logModule(this.id, `transformation-${level}`, {
          message,
          requestId: id
        });
      }
    };
  }

  private normalizeRequestEnvelope(input: SharedPipelineRequest | Record<string, unknown>): SharedPipelineRequest {
    if (isSharedPipelineRequest(input)) {
      return input;
    }
    return createAnonymousRequest(input);
  }

  private unwrapResponseEnvelope(
    response: SharedPipelineResponse<unknown> | Record<string, unknown>
  ): {
    dto?: SharedPipelineResponse<unknown>;
    payload: unknown;
  } {
    if (isSharedPipelineResponse(response)) {
      return { dto: response, payload: response.data };
    }
    return { payload: response };
  }

  private get settings(): FieldMappingModuleSettings {
    if (!this.config.config) {
      this.config.config = {};
    }
    return this.config.config as FieldMappingModuleSettings;
  }
}
