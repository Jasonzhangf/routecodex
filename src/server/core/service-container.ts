/**
 * Service Container - IoC Container for Dependency Injection
 * Provides lightweight dependency injection for RouteCodex server components
 */

import { ErrorHandlingCenter } from 'rcc-errorhandling';
import { DebugEventBus } from 'rcc-debugcenter';
import { PipelineDebugLogger } from '../../modules/pipeline/utils/debug-logger.js';

/**
 * Service lifetime enum
 */
export enum ServiceLifetime {
  Transient = 'transient',
  Singleton = 'singleton',
  Scoped = 'scoped'
}

/**
 * Service descriptor interface
 */
export interface ServiceDescriptor {
  token: string;
  factory: () => any;
  lifetime: ServiceLifetime;
  instance?: any;
}

/**
 * Service container configuration
 */
export interface ServiceContainerConfig {
  enableAutoRegistration?: boolean;
  enableCircularDependencyDetection?: boolean;
  defaultLifetime?: ServiceLifetime;
}

/**
 * Lightweight IoC Container
 */
export class ServiceContainer {
  private static instance: ServiceContainer | null = null;
  private services: Map<string, ServiceDescriptor> = new Map();
  private config: ServiceContainerConfig;
  private isDisposed = false;

  constructor(config: ServiceContainerConfig = {}) {
    this.config = {
      enableAutoRegistration: true,
      enableCircularDependencyDetection: true,
      defaultLifetime: ServiceLifetime.Singleton,
      ...config
    };
  }

  /**
   * Get or create the global ServiceContainer instance
   */
  public static getInstance(config: ServiceContainerConfig = {}): ServiceContainer {
    if (!ServiceContainer.instance || ServiceContainer.instance.isDisposed) {
      ServiceContainer.instance = new ServiceContainer(config);
    }
    return ServiceContainer.instance;
  }

  /**
   * Register a service
   */
  register<T>(
    token: string,
    factory: () => T,
    lifetime: ServiceLifetime = this.config.defaultLifetime!
  ): void {
    if (this.isDisposed) {
      throw new Error('Cannot register services on disposed container');
    }

    this.services.set(token, {
      token,
      factory,
      lifetime,
      instance: undefined
    });
  }

  /**
   * Register a singleton instance
   */
  registerInstance<T>(token: string, instance: T): void {
    if (this.isDisposed) {
      throw new Error('Cannot register services on disposed container');
    }

    this.services.set(token, {
      token,
      factory: () => instance,
      lifetime: ServiceLifetime.Singleton,
      instance
    });
  }

  /**
   * Resolve a service
   */
  resolve<T>(token: string): T {
    if (this.isDisposed) {
      throw new Error('Cannot resolve services from disposed container');
    }

    const descriptor = this.getDescriptor(token);

    switch (descriptor.lifetime) {
      case ServiceLifetime.Singleton:
        if (!descriptor.instance) {
          descriptor.instance = this.createInstance(descriptor);
        }
        return descriptor.instance;

      case ServiceLifetime.Transient:
        return this.createInstance(descriptor);

      case ServiceLifetime.Scoped:
        // For now, treat scoped as transient
        return this.createInstance(descriptor);

      default:
        throw new Error(`Unsupported service lifetime: ${descriptor.lifetime}`);
    }
  }

  /**
   * Try resolve service without throwing
   */
  tryResolve<T>(token: string): T | undefined {
    try {
      return this.resolve<T>(token);
    } catch {
      return undefined;
    }
  }

  /**
   * Check if service is registered
   */
  isRegistered(token: string): boolean {
    return this.services.has(token);
  }

  /**
   * Backwards-compatible alias for ServiceRegistry
   */
  has(token: string): boolean {
    return this.isRegistered(token);
  }

  /**
   * Resolve service or undefined (compat API)
   */
  get<T>(token: string): T | undefined {
    return this.tryResolve<T>(token);
  }

