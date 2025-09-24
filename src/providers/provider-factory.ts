/**
 * Provider Factory
 * Factory for creating and managing AI providers
 */

import { BaseProvider, type ProviderResponse, type ProviderHealth } from './base-provider.js';
import { type ProviderStats } from '../server/types.js';
import { OpenAIProvider } from './openai-provider.js';
import { ConfigManager } from '../core/config-manager.js';
import { DebugEventBus } from 'rcc-debugcenter';
import { ErrorHandlingCenter, type ErrorContext } from 'rcc-errorhandling';
import {
  type ProviderConfig,
  type ModelConfig,
  type OpenAIChatCompletionRequest,
  type OpenAICompletionRequest,
  type OpenAICompletionResponse,
  type OpenAIModel,
  type StreamOptions,
  RouteCodexError
} from '../server/types.js';

/**
 * Provider instance wrapper
 */
interface ProviderInstance {
  provider: BaseProvider;
  config: ProviderConfig;
  lastUsed: number;
  health: ProviderHealth;
}

/**
 * Provider selection strategy
 */
export type ProviderSelectionStrategy = 'round-robin' | 'weighted' | 'least-loaded' | 'fastest';

/**
 * Provider selection options
 */
export interface ProviderSelectionOptions {
  strategy: ProviderSelectionStrategy;
  timeout?: number;
  retryAttempts?: number;
  failoverEnabled?: boolean;
  healthCheckEnabled?: boolean;
}

/**
 * Provider Factory class
 */
export class ProviderFactory {
  private configManager: ConfigManager;
  private providers: Map<string, ProviderInstance> = new Map();
  private debugEventBus: DebugEventBus;
  private errorHandling: ErrorHandlingCenter;
  private currentIndex: number = 0;
  private selectionOptions: ProviderSelectionOptions;
  private healthCheckInterval?: NodeJS.Timeout;

  constructor(configManager: ConfigManager, options: ProviderSelectionOptions = {
    strategy: 'round-robin',
    timeout: 30000,
    retryAttempts: 3,
    failoverEnabled: true,
    healthCheckEnabled: true
  }) {
    this.configManager = configManager;
    this.debugEventBus = DebugEventBus.getInstance();
    this.errorHandling = new ErrorHandlingCenter();
    this.selectionOptions = options;
  }

