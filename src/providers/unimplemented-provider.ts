/**
 * Unimplemented Provider
 * Standard provider for unimplemented functionality
 * Automatically creates unimplemented modules for missing providers
 */

import {
  BaseProvider,
  type ProviderResponse,
  type ProviderHealth,
  type ProviderStats,
} from '../providers/base-provider.js';
import {
  type OpenAIModel,
  type ModelConfig,
} from '../server/types.js';
import { UnimplementedModuleFactory } from '../modules/unimplemented-module-factory.js';
import type { UnknownObject } from '../types/common-types.js';
import { type UnimplementedModuleConfig } from '../modules/unimplemented-module.js';
import {
  type ProviderConfig,
  type OpenAIChatCompletionRequest,
  type OpenAICompletionRequest,
  type OpenAICompletionResponse,
  type StreamOptions,
  RouteCodexError,
} from '../server/types.js';

/**
 * Unimplemented Provider Configuration
 */
export interface UnimplementedProviderConfig extends ProviderConfig {
  unimplementedMessage?: string;
  logUnimplementedCalls?: boolean;
  trackCallerInfo?: boolean;
}

/**
 * Unimplemented Provider
 * Provides standardized unimplemented responses for missing provider functionality
 */
export class UnimplementedProvider extends BaseProvider {
  private unimplementedFactory: UnimplementedModuleFactory;
  private unimplementedModule: any;
  protected config: UnimplementedProviderConfig;

  constructor(config: UnimplementedProviderConfig) {
    super(config);

    this.config = {
      unimplementedMessage: 'This provider functionality is not implemented',
      logUnimplementedCalls: true,
      trackCallerInfo: true,
      ...config,
    };

    this.unimplementedFactory = UnimplementedModuleFactory.getInstance();
  }

  /**
   * Initialize the unimplemented provider
   */
  public async initialize(): Promise<void> {
    try {
      await super.initialize();
      await this.unimplementedFactory.initialize();

      // Create unimplemented module for this provider
      const moduleConfig: UnimplementedModuleConfig = {
        moduleId: this.config.id,
        moduleName: `${this.config.type}-provider`,
        description: `Unimplemented provider: ${this.config.type}`,
        customMessage: this.config.unimplementedMessage,
        logLevel: this.config.logUnimplementedCalls ? 'info' : 'error',
      };

      this.unimplementedModule = await this.unimplementedFactory.createModule(moduleConfig);
    } catch (error) {
      throw new RouteCodexError(
        `Failed to initialize unimplemented provider: ${error instanceof Error ? error.message : String(error)}`,
        'unimplemented_provider_initialization_failed',
        500
      );
    }
  }

  /**
   * Process chat completion request - returns unimplemented response
   */
  public async processChatCompletion(
    request: OpenAIChatCompletionRequest,
    options?: { timeout?: number; retryAttempts?: number }
  ): Promise<ProviderResponse> {
    const callerInfo = this.config.trackCallerInfo
      ? {
          callerId: `chat-completion-${request.model}`,
          context: { model: request.model, messages: request.messages?.length },
        }
      : undefined;

    const unimplementedResponse = await this.unimplementedModule.handleUnimplementedCall(
      'processChatCompletion',
      callerInfo
    );

    return this.createProviderResponse(unimplementedResponse);
  }

  /**
   * Process completion request - returns unimplemented response
   */
  public async processCompletion(
    request: OpenAICompletionRequest,
    options?: { timeout?: number; retryAttempts?: number }
  ): Promise<ProviderResponse> {
    const callerInfo = this.config.trackCallerInfo
      ? {
          callerId: `completion-${request.model}`,
          context: {
            model: request.model,
            prompt:
              typeof request.prompt === 'string'
                ? request.prompt.substring(0, 100)
                : Array.isArray(request.prompt)
                  ? request.prompt.join(' ').substring(0, 100)
                  : String(request.prompt).substring(0, 100),
          },
        }
      : undefined;

    const unimplementedResponse = await this.unimplementedModule.handleUnimplementedCall(
      'processCompletion',
      callerInfo
    );

    return this.createProviderResponse(unimplementedResponse);
  }

