/**
 * Passthrough Compatibility Implementation
 *
 * Provides a compatibility layer that simply passes through requests
 * without any transformations. Used when no format conversion is needed.
 */

import type { CompatibilityModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { TransformationRule } from '../../interfaces/pipeline-interfaces.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';

/**
 * Passthrough Compatibility Module
 */
export class PassthroughCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'passthrough-compatibility';
  readonly config: ModuleConfig;
  readonly rules: TransformationRule[] = [];

  private isInitialized = false;
  private logger: PipelineDebugLogger;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.logger = dependencies.logger as any;
    this.id = `compatibility-passthrough-${Date.now()}`;
    this.config = config;
  }

  /**
   * Initialize the compatibility module
   */
  async initialize(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'initializing', {
        config: this.config
      });

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
   * Process incoming request - Pass through without transformation
   */
  async processIncoming(request: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('Passthrough Compatibility module is not initialized');
    }

    try {
      this.logger.logModule(this.id, 'processing-request-start', {
        model: request.model
      });

      // Simply return the request as-is (passthrough)
      const result = request;

      this.logger.logModule(this.id, 'processing-request-complete', {
        transformationCount: 0
      });

      return result;

    } catch (error) {
      this.logger.logModule(this.id, 'processing-request-error', { error });
      throw error;
    }
  }

  /**
   * Process outgoing response - Pass through without transformation
   */
  async processOutgoing(response: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('Passthrough Compatibility module is not initialized');
    }

    try {
      this.logger.logModule(this.id, 'processing-response-start', {
        hasChoices: !!response.choices
      });

      // Simply return the response as-is (passthrough)
      const result = response;

      this.logger.logModule(this.id, 'processing-response-complete', {
        transformationCount: 0
      });

      return result;

    } catch (error) {
      this.logger.logModule(this.id, 'processing-response-error', { error });
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
   * Apply compatibility transformations
   */
  async applyTransformations(data: any, rules: TransformationRule[]): Promise<any> {
    // Passthrough compatibility simply returns the data as-is
    return data;
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
    // Accept alias types that are mapped to passthrough behavior
    const declared = (this.config && (this.config as any).type) || 'passthrough-compatibility';
    const allowed = new Set<string>(['passthrough-compatibility', 'glm-compatibility']);
    if (!allowed.has(declared)) {
      // Do not throw; treat as passthrough to maximize compatibility
      this.logger.logModule(this.id, 'alias-compatibility-detected', { declaredType: declared, normalizedTo: this.type });
      return;
    }

    this.logger.logModule(this.id, 'config-validation-success', {
      type: this.config.type
    });
  }
}
