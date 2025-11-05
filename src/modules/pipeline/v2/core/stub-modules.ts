/**
 * V2 Stub Modules for Dry-Run
 *
 * Lightweight, no-op module factories used when running V2 in dry-run
 * (shadow) mode. These modules avoid any external I/O and simply
 * pass data through while reporting healthy status.
 */

import type { ModuleFactory, V2ModuleInstance } from './module-registry.js';
import type { ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { UnknownObject } from '../../../../types/common-types.js';

class StubModule implements V2ModuleInstance {
  public readonly id: string;
  public readonly type: string;
  public readonly config: UnknownObject;
  public readonly dependencies: ModuleDependencies;
  public readonly createdAt: number;

  private healthy = true;
  private lastActivity = Date.now();

  constructor(type: string, dependencies: ModuleDependencies, config: UnknownObject = {}) {
    this.id = `${type}-stub-${Math.random().toString(36).slice(2, 8)}`;
    this.type = type;
    this.config = config;
    this.dependencies = dependencies;
    this.createdAt = Date.now();
  }

  async initialize(): Promise<void> {
    // No-op initialization; mark healthy
    this.healthy = true;
  }

  async processIncoming(request: unknown): Promise<unknown> {
    this.lastActivity = Date.now();
    // Pass-through without modification
    return request;
  }

  async processOutgoing(response: unknown): Promise<unknown> {
    this.lastActivity = Date.now();
    // Pass-through without modification
    return response;
  }

  async cleanup(): Promise<void> {
    // No resources to cleanup in stub
    this.healthy = true;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  getMetrics(): UnknownObject {
    return {
      lastActivity: this.lastActivity,
      createdAt: this.createdAt,
      healthy: this.healthy
    } as UnknownObject;
  }
}

function createStubFactory(moduleType: string): ModuleFactory {
  return {
    async create(dependencies: ModuleDependencies): Promise<V2ModuleInstance> {
      return new StubModule(moduleType, dependencies);
    },
    getModuleType(): string { return moduleType; },
    getDependencies(): string[] { return []; }
  };
}

export const StubFactories = {
  providerDefault: () => createStubFactory('provider-default'),
  compatibilityDefault: () => createStubFactory('compatibility-default'),
  llmswitchDefault: () => createStubFactory('llmswitch-default'),
};