  /**
   * Process streaming chat completion - returns unimplemented response
   */
  public async processStreamingChatCompletion(
    request: OpenAIChatCompletionRequest,
    options: StreamOptions
  ): Promise<ProviderResponse> {
    const callerInfo = this.config.trackCallerInfo
      ? {
          callerId: `streaming-${request.model}`,
          context: { model: request.model, streaming: true },
        }
      : undefined;

    const unimplementedResponse = await this.unimplementedModule.handleUnimplementedCall(
      'processStreamingChatCompletion',
      callerInfo
    );

    return this.createProviderResponse(unimplementedResponse);
  }

  /**
   * Get available models - returns empty list for unimplemented provider
   */
  public async getModels(): Promise<OpenAIModel[]> {
    // Return empty array since provider is not implemented
    return [];
    const callerInfo = this.config.trackCallerInfo
      ? {
          callerId: 'get-models',
          context: { action: 'getModels' },
        }
      : undefined;

    await this.unimplementedModule.handleUnimplementedCall('getModels', callerInfo);

    // Return empty models list
    return [];
  }

  /**
   * Check if model is supported - always returns false for unimplemented provider
   */
  public isModelSupported(modelId: string): boolean {
    // Log the check but don't create full response for performance
    if (this.config.logUnimplementedCalls) {
      this.unimplementedModule
        .handleUnimplementedCall('isModelSupported', {
          callerId: `model-check-${modelId}`,
        })
        .catch(() => {}); // Silently handle logging errors
    }

    return false;
  }

  /**
   * Get model configuration - returns undefined for unimplemented provider
   */
  public getModelConfig(modelId: string): ModelConfig | undefined {
    // Log the check but don't create full response for performance
    if (this.config.logUnimplementedCalls) {
      this.unimplementedModule
        .handleUnimplementedCall('getModelConfig', {
          callerId: `config-check-${modelId}`,
        })
        .catch(() => {}); // Silently handle logging errors
    }

    return undefined; // No config available for unimplemented provider
  }

  /**
   * Health check - returns unhealthy status for unimplemented provider
   */
  public async healthCheck(): Promise<ProviderHealth> {
    return {
      status: 'unhealthy',
      error: 'Provider is unimplemented',
      consecutiveFailures: 999,
      lastCheck: new Date().toISOString(),
    };
  }

  /**
   * Get provider statistics
   */
  public getStats(): ProviderStats {
    const baseStats = super.getStats();
    const unimplementedStats = (this.unimplementedModule?.getStats() as UnknownObject) || {};
    const extended: UnknownObject = {
      ...baseStats as unknown as UnknownObject,
      unimplementedCalls: (unimplementedStats.totalCalls as number) || 0,
      lastUnimplementedCall: unimplementedStats.lastCallTime as string,
      firstUnimplementedCall: unimplementedStats.firstCallTime as string,
    };
    return extended as unknown as ProviderStats;
  }

  /**
   * Create standardized provider response from unimplemented response
   */
  private createProviderResponse(unimplementedResponse: any): ProviderResponse {
    return {
      success: false,
      error: unimplementedResponse.error,
      statusCode: unimplementedResponse.statusCode,
      headers: {
        'X-Module-Id': unimplementedResponse.moduleId,
        'X-Module-Name': unimplementedResponse.moduleName,
        'X-Request-Id': unimplementedResponse.requestId,
        'X-Timestamp': unimplementedResponse.timestamp,
        'X-Unimplemented': 'true',
      },
      duration: 0,
      data: {
        moduleId: unimplementedResponse.moduleId,
        moduleName: unimplementedResponse.moduleName,
        requestId: unimplementedResponse.requestId,
        timestamp: unimplementedResponse.timestamp,
        message: unimplementedResponse.error,
      },
    };
  }

  /**
   * Get unimplemented module factory for external access
   */
  public getUnimplementedModuleFactory(): UnimplementedModuleFactory {
    return this.unimplementedFactory;
  }

  /**
   * Get unimplemented module stats
   */
  public getUnimplementedStats(): UnknownObject {
    return (this.unimplementedModule?.getStats() as UnknownObject) || {};
  }

  /**
   * Reset unimplemented module statistics
   */
  public resetUnimplementedStats(): void {
    if (this.unimplementedModule) {
      this.unimplementedModule.resetStats();
    }
  }
}
