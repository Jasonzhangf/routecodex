/**
 * Service Initializer
 * Initializes and configures all core services for the RouteCodex system
 */

import { ServiceContainer, ServiceTokens } from './service-container.js';
import { ServiceRegistry } from './service-registry.js';
import { ErrorHandlingCenter } from 'rcc-errorhandling';
import { DebugEventBus } from 'rcc-debugcenter';
import { PipelineDebugLogger } from '../../modules/pipeline/utils/debug-logger.js';

/**
 * Service configuration interface
 */
export interface ServiceConfig {
  errorHandling?: {
    enableMetrics?: boolean;
    logLevel?: 'debug' | 'info' | 'warn' | 'error';
  };
  debugEventBus?: {
    enableMetrics?: boolean;
    bufferSize?: number;
  };
  pipelineLogger?: {
    enableConsoleLogging?: boolean;
    enableDebugCenter?: boolean;
    logLevel?: 'none' | 'basic' | 'detailed' | 'verbose';
  };
}

/**
 * Default service configuration
 */
const DEFAULT_CONFIG: ServiceConfig = {
  errorHandling: {
    enableMetrics: true,
    logLevel: 'info'
  },
  debugEventBus: {
    enableMetrics: true,
    bufferSize: 1000
  },
  pipelineLogger: {
    enableConsoleLogging: true,
    enableDebugCenter: true,
    logLevel: 'detailed'
  }
};

/**
 * Service Initializer Class
 * Responsible for setting up and configuring all core services
 */
export class ServiceInitializer {
  private container: ServiceContainer;
  private registry: ServiceRegistry;
  private config: ServiceConfig;

  constructor(config: ServiceConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.container = ServiceContainer.getInstance();
    this.registry = ServiceRegistry.getInstance();
  }

  /**
   * Initialize all core services
   */
  async initialize(): Promise<void> {
    try {
      // Register core services
      this.registerErrorHandling();
      this.registerDebugEventBus();
      this.registerPipelineLogger();

      // Initialize services
      await this.initializeServices();

      console.log('✅ 核心服务初始化完成');
    } catch (error) {
      console.error('❌ 核心服务初始化失败:', error);
      throw error;
    }
  }

  /**
   * Register ErrorHandlingCenter service
   */
  private registerErrorHandling(): void {
    this.registry.registerService(ServiceTokens.ERROR_HANDLING_CENTER, {
      singleton: true,
      factory: () => {
        const errorHandling = new ErrorHandlingCenter();

        if (this.config.errorHandling?.enableMetrics) {
          console.log('📊 Error handling metrics enabled');
        }

        return errorHandling;
      }
    });
  }

  /**
   * Register DebugEventBus service
   */
  private registerDebugEventBus(): void {
    this.registry.registerService(ServiceTokens.DEBUG_EVENT_BUS, {
      singleton: true,
      factory: () => {
        const eventBus = DebugEventBus.getInstance();

        if (this.config.debugEventBus?.enableMetrics) {
          console.log('📊 Debug event bus metrics enabled');
        }

        return eventBus;
      }
    });
  }

  /**
   * Register PipelineDebugLogger service
   */
  private registerPipelineLogger(): void {
    this.registry.registerService(ServiceTokens.PIPELINE_DEBUG_LOGGER, {
      singleton: true,
      factory: () => {
        const loggerConfig = {
          enableConsoleLogging: this.config.pipelineLogger?.enableConsoleLogging ?? true,
          enableDebugCenter: this.config.pipelineLogger?.enableDebugCenter ?? true,
          logLevel: this.config.pipelineLogger?.logLevel ?? 'detailed'
        };

        return new PipelineDebugLogger(null, loggerConfig);
      }
    });
  }

  /**
   * Initialize all registered services
   */
  private async initializeServices(): Promise<void> {
    const serviceNames = ['ErrorHandlingCenter', 'DebugEventBus', 'PipelineDebugLogger'];

    for (const serviceName of serviceNames) {
      try {
        const service = this.container.resolve(serviceName);
        if (service) {
          console.log(`✅ ${serviceName} service initialized`);
        } else {
          console.warn(`⚠️  ${serviceName} service not found in container`);
        }
      } catch (error) {
        console.error(`❌ Failed to initialize ${serviceName}:`, error);
        throw error;
      }
    }
  }

  /**
   * Get service container instance
   */
  getContainer(): ServiceContainer {
    return this.container;
  }

  /**
   * Get service registry instance
   */
  getRegistry(): ServiceRegistry {
    return this.registry;
  }

  /**
   * Shutdown all services
   */
  async shutdown(): Promise<void> {
    try {
      // Clean up service container
      this.container.clear();

      console.log('✅ 核心服务已关闭');
    } catch (error) {
      console.error('❌ 关闭核心服务时出错:', error);
      throw error;
    }
  }
}

/**
 * Create and initialize service initializer with default configuration
 */
export async function createServiceInitializer(config?: ServiceConfig): Promise<ServiceInitializer> {
  const initializer = new ServiceInitializer(config);
  await initializer.initialize();
  return initializer;
}
