/**
 * Passthrough Compatibility Implementation
 *
 * Provides a compatibility layer that simply passes through requests
 * without any transformations. Used when no format conversion is needed.
 */

import type { CompatibilityModule, ModuleConfig, ModuleDependencies } from '../../modules/pipeline/modules/provider/interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest } from '../../modules/pipeline/types/shared-dtos.js';
import type { TransformationRule } from '../../modules/pipeline/modules/provider/interfaces/pipeline-interfaces.js';
import type { PipelineDebugLogger as PipelineDebugLoggerInterface } from '../../modules/pipeline/modules/provider/interfaces/pipeline-interfaces.js';
import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';

/**
 * Passthrough Compatibility Module
 */
export class PassthroughCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'passthrough-compatibility';
  readonly config: ModuleConfig;
  readonly rules: TransformationRule[] = [];

  private isInitialized = false;
  private logger!: PipelineDebugLoggerInterface;
  private dependencies!: ModuleDependencies;

  // 支持两种构造方式：new PassthroughCompatibility(config, deps) 或 new PassthroughCompatibility(deps)
  constructor(configOrDependencies: ModuleConfig | ModuleDependencies, maybeDependencies?: ModuleDependencies) {
    const isLegacy = (arg: any): arg is ModuleConfig => !!arg && typeof arg === 'object' && 'type' in arg && 'config' in arg;
    if (isLegacy(configOrDependencies) && maybeDependencies) {
      const config = configOrDependencies as ModuleConfig;
      const dependencies = maybeDependencies as ModuleDependencies;
      this.dependencies = dependencies;
      this.logger = dependencies.logger;
      this.id = `compatibility-passthrough-${Date.now()}`;
      this.config = config;
    } else {
      const dependencies = configOrDependencies as ModuleDependencies;
      this.dependencies = dependencies;
      this.logger = dependencies.logger;
      this.id = `compatibility-passthrough-${Date.now()}`;
      this.config = { type: 'passthrough-compatibility', config: {} } as unknown as ModuleConfig;
    }
  }

  /**
   * Initialize the compatibility module
   */
  async initialize(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'initialization-start');
      
      // Validate configuration
    this.validateConfig();
      
      this.isInitialized = true;
      this.logger.logModule(this.id, 'initialization-complete');
    } catch (error) {
      this.logger.logModule(this.id, 'initialization-error', { error });
      throw error;
    }
  }

  /**
   * Process incoming request - Pass through without transformation
   */
  async processIncoming(request: SharedPipelineRequest): Promise<SharedPipelineRequest> {
    if (!this.isInitialized) {
      throw new Error('Passthrough Compatibility module is not initialized');
    }

    try {
      const isDto = this.isSharedPipelineRequest(request);
      const payload = isDto ? ((request as unknown as UnknownObject).data) : (request as unknown);
      this.logger.logModule(this.id, 'processing-request-start', { hasModel: !!(payload as any)?.model });

      // Simply return the request as-is (passthrough)
      const result = payload;

      this.logger.logModule(this.id, 'processing-request-complete', {
        transformationCount: 0
      });

      return isDto ? { ...(request as unknown as UnknownObject), data: result } as SharedPipelineRequest : ({ data: result, route: (request as any).route, metadata: (request as any).metadata, debug: (request as any).debug } as SharedPipelineRequest);

    } catch (error) {
      this.logger.logModule(this.id, 'processing-request-error', { error });
      throw error;
    }
  }

  /**
   * Process outgoing response - Pass through without transformation
   */
  async processOutgoing(response: any): Promise<unknown> {
    if (!this.isInitialized) {
      throw new Error('Passthrough Compatibility module is not initialized');
    }

    try {
      const isDto = this.isPipelineResponse(response);
      const payload = isDto ? (response as UnknownObject).data : response;
      this.logger.logModule(this.id, 'processing-response-start', { hasChoices: !!(payload as any)?.choices });

      // Minimal normalization to satisfy OpenAI Chat client schema
      const result = payload as any;
      try {
        if (result && typeof result === 'object' && Array.isArray(result.choices)) {
          if (result.object == null) {
            result.object = 'chat.completion';
          }
          if (result.id == null) {
            result.id = `chatcmpl_${Math.random().toString(36).slice(2)}`;
          }
          if (result.created == null) {
            result.created = Math.floor(Date.now() / 1000);
          }
          if (result.model == null) {
            result.model = 'unknown';
          }
        }
      } catch { /* keep passthrough semantics if anything fails */ }

      this.logger.logModule(this.id, 'processing-response-complete', {
        transformationCount: 0
      });

      return isDto ? { ...(response as UnknownObject), data: result } : result;

    } catch (error) {
      this.logger.logModule(this.id, 'processing-response-error', { error });
      throw error;
    }
  }

  /**
   * Apply compatibility transformations
   */
  async applyTransformations(data: any, rules: TransformationRule[]): Promise<unknown> {
    if (!this.isInitialized) {
      throw new Error('Passthrough Compatibility module is not initialized');
    }

    // For passthrough, we don't apply any transformations
    this.logger.logModule(this.id, 'apply-transformations', { 
      ruleCount: rules.length,
      transformationCount: 0 
    });
    
    return data;
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'cleanup-start');
      
      this.isInitialized = false;
      
      this.logger.logModule(this.id, 'cleanup-complete');
    } catch (error) {
      this.logger.logModule(this.id, 'cleanup-error', { error });
      throw error;
    }
  }

  /**
   * Validate module configuration
   */
  private validateConfig(): void {
    const declared = this.config.config;
    const allowed = ['enabled', 'priority'];
    
    for (const key of Object.keys(declared || {})) {
      if (!allowed.includes(key)) {
        this.logger.logModule(this.id, 'config-warning', {
          message: `Unknown configuration property: ${key}`,
          allowedProperties: allowed,
          declaredProperties: Object.keys(declared || {})
        });
      }
    }
  }

  /**
   * Check if object is a SharedPipelineRequest
   */
  private isSharedPipelineRequest(obj: any): obj is SharedPipelineRequest {
    return typeof obj === 'object' && obj !== null && 'data' in obj && 'route' in obj && 'metadata' in obj;
  }

  /**
   * Check if object is a PipelineResponse
   */
  private isPipelineResponse(obj: any): obj is UnknownObject {
    return typeof obj === 'object' && obj !== null && 'data' in obj;
  }

  /**
   * Get module status
   */
  getStatus(): {
    id: string;
    type: string;
    initialized: boolean;
    ruleCount: number;
  } {
    return {
      id: this.id,
      type: this.type,
      initialized: this.isInitialized,
      ruleCount: this.rules.length
    };
  }
}
