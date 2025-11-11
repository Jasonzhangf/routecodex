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
    this.dependencies.logger?.logModule('iflow-hook', 'initialized', {
      hookName: this.name,
      stage: this.stage,
      priority: this.priority
    });
  }

  abstract execute(data: UnknownObject, context: CompatibilityContext): Promise<UnknownObject>;

  async cleanup(): Promise<void> {
    this.isInitialized = false;
    this.dependencies.logger?.logModule('iflow-hook', 'cleanup-complete', {
      hookName: this.name
    });
  }

  protected checkInitialized(): void {
    if (!this.isInitialized) {
      throw new Error(`Hook ${this.name} is not initialized`);
    }
  }

  protected shouldExecute(data: UnknownObject, context: CompatibilityContext): boolean {
    // 仅对iFlow执行；当上游未传入上下文时，默认视为iFlow（该Hook仅挂载于iFlow兼容模块内）
    const providerType = (context as any)?.providerType;
    return providerType ? providerType === 'glm' : true;
  }

  protected logExecution(context: CompatibilityContext, additionalData?: UnknownObject): void {
    const reqId = (context as any)?.requestId || 'unknown';
    this.dependencies.logger?.logModule('iflow-hook', 'execute', {
      hookName: this.name,
      stage: this.stage,
      requestId: reqId,
      ...additionalData
    });
  }

  protected logError(error: Error, context: CompatibilityContext, additionalData?: UnknownObject): void {
    const reqId = (context as any)?.requestId || 'unknown';
    this.dependencies.logger?.logError?.(error, {
      hookName: this.name,
      stage: this.stage,
      requestId: reqId,
      ...additionalData
    });
  }
}
