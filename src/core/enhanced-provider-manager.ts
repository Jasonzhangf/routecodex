/**
 * Enhanced Provider Manager with Unimplemented Module Support
 * Extends the base ProviderManager to automatically create unimplemented providers
 */

import { ProviderManager, type ProviderManagerOptions } from './provider-manager.js';
import {
  BaseProvider,
  // type ProviderResponse,
  // type ProviderHealth,
  // type ProviderStats,
} from '../providers/base-provider.js';
import { 
  UnimplementedProvider,
  type UnimplementedProviderConfig
} from '../providers/unimplemented-provider.js';
import {
  // type OpenAIModel,
  // type ModelConfig,
} from '../server/types.js';
import { UnimplementedModuleFactory } from '../modules/unimplemented-module-factory.js';
import { type ProviderConfig, type ServerConfig, RouteCodexError } from '../server/types.js';
import type { UnknownObject } from '../types/common-types.js';

/**
 * Enhanced Provider Manager Configuration
 */
export interface EnhancedProviderManagerOptions extends ProviderManagerOptions {
  enableUnimplementedProviders?: boolean;
  unimplementedProviderDefaults?: Partial<UnimplementedProviderConfig>;
  autoCreateUnimplemented?: boolean;
}

/**
 * Enhanced Provider Manager
 * Automatically creates unimplemented providers for missing or disabled functionality
 */
export class EnhancedProviderManager extends ProviderManager {
  private unimplementedFactory: UnimplementedModuleFactory;
  private enhancedOptions: EnhancedProviderManagerOptions;
  private unimplementedProviders: Map<string, UnimplementedProvider> = new Map();

  constructor(config: ServerConfig, options: EnhancedProviderManagerOptions = {}) {
    super(config, options);

    this.enhancedOptions = {
      enableUnimplementedProviders: true,
      autoCreateUnimplemented: true,
      unimplementedProviderDefaults: {
        unimplementedMessage: 'This provider functionality is not yet implemented',
        logUnimplementedCalls: true,
        trackCallerInfo: true,
      },
      ...options,
    };

    this.unimplementedFactory = UnimplementedModuleFactory.getInstance();
  }

  /**
   * Initialize the enhanced provider manager
   */
  public async initialize(): Promise<void> {
    try {
      // Initialize base provider manager
      await super.initialize();

      // Initialize unimplemented module factory
      if (this.enhancedOptions.enableUnimplementedProviders) {
        await this.unimplementedFactory.initialize();
      }
    } catch (error) {
      throw new RouteCodexError(
        `Failed to initialize enhanced provider manager: ${error instanceof Error ? error.message : String(error)}`,
        'enhanced_provider_manager_initialization_failed',
        500
      );
    }
  }

  /**
   * Add a new provider - creates unimplemented provider if type is not supported
   */
  public async addProvider(providerId: string, config: ProviderConfig): Promise<void> {
    try {
      // Try to add as regular provider first
      await super.addProvider(providerId, config);
    } catch (error) {
      // If regular provider creation fails and unimplemented providers are enabled
      if (
        this.enhancedOptions.enableUnimplementedProviders &&
        this.enhancedOptions.autoCreateUnimplemented &&
        error instanceof RouteCodexError &&
        error.code === 'unsupported_provider_type'
      ) {
        // Create unimplemented provider instead
        await this.createUnimplementedProvider(providerId, config);
      } else {
        // Re-throw the original error if we can't handle it
        throw error;
      }
    }
  }

  /**
   * Create an unimplemented provider for unsupported provider types
   */
  private async createUnimplementedProvider(
    providerId: string,
    config: ProviderConfig
  ): Promise<void> {
    try {
      const unimplementedConfig: UnimplementedProviderConfig = {
        ...config,
        ...this.enhancedOptions.unimplementedProviderDefaults,
        id: providerId,
        type: config.type || 'unimplemented',
      };

      const unimplementedProvider = new UnimplementedProvider(unimplementedConfig);
      await unimplementedProvider.initialize();

      this.unimplementedProviders.set(providerId, unimplementedProvider);

      // Log the creation of unimplemented provider
      console.log(`Created unimplemented provider for '${providerId}' (type: ${config.type})`);
    } catch (error) {
      throw new RouteCodexError(
        `Failed to create unimplemented provider for '${providerId}': ${error instanceof Error ? error.message : String(error)}`,
        'unimplemented_provider_creation_failed',
        500
      );
    }
  }

  /**
   * Get provider by ID - falls back to unimplemented providers
   */
  public getProvider(providerId: string): BaseProvider | null {
    // Try regular provider first
    const regularProvider = super.getProvider(providerId);
    if (regularProvider) {
      return regularProvider;
    }

    // Fall back to unimplemented provider
    return this.unimplementedProviders.get(providerId) || null;
  }

