import type {
  ModuleConfig,
  ModuleDependencies,
  PipelineModule,
  PipelineModuleRegistry,
  ModuleFactory
} from '../interfaces/pipeline-interfaces';

/**
 * Minimal in-memory module registry for pipeline-core (Phase 1)
 * - Allows core/host to register factories for module types
 * - createModule uses the registered factory (no dynamic import yet)
 */
export class ModuleRegistry implements PipelineModuleRegistry {
  private factories = new Map<string, ModuleFactory>();
  private initialized = false;
  private creations = 0;

  registerModule(type: string, factory: ModuleFactory): void {
    const key = String(type || '').toLowerCase();
    this.factories.set(key, factory);
  }

  async createModule(config: ModuleConfig, dependencies: ModuleDependencies): Promise<PipelineModule> {
    const key = String(config?.type || '').toLowerCase();
    const factory = this.factories.get(key);
    if (!factory) {
      throw new Error(`No module factory registered for type: ${config?.type}`);
    }
    const mod = await factory(config, dependencies);
    this.creations += 1;
    return mod;
  }

  getAvailableTypes(): string[] {
    return Array.from(this.factories.keys());
  }

  getStatus(): { isInitialized: boolean; registeredTypes: number; totalCreations: number; activeInstances: number; moduleTypes: string[] } {
    return {
      isInitialized: this.initialized,
      registeredTypes: this.factories.size,
      totalCreations: this.creations,
      activeInstances: 0,
      moduleTypes: this.getAvailableTypes()
    };
  }

  initializeDebugEnhancements(): void {
    this.initialized = true;
  }

  async cleanup(): Promise<void> {
    // no-op for simple registry
  }
}

export default ModuleRegistry;

