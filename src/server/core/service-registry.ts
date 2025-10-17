/**
 * Core Service Registry
 * Centralized service registration and management for RouteCodex server
 */

import { ServiceContainer, ServiceLifetime, ServiceTokens } from './service-container.js';
import { ErrorHandlingCenter } from 'rcc-errorhandling';
import { DebugEventBus } from 'rcc-debugcenter';
import { PipelineDebugLogger } from '../../modules/pipeline/utils/debug-logger.js';

/**
 * Service configuration interface
 */
export interface ServiceConfig {
  singleton?: boolean;
  factory?: () => any;
  dependencies?: string[];
  lazy?: boolean;
}

/**
 * Service registry for managing all core services
 */
export class ServiceRegistry {
  private static instance: ServiceRegistry;
  private container: ServiceContainer;

  private constructor() {
    this.container = ServiceContainer.getInstance();
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): ServiceRegistry {
    if (!ServiceRegistry.instance) {
      ServiceRegistry.instance = new ServiceRegistry();
    }
    return ServiceRegistry.instance;
  }

  /**
   * Initialize core services
   */
  public initializeCoreServices(): void {
    this.container.register(
      ServiceTokens.ERROR_HANDLING_CENTER,
      () => new ErrorHandlingCenter(),
      ServiceLifetime.Singleton
    );

    this.container.register(
      ServiceTokens.DEBUG_EVENT_BUS,
      () => DebugEventBus.getInstance(),
      ServiceLifetime.Singleton
    );

    this.container.register(
      ServiceTokens.PIPELINE_DEBUG_LOGGER,
      () => new PipelineDebugLogger(null, {
        enableConsoleLogging: true,
        enableDebugCenter: true
      }),
      ServiceLifetime.Singleton
    );

    this.container.register(
      'ServiceRegistry',
      () => this,
      ServiceLifetime.Singleton
    );
  }

  /**
   * Register handler-specific services
   */
  public registerHandlerServices(handlerName: string, config?: any): void {
    const servicePrefix = handlerName.toLowerCase().replace('handler', '');

    // Register request validator
    this.container.register(
      `${servicePrefix}RequestValidator`,
      () => {
        const { RequestValidator } = require('../utils/request-validator.js');
        return new RequestValidator();
      },
      ServiceLifetime.Singleton
    );

    // Register response normalizer
    this.container.register(
      `${servicePrefix}ResponseNormalizer`,
      () => {
        const { ResponseNormalizer } = require('../utils/response-normalizer.js');
        return new ResponseNormalizer();
      },
      ServiceLifetime.Singleton
    );

    // Register streaming manager if enabled
    if (config?.enableStreaming) {
      this.container.register(
        `${servicePrefix}StreamingManager`,
        () => {
          const { StreamingManager } = require('../utils/streaming-manager.js');
          return new StreamingManager(config);
        },
        ServiceLifetime.Singleton
      );
    }
  }

  /**
   * Register converter-specific services
   */
  public registerConverterServices(converterType: string, config?: any): void {
    const servicePrefix = converterType.toLowerCase().replace('converter', '');

    // Register tool registry
    this.container.register(
      `${servicePrefix}ToolRegistry`,
      () => {
        const { ToolRegistry } = require('../../modules/pipeline/modules/llmswitch/utils/tool-registry.js');
        return new ToolRegistry(config);
      },
      ServiceLifetime.Singleton
    );

    // Register schema normalizer
    this.container.register(
      `${servicePrefix}SchemaNormalizer`,
      () => {
        const { SchemaNormalizer } = require('../../modules/pipeline/modules/llmswitch/utils/schema-normalizer.js');
        return new SchemaNormalizer();
      },
      ServiceLifetime.Singleton
    );
  }

  /**
   * Get service from container
   */
  public getService<T = any>(name: string): T | undefined {
    return this.container.get<T>(name);
  }

  /**
   * Check if service exists
   */
  public hasService(name: string): boolean {
    return this.container.has(name);
  }

  /**
   * Create service with configuration
   */
  public createService<T = any>(name: string): T {
    return this.container.create<T>(name);
  }

  /**
   * Register a new service
   */
  public registerService(name: string, config: ServiceConfig): void {
    if (typeof config.factory !== 'function') {
      throw new Error(`Service factory must be provided when registering ${name}`);
    }
    const lifetime = config.singleton === false ? ServiceLifetime.Transient : ServiceLifetime.Singleton;
    this.container.register(name, config.factory, lifetime);
  }

  /**
   * Get service container for advanced operations
   */
  public getContainer(): ServiceContainer {
    return this.container;
  }

  /**
   * Clear all services (mainly for testing)
   */
  public clear(): void {
    this.container.clear();
    ServiceRegistry.instance = null!;
  }
}