  /**
   * Get all providers (regular + unimplemented)
   */
  public getAllProviders(): Map<string, BaseProvider> {
    const allProviders = new Map<string, BaseProvider>();

    // Add regular providers
    const regularProviders = (this as any).providers; // Access private field from parent
    for (const [providerId, providerInstance] of regularProviders) {
      allProviders.set(providerId, providerInstance.provider);
    }

    // Add unimplemented providers
    for (const [providerId, unimplementedProvider] of this.unimplementedProviders) {
      allProviders.set(providerId, unimplementedProvider);
    }

    return allProviders;
  }

  /**
   * Get active providers (excluding unimplemented ones by default)
   */
  public getActiveProviders(includeUnimplemented: boolean = false): BaseProvider[] {
    const activeProviders = super.getActiveProviders();

    if (includeUnimplemented) {
      // Add unimplemented providers that have been called (have stats)
      for (const [_providerId, unimplementedProvider] of this.unimplementedProviders) { // eslint-disable-line @typescript-eslint/no-unused-vars
        const stats = unimplementedProvider.getUnimplementedStats();
        if ((stats.totalCalls as number) > 0) {
          activeProviders.push(unimplementedProvider);
        }
      }
    }

    return activeProviders;
  }

  /**
   * Remove provider - handles both regular and unimplemented providers
   */
  public async removeProvider(providerId: string): Promise<void> {
    // Try to remove from regular providers first
    try {
      await super.removeProvider(providerId);
      return;
    } catch (error) {
      // If not found in regular providers, try unimplemented providers
      const unimplementedProvider = this.unimplementedProviders.get(providerId);
      if (unimplementedProvider) {
        await unimplementedProvider.destroy();
        this.unimplementedProviders.delete(providerId);
      } else {
        throw error; // Re-throw if not found in either
      }
    }
  }

  /**
   * Get enhanced statistics including unimplemented provider usage
   */
  public getEnhancedStats(): UnknownObject {
    const baseStats = (this as UnknownObject).metrics; // Access private field from parent
    const unimplementedStats = this.unimplementedFactory.getStats();

    return {
      regularProviders: baseStats,
      unimplementedProviders: {
        count: this.unimplementedProviders.size,
        totalCalls: unimplementedStats.totalCalls,
        mostCalled: unimplementedStats.mostCalledModules.slice(0, 5),
        calledModules: this.unimplementedFactory.getCalledModules(),
        unusedModules: this.unimplementedFactory.getUnusedModules(),
      },
      summary: {
        totalProviders: (this as any).providers.size + this.unimplementedProviders.size,
        regularProviders: (this as any).providers.size,
        unimplementedProviders: this.unimplementedProviders.size,
        totalUnimplementedCalls: unimplementedStats.totalCalls,
      },
    };
  }

  /**
   * Get unimplemented provider statistics
   */
  public getUnimplementedProviderStats(providerId?: string): UnknownObject | null {
    if (providerId) {
      const provider = this.unimplementedProviders.get(providerId);
      return provider ? provider.getUnimplementedStats() : null;
    }

    // Return stats for all unimplemented providers
    const allStats: Record<string, UnknownObject> = {};
    for (const [id, provider] of this.unimplementedProviders) {
      allStats[id] = provider.getUnimplementedStats();
    }
    return allStats;
  }

  /**
   * Reset unimplemented provider statistics
   */
  public resetUnimplementedProviderStats(providerId?: string): void {
    if (providerId) {
      const provider = this.unimplementedProviders.get(providerId);
      if (provider) {
        provider.resetUnimplementedStats();
      }
    } else {
      // Reset all unimplemented provider stats
      for (const provider of this.unimplementedProviders.values()) {
        provider.resetUnimplementedStats();
      }
    }
  }

  /**
   * Clean up old unimplemented providers
   */
  public async cleanupUnimplementedProviders(maxAgeHours: number = 24): Promise<number> {
    return await this.unimplementedFactory.cleanupOldModules(maxAgeHours);
  }

  /**
   * Stop enhanced provider manager
   */
  public async stop(): Promise<void> {
    try {
      // Stop unimplemented providers first
      const unimplementedProviderIds = Array.from(this.unimplementedProviders.keys());
      for (const providerId of unimplementedProviderIds) {
        try {
          await this.removeProvider(providerId);
        } catch (error) {
          console.error(
            `Error removing unimplemented provider ${providerId} during shutdown:`,
            error
          );
        }
      }

      // Stop base provider manager
      await super.stop();
    } catch (error) {
      throw new RouteCodexError(
        `Failed to stop enhanced provider manager: ${error instanceof Error ? error.message : String(error)}`,
        'enhanced_provider_manager_stop_failed',
        500
      );
    }
  }
}