  /**
   * Initialize the provider factory
   */
  public async initialize(): Promise<void> {
    try {
      await this.errorHandling.initialize();

      // Load providers from configuration
      await this.loadProviders();

      // Start health check monitoring
      if (this.selectionOptions.healthCheckEnabled) {
        this.startHealthCheckMonitoring();
      }

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'provider-factory',
        operationId: 'factory_initialized',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          providerCount: this.providers.size,
          strategy: this.selectionOptions.strategy
        }
      });

    } catch (error) {
      await this.handleError(error as Error, 'initialization');
      throw error;
    }
  }

  /**
   * Load providers from configuration
   */
  private async loadProviders(): Promise<void> {
    try {
      const config = this.configManager.getConfiguration();
      const providerConfigs = Object.entries(config.providers);

      for (const [providerId, providerConfig] of providerConfigs) {
        if (providerConfig.enabled !== false) {
          await this.createProvider(providerId, providerConfig);
        }
      }

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'provider-factory',
        operationId: 'providers_loaded',
        timestamp: Date.now(),
        type: 'end',
        position: 'middle',
        data: {
          loadedProviders: Array.from(this.providers.keys()),
          totalConfigs: providerConfigs.length
        }
      });

    } catch (error) {
      await this.handleError(error as Error, 'load_providers');
      throw error;
    }
  }

  /**
   * Create a provider instance
   */
  private async createProvider(providerId: string, providerConfig: any): Promise<void> {
    try {
      // Convert config to standardized format
      const config: ProviderConfig = {
        id: providerId,
        type: providerConfig.type || 'custom',
        enabled: providerConfig.enabled !== false,
        baseUrl: providerConfig.baseUrl,
        apiKey: providerConfig.apiKey,
        models: providerConfig.models || {},
        rateLimit: providerConfig.rateLimit,
        timeout: providerConfig.timeout,
        retryAttempts: providerConfig.retryAttempts,
        weight: providerConfig.weight,
        headers: providerConfig.headers
      };

      // Create provider instance based on type
      let provider: BaseProvider;

      switch (config.type.toLowerCase()) {
        case 'openai':
          provider = new OpenAIProvider(config);
          break;
        default:
          throw new RouteCodexError(
            `Unsupported provider type: ${config.type}`,
            'unsupported_provider_type',
            400
          );
      }

      // Initialize provider
      await provider.initialize();

      // Store provider instance
      this.providers.set(providerId, {
        provider,
        config,
        lastUsed: 0,
        health: await provider.getHealth()
      });

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'provider-factory',
        operationId: 'provider_created',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          providerId,
          providerType: config.type,
          models: Object.keys(config.models)
        }
      });

    } catch (error) {
      await this.handleError(error as Error, `create_provider_${providerId}`);
      console.error(`Failed to create provider ${providerId}:`, error);
    }
  }

  /**
   * Select provider for request
   */
  public async selectProvider(
    request: OpenAIChatCompletionRequest | OpenAICompletionRequest,
    options?: { preferredProvider?: string; excludedProviders?: string[] }
  ): Promise<BaseProvider> {
    const availableProviders = this.getAvailableProviders(options?.excludedProviders);

    if (availableProviders.length === 0) {
      throw new RouteCodexError(
        'No available providers',
        'no_available_providers',
        503
      );
    }

    // Check if preferred provider is available and supports the model
    if (options?.preferredProvider) {
      const preferredProvider = availableProviders.find(p => p.provider.getModuleInfo().id === options.preferredProvider);
      if (preferredProvider && preferredProvider.provider.isModelSupported(request.model)) {
        preferredProvider.lastUsed = Date.now();
        return preferredProvider.provider;
      }
    }

    // Filter providers that support the requested model
    const capableProviders = availableProviders.filter(p => p.provider.isModelSupported(request.model));

    if (capableProviders.length === 0) {
      throw new RouteCodexError(
        `No providers support model '${request.model}'`,
        'model_not_supported',
        400
      );
    }

    // Select provider based on strategy
    let selectedProvider: ProviderInstance;

    switch (this.selectionOptions.strategy) {
      case 'round-robin':
        selectedProvider = this.selectRoundRobin(capableProviders);
        break;
      case 'weighted':
        selectedProvider = this.selectWeighted(capableProviders);
        break;
      case 'least-loaded':
        selectedProvider = this.selectLeastLoaded(capableProviders);
        break;
      case 'fastest':
        selectedProvider = this.selectFastest(capableProviders);
        break;
      default:
        selectedProvider = capableProviders[0];
    }

    selectedProvider.lastUsed = Date.now();

    this.debugEventBus.publish({
      sessionId: `session_${Date.now()}`,
      moduleId: 'provider-factory',
      operationId: 'provider_selected',
      timestamp: Date.now(),
      type: 'start',
      position: 'middle',
      data: {
        providerId: selectedProvider.provider.getModuleInfo().id,
        strategy: this.selectionOptions.strategy,
        model: request.model,
        availableProviders: capableProviders.length
      }
    });

    return selectedProvider.provider;
  }

  /**
   * Get available providers
   */
  private getAvailableProviders(excludedProviders?: string[]): ProviderInstance[] {
    const providers: ProviderInstance[] = [];

    for (const [providerId, providerInstance] of this.providers) {
      if (excludedProviders?.includes(providerId)) {
        continue;
      }

      if (providerInstance.health.status === 'healthy') {
        providers.push(providerInstance);
      }
    }

    return providers;
  }

  /**
   * Round-robin selection
   */
  private selectRoundRobin(providers: ProviderInstance[]): ProviderInstance {
    const provider = providers[this.currentIndex % providers.length];
    this.currentIndex++;
    return provider;
  }

  /**
   * Weighted selection
   */
  private selectWeighted(providers: ProviderInstance[]): ProviderInstance {
    // Calculate total weight
    let totalWeight = 0;
    const weightedProviders = providers.map(provider => {
      const weight = provider.config.weight || 1;
      totalWeight += weight;
      return { provider, weight };
    });

    // Select based on weight
    let random = Math.random() * totalWeight;
    for (const { provider, weight } of weightedProviders) {
      random -= weight;
      if (random <= 0) {
        return provider;
      }
    }

    return weightedProviders[0].provider;
  }

  /**
   * Least loaded selection
   */
  private selectLeastLoaded(providers: ProviderInstance[]): ProviderInstance {
    return providers.reduce((least, current) => {
      const leastStats = least.provider.getStats();
      const currentStats = current.provider.getStats();

      // Compare total requests
      return leastStats.totalRequests < currentStats.totalRequests ? least : current;
    });
  }

  /**
   * Fastest selection
   */
  private selectFastest(providers: ProviderInstance[]): ProviderInstance {
    return providers.reduce((fastest, current) => {
      const fastestStats = fastest.provider.getStats();
      const currentStats = current.provider.getStats();

      // Compare average response time (prefer providers with actual stats)
      if (fastestStats.totalRequests === 0) {return current;}
      if (currentStats.totalRequests === 0) {return fastest;}

      return fastestStats.averageResponseTime < currentStats.averageResponseTime ? fastest : current;
    });
  }

  /**
   * Process chat completion request
   */
  public async processChatCompletion(
    request: OpenAIChatCompletionRequest,
    options?: { preferredProvider?: string; excludedProviders?: string[] }
  ): Promise<ProviderResponse> {
    try {
      const provider = await this.selectProvider(request, options);
      const response = await provider.processChatCompletion(request, {
        timeout: this.selectionOptions.timeout,
        retryAttempts: this.selectionOptions.retryAttempts
      });

      return response;

    } catch (error) {
      // Try failover if enabled
      if (this.selectionOptions.failoverEnabled && options?.preferredProvider) {
        try {
          const provider = await this.selectProvider(request, { excludedProviders: [options.preferredProvider] });
          const response = await provider.processChatCompletion(request, {
            timeout: this.selectionOptions.timeout,
            retryAttempts: this.selectionOptions.retryAttempts
          });

          this.debugEventBus.publish({
            sessionId: `session_${Date.now()}`,
            moduleId: 'provider-factory',
            operationId: 'failover_success',
            timestamp: Date.now(),
            type: 'start',
            position: 'middle',
            data: {
              originalProvider: options.preferredProvider,
              failoverProvider: provider.getModuleInfo().id,
              model: request.model
            }
          });

          return response;
        } catch (failoverError) {
          await this.handleError(failoverError as Error, 'failover_attempt');
        }
      }

      await this.handleError(error as Error, 'process_chat_completion');
      throw error;
    }
  }

  /**
   * Process completion request
   */
  public async processCompletion(
    request: OpenAICompletionRequest,
    options?: { preferredProvider?: string; excludedProviders?: string[] }
  ): Promise<ProviderResponse> {
    try {
      const provider = await this.selectProvider(request, options);
      const response = await provider.processCompletion(request, {
        timeout: this.selectionOptions.timeout,
        retryAttempts: this.selectionOptions.retryAttempts
      });

      return response;

    } catch (error) {
      // Try failover if enabled
      if (this.selectionOptions.failoverEnabled && options?.preferredProvider) {
        try {
          const provider = await this.selectProvider(request, { excludedProviders: [options.preferredProvider] });
          const response = await provider.processCompletion(request, {
            timeout: this.selectionOptions.timeout,
            retryAttempts: this.selectionOptions.retryAttempts
          });

          this.debugEventBus.publish({
            sessionId: `session_${Date.now()}`,
            moduleId: 'provider-factory',
            operationId: 'failover_success',
            timestamp: Date.now(),
            type: 'start',
            position: 'middle',
            data: {
              originalProvider: options.preferredProvider,
              failoverProvider: provider.getModuleInfo().id,
              model: request.model
            }
          });

          return response;
        } catch (failoverError) {
          await this.handleError(failoverError as Error, 'failover_attempt');
        }
      }

      await this.handleError(error as Error, 'process_completion');
      throw error;
    }
  }

  /**
   * Get all available models
   */
  public async getModels(): Promise<OpenAIModel[]> {
    const models: OpenAIModel[] = [];
    const providerIds = Array.from(this.providers.keys());

    for (const providerId of providerIds) {
      const providerInstance = this.providers.get(providerId);
      if (providerInstance && providerInstance.health.status === 'healthy') {
        try {
          const providerModels = await providerInstance.provider.getModels();
          models.push(...providerModels);
        } catch (error) {
          await this.handleError(error as Error, `get_models_${providerId}`);
        }
      }
    }

    return models;
  }

  /**
   * Get provider by ID
   */
  public getProvider(providerId: string): BaseProvider | undefined {
    const providerInstance = this.providers.get(providerId);
    return providerInstance?.provider;
  }

  /**
   * Get all providers
   */
  public getProviders(): Map<string, BaseProvider> {
    const result = new Map<string, BaseProvider>();
    for (const [providerId, providerInstance] of this.providers) {
      result.set(providerId, providerInstance.provider);
    }
    return result;
  }

  /**
   * Get provider health status
   */
  public getProviderHealth(): Record<string, ProviderHealth> {
    const health: Record<string, ProviderHealth> = {};
    for (const [providerId, providerInstance] of this.providers) {
      health[providerId] = providerInstance.health;
    }
    return health;
  }

  /**
   * Start health check monitoring
   */
  private startHealthCheckMonitoring(): void {
    // Check health every 30 seconds
    this.healthCheckInterval = setInterval(async () => {
      for (const [providerId, providerInstance] of this.providers) {
        try {
          providerInstance.health = await providerInstance.provider.healthCheck();
        } catch (error) {
          await this.handleError(error as Error, `health_check_${providerId}`);
          providerInstance.health.status = 'unhealthy';
          providerInstance.health.error = error instanceof Error ? error.message : String(error);
        }
      }
    }, 30000);
  }

  /**
   * Add provider dynamically
   */
  public async addProvider(providerId: string, providerConfig: any): Promise<void> {
    try {
      if (this.providers.has(providerId)) {
        throw new RouteCodexError(
          `Provider '${providerId}' already exists`,
          'provider_already_exists',
          400
        );
      }

      await this.createProvider(providerId, providerConfig);

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'provider-factory',
        operationId: 'provider_added',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          providerId,
          providerType: providerConfig.type
        }
      });

    } catch (error) {
      await this.handleError(error as Error, `add_provider_${providerId}`);
      throw error;
    }
  }

  /**
   * Remove provider
   */
  public async removeProvider(providerId: string): Promise<void> {
    try {
      const providerInstance = this.providers.get(providerId);
      if (!providerInstance) {
        throw new RouteCodexError(
          `Provider '${providerId}' not found`,
          'provider_not_found',
          404
        );
      }

      // Destroy provider
      await providerInstance.provider.destroy();

      // Remove from map
      this.providers.delete(providerId);

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'provider-factory',
        operationId: 'provider_removed',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          providerId
        }
      });

    } catch (error) {
      await this.handleError(error as Error, `remove_provider_${providerId}`);
      throw error;
    }
  }

  /**
   * Update provider configuration
   */
  public async updateProvider(providerId: string, newConfig: Partial<ProviderConfig>): Promise<void> {
    try {
      const providerInstance = this.providers.get(providerId);
      if (!providerInstance) {
        throw new RouteCodexError(
          `Provider '${providerId}' not found`,
          'provider_not_found',
          404
        );
      }

      await providerInstance.provider.updateConfig(newConfig);
      providerInstance.config = { ...providerInstance.config, ...newConfig };

      this.debugEventBus.publish({
        sessionId: `session_${Date.now()}`,
        moduleId: 'provider-factory',
        operationId: 'provider_updated',
        timestamp: Date.now(),
        type: 'start',
        position: 'middle',
        data: {
          providerId,
          changes: Object.keys(newConfig)
        }
      });

    } catch (error) {
      await this.handleError(error as Error, `update_provider_${providerId}`);
      throw error;
    }
  }

  /**
   * Handle error
   */
  private async handleError(error: Error, context: string): Promise<void> {
    try {
      const errorContext: ErrorContext = {
        error: error.message,
        source: `provider-factory.${context}`,
        severity: 'medium',
        timestamp: Date.now(),
        moduleId: 'provider-factory',
        context: {
          stack: error.stack,
          name: error.name
        }
      };

      await this.errorHandling.handleError(errorContext);
    } catch (handlerError) {
      console.error('Failed to handle error:', handlerError);
      console.error('Original error:', error);
    }
  }

  /**
   * Stop provider factory
   */
  public async stop(): Promise<void> {
    // Stop health check monitoring
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }

    // Destroy all providers
    for (const [providerId, providerInstance] of this.providers) {
      try {
        await providerInstance.provider.destroy();
      } catch (error) {
        console.error(`Error destroying provider ${providerId}:`, error);
      }
    }

    this.providers.clear();

    await this.errorHandling.destroy();
  }
}