/**
 * LM Studio Compatibility Implementation
 *
 * Provides LM Studio-specific compatibility transformations including
 * Tools API conversion, request/response format adaptation, and
 * field mapping based on JSON configuration.
 */

import type { CompatibilityModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest } from '../../../../types/shared-dtos.js';
import type { TransformationRule } from '../../interfaces/pipeline-interfaces.js';
import type { PipelineDebugLogger as PipelineDebugLoggerInterface } from '../../interfaces/pipeline-interfaces.js';
import type { UnknownObject, LogData } from '../../../../types/common-types.js';

/**
 * LM Studio Compatibility Module
 */
export class LMStudioCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'lmstudio-compatibility';
  readonly config: ModuleConfig;
  readonly rules: TransformationRule[];

  private isInitialized = false;
  private logger: PipelineDebugLoggerInterface;
  private transformationEngine: any; // TransformationEngine instance

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.logger = dependencies.logger;
    this.id = `compatibility-${Date.now()}`;
    this.config = config;
    this.rules = this.initializeTransformationRules();
  }

  /**
   * Initialize the compatibility module
   */
  async initialize(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'initializing', {
        config: this.config
      });

      // Initialize transformation engine
      const { TransformationEngine } = await import('../../utils/transformation-engine.js');
      this.transformationEngine = new TransformationEngine();

      // Validate configuration
      this.validateConfig();

      this.isInitialized = true;
      this.logger.logModule(this.id, 'initialized');

    } catch (error) {
      this.logger.logModule(this.id, 'initialization-error', { error });
      throw error;
    }
  }

  /**
   * Process incoming request - Apply compatibility transformations
   */
  async processIncoming(requestParam: any): Promise<SharedPipelineRequest> {
    if (!this.isInitialized) {
      throw new Error('LM Studio Compatibility module is not initialized');
    }

    try {
      const isDto = this.isSharedPipelineRequest(requestParam);
      const dto = isDto ? requestParam as SharedPipelineRequest : null;
      const request = isDto ? (dto!.data as unknown) : requestParam;

      const requestObj = request as UnknownObject;
      this.logger.logModule(this.id, 'processing-request-start', { hasTools: !!requestObj?.tools, model: requestObj?.model });

      // Apply transformation rules to request
      const transformedResult = await this.applyTransformations(
        request,
        this.getRequestTransformationRules()
      );

      // Extract the actual transformed data from the result
      const transformedRequest = this.extractTransformationResult(transformedResult);

      this.logger.logModule(this.id, 'processing-request-complete', {
        transformationCount: this.getRequestTransformationRules().length
      });

      return isDto ? { ...dto!, data: transformedRequest } : { data: transformedRequest, route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } } as SharedPipelineRequest;

    } catch (error) {
      this.logger.logModule(this.id, 'processing-request-error', { error });
      throw error;
    }
  }

  /**
   * Process outgoing response - Apply reverse compatibility transformations
   */
  async processOutgoing(response: any): Promise<unknown> {
    if (!this.isInitialized) {
      throw new Error('LM Studio Compatibility module is not initialized');
    }

    try {
      const isDto = this.isPipelineResponse(response);
      const payload = isDto ? (response as UnknownObject).data : response;
      const payloadObj = payload as UnknownObject;
      this.logger.logModule(this.id, 'processing-response-start', {
        hasToolCalls: !!payloadObj?.tool_calls,
        hasChoices: !!payloadObj?.choices
      });

      // Apply transformation rules to response
      const transformedResult = await this.applyTransformations(
        payload,
        this.getResponseTransformationRules()
      );

      // Extract the actual transformed data from the result
      const transformedResponse = this.extractTransformationResult(transformedResult);

      this.logger.logModule(this.id, 'processing-response-complete', {
        transformationCount: this.getResponseTransformationRules().length
      });

      return isDto ? { ...(response as UnknownObject), data: transformedResponse } : transformedResponse;

    } catch (error) {
      this.logger.logModule(this.id, 'processing-response-error', { error });
      throw error;
    }
  }

  /**
   * Apply compatibility transformations
   */
  async applyTransformations(data: any, rules: TransformationRule[]): Promise<unknown> {
    if (!rules || rules.length === 0) {
      return data;
    }

    try {
      if (!this.transformationEngine || typeof this.transformationEngine !== 'object') {
        throw new Error('Transformation engine not initialized');
      }
      
      const engine = this.transformationEngine as UnknownObject;
      if (typeof engine.transform !== 'function') {
        throw new Error('Invalid transformation engine: missing transform method');
      }
      
      const result = await engine.transform(data, rules);

      this.logger.logModule(this.id, 'transformations-applied', {
        ruleCount: rules.length,
        success: true
      });

      return result;

    } catch (error) {
      this.logger.logModule(this.id, 'transformation-error', {
        ruleCount: rules.length,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'cleanup-start');

      // Reset state
      this.isInitialized = false;

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
  } {
    return {
      id: this.id,
      type: this.type,
      isInitialized: this.isInitialized,
      ruleCount: this.rules.length,
      lastActivity: Date.now()
    };
  }

  /**
   * Validate configuration
   */
  private validateConfig(): void {
    if (!this.config.type || this.config.type !== 'lmstudio-compatibility') {
      throw new Error('Invalid compatibility module type configuration');
    }

    const moduleConfig = this.config.config as UnknownObject;
    if (!moduleConfig) {
      throw new Error('LM Studio compatibility configuration is required');
    }

    this.logger.logModule(this.id, 'config-validation-success', {
      type: this.config.type,
      hasToolsEnabled: !!moduleConfig.toolsEnabled,
      hasCustomRules: !!moduleConfig.customRules
    });
  }

  /**
   * Initialize transformation rules
   */
  private initializeTransformationRules(): TransformationRule[] {
    const moduleConfig = this.config.config as UnknownObject;
    const rules: TransformationRule[] = [];

    // Add custom rules from configuration
    if (moduleConfig.customRules && Array.isArray(moduleConfig.customRules)) {
      rules.push(...moduleConfig.customRules);
    }

    // Add default LM Studio transformation rules
    rules.push(...this.getDefaultTransformationRules());

    return rules;
  }

  /**
   * Get default LM Studio transformation rules
   */
  private getDefaultTransformationRules(): TransformationRule[] {
    return [
      // Tools API conversion rule
      {
        id: 'tools-conversion',
        transform: 'mapping',
        sourcePath: 'tools',
        targetPath: 'tools',
        mapping: {
          'type': 'type',
          'function': 'function'
        },
        condition: {
          field: 'tools',
          operator: 'exists',
          value: null
        }
      },

      // Message format adaptation
      {
        id: 'message-format',
        transform: 'rename',
        sourcePath: 'messages',
        targetPath: 'messages'
      }
    ];
  }

  /**
   * Get request transformation rules
   */
  private getRequestTransformationRules(): TransformationRule[] {
    const moduleConfig = this.config.config as UnknownObject;
    const rules = [...this.rules];

    // Add request-specific rules
    if (moduleConfig.toolsEnabled === true) {
      rules.push({
        id: 'tools-request-conversion',
        transform: 'mapping',
        sourcePath: 'tools',
        targetPath: 'tools',
        mapping: {
          // LM Studio expects full OpenAI format, no transformation needed
          'type': 'type',
          'function': 'function'
        }
      });
    }

    return rules;
  }

  /**
   * Get response transformation rules
   */
  private getResponseTransformationRules(): TransformationRule[] {
    const moduleConfig = this.config.config as UnknownObject;
    const rules = [...this.rules];

    // Add response-specific rules
    rules.push(
      // Response format mapping
      {
        id: 'response-format-mapping',
        transform: 'mapping',
        sourcePath: 'object',
        targetPath: 'object',
        mapping: {
          'chat.completion': 'chat.completion',
          'chat.completion.chunk': 'chat.completion.chunk'
        }
      },

      // Tool calls conversion
      {
        id: 'tool-calls-response',
        transform: 'mapping',
        sourcePath: 'choices.*.message.tool_calls',
        targetPath: 'choices.*.message.tool_calls',
        mapping: {
          'id': 'id',
          'type': 'type',
          'function': 'function'
        },
        condition: {
          field: 'choices.*.message.tool_calls',
          operator: 'exists',
          value: null
        }
      }
    );

    return rules;
  }

  /**
   * Add custom transformation rule
   */
  addTransformationRule(rule: TransformationRule): void {
    this.rules.push(rule);

    this.logger.logModule(this.id, 'transformation-rule-added', {
      ruleId: rule.id,
      transformType: rule.transform
    });
  }

  /**
   * Remove transformation rule
   */
  removeTransformationRule(ruleId: string): boolean {
    const index = this.rules.findIndex(rule => rule.id === ruleId);
    if (index !== -1) {
      this.rules.splice(index, 1);

      this.logger.logModule(this.id, 'transformation-rule-removed', {
        ruleId
      });

      return true;
    }

    return false;
  }

  /**
   * Get all transformation rules
   */
  getTransformationRules(): TransformationRule[] {
    return [...this.rules];
  }

  /**
   * Update transformation rule
   */
  updateTransformationRule(ruleId: string, updates: Partial<TransformationRule>): boolean {
    const index = this.rules.findIndex(rule => rule.id === ruleId);
    if (index !== -1) {
      this.rules[index] = { ...this.rules[index], ...updates };

      this.logger.logModule(this.id, 'transformation-rule-updated', {
        ruleId,
        updatedFields: Object.keys(updates)
      });

      return true;
    }

    return false;
  }

  /**
   * Type guard for SharedPipelineRequest
   */
  private isSharedPipelineRequest(obj: any): obj is SharedPipelineRequest {
    return obj !== null && 
           typeof obj === 'object' && 
           'data' in obj && 
           'route' in obj &&
           'metadata' in obj &&
           'debug' in obj;
  }

  /**
   * Type guard for pipeline response (has data and metadata)
   */
  private isPipelineResponse(obj: any): obj is UnknownObject {
    return obj !== null && 
           typeof obj === 'object' && 
           'data' in obj && 
           'metadata' in obj;
  }

  /**
   * Extract transformation result from engine response
   */
  private extractTransformationResult(result: any): any {
    if (result && typeof result === 'object' && 'data' in result) {
      return (result as UnknownObject).data;
    }
    return result;
  }
}