  /**
   * Create a fresh instance regardless of lifetime (compat API)
   */
  create<T>(token: string): T {
    if (this.isDisposed) {
      throw new Error('Cannot create services from disposed container');
    }

    const descriptor = this.getDescriptor(token);
    return this.createInstance<T>({ ...descriptor, instance: undefined });
  }

  /**
   * Get all registered service tokens
   */
  getRegisteredTokens(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * Create service instance with dependency detection
   */
  private createInstance<T>(descriptor: ServiceDescriptor): T {
    try {
      if (this.config.enableCircularDependencyDetection) {
        // Simple circular dependency detection could be added here
        // For now, just log the creation
      }

      return descriptor.factory();
    } catch (error) {
      throw new Error(`Failed to create instance of service ${descriptor.token}: ${error}`);
    }
  }

  /**
   * Dispose container and cleanup
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.clear();
    this.isDisposed = true;
  }

  /**
   * Clear registered services without disposing container
   */
  clear(): void {
    // Cleanup singleton instances if they have dispose
    for (const descriptor of this.services.values()) {
      if (descriptor.instance && typeof descriptor.instance.dispose === 'function') {
        try {
          descriptor.instance.dispose();
        } catch (error) {
          console.error(`Error disposing service ${descriptor.token}:`, error);
        }
      }
    }
    this.services.clear();
  }

  /**
   * Get container statistics
   */
  getStats(): {
    totalServices: number;
    singletons: number;
    transients: number;
    scoped: number;
  } {
    let singletons = 0;
    let transients = 0;
    let scoped = 0;

    for (const descriptor of this.services.values()) {
      switch (descriptor.lifetime) {
        case ServiceLifetime.Singleton:
          singletons++;
          break;
        case ServiceLifetime.Transient:
          transients++;
          break;
        case ServiceLifetime.Scoped:
          scoped++;
          break;
      }
    }

    return {
      totalServices: this.services.size,
      singletons,
      transients,
      scoped
    };
  }
  private getDescriptor(token: string): ServiceDescriptor {
    const descriptor = this.services.get(token);
    if (!descriptor) {
      throw new Error(`Service not registered: ${token}`);
    }
    return descriptor;
  }
}

/**
 * Global service container instance
 */
let globalContainer: ServiceContainer | null = null;

export function getGlobalContainer(): ServiceContainer {
  if (!globalContainer) {
    globalContainer = ServiceContainer.getInstance();
  }
  return globalContainer;
}

/**
 * Initialize default services in container
 */
export function initializeDefaultServices(container: ServiceContainer): void {
  // Register core services
  container.register(
    'ErrorHandlingCenter',
    () => new ErrorHandlingCenter(),
    ServiceLifetime.Singleton
  );

  container.register(
    'DebugEventBus',
    () => DebugEventBus.getInstance(),
    ServiceLifetime.Singleton
  );

  container.register(
    'PipelineDebugLogger',
    () => new PipelineDebugLogger(null, {
      enableConsoleLogging: true,
      enableDebugCenter: true
    }),
    ServiceLifetime.Singleton
  );
}

/**
 * Service tokens for type-safe dependency injection
 */
export const ServiceTokens = {
  ERROR_HANDLING_CENTER: 'ErrorHandlingCenter',
  DEBUG_EVENT_BUS: 'DebugEventBus',
  PIPELINE_DEBUG_LOGGER: 'PipelineDebugLogger',
  REQUEST_VALIDATOR: 'RequestValidator',
  RESPONSE_NORMALIZER: 'ResponseNormalizer',
  STREAMING_MANAGER: 'StreamingManager',
  PROTOCOL_DETECTOR: 'ProtocolDetector',
  CONVERSION_ENGINE: 'ConversionEngine',
  PIPELINE_MANAGER: 'PipelineManager',
  ROUTE_POOLS: 'RoutePools',
  ROUTE_META: 'RouteMeta',
  ROUTING_CLASSIFIER: 'RoutingClassifier',
  V2_DRYRUN_MANAGER: 'V2DryRunManager'
} as const;

export type ServiceTokenType = typeof ServiceTokens[keyof typeof ServiceTokens];
