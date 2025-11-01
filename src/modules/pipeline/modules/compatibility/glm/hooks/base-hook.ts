import type { CompatibilityContext } from '../../compatibility-interface.js';
import type { UnknownObject } from '../../../../../../types/common-types.js';
import type { ModuleDependencies } from '../../../../../../types/module.types.js';

/**
 * Hook基类
 */
export abstract class BaseHook {
  protected dependencies: ModuleDependencies;
  protected isInitialized = false;

  constructor(dependencies: ModuleDependencies) {
    this.dependencies = dependencies;
  }

  abstract get name(): string;
  abstract get stage(): string;
  abstract get priority(): number;

  async initialize(): Promise<void> {
    this.isInitialized = true;
    this.dependencies.logger?.logModule('glm-hook', 'initialized', {
      hookName: this.name,
      stage: this.stage,
      priority: this.priority
    });
  }

  abstract execute(data: UnknownObject, context: CompatibilityContext): Promise<UnknownObject>;

  async cleanup(): Promise<void> {
    this.isInitialized = false;
    this.dependencies.logger?.logModule('glm-hook', 'cleanup-complete', {
      hookName: this.name
    });
  }

  protected checkInitialized(): void {
    if (!this.isInitialized) {
      throw new Error(`Hook ${this.name} is not initialized`);
    }
  }

  protected shouldExecute(data: UnknownObject, context: CompatibilityContext): boolean {
    // 基础检查：只对GLM provider执行
    return context.providerType === 'glm';
  }

  protected logExecution(context: CompatibilityContext, additionalData?: UnknownObject): void {
    this.dependencies.logger?.logModule('glm-hook', 'execute', {
      hookName: this.name,
      stage: this.stage,
      requestId: context.requestId,
      ...additionalData
    });
  }

  protected logError(error: Error, context: CompatibilityContext, additionalData?: UnknownObject): void {
    this.dependencies.logger?.logError?.(error, {
      hookName: this.name,
      stage: this.stage,
      requestId: context.requestId,
      ...additionalData
    });
  }
}