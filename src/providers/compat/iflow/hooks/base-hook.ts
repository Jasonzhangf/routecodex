import type { CompatibilityContext } from '../../compatibility-interface.js';
import type { UnknownObject } from '../../../../modules/pipeline/types/common-types.js';
import type { ModuleDependencies } from '../../../../modules/pipeline/types/module.types.js';

/**
 * Hook基类
 */
export abstract class BaseHook {
  protected dependencies: ModuleDependencies;
  protected isInitialized = false;
  protected targetProfile?: string;

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

  setTargetProfile(profileId?: string): void {
    this.targetProfile = profileId?.toLowerCase();
  }

  protected shouldExecute(_data: UnknownObject, context: CompatibilityContext): boolean {
    if (!this.targetProfile) {
      return true;
    }
    const profile = context.profileId?.toLowerCase();
    return profile === this.targetProfile;
  }

  protected logExecution(context: CompatibilityContext, additionalData?: UnknownObject): void {
    const reqId = context.requestId || 'unknown';
    this.dependencies.logger?.logModule('iflow-hook', 'execute', {
      hookName: this.name,
      stage: this.stage,
      requestId: reqId,
      ...additionalData
    });
  }

  protected logError(error: Error, context: CompatibilityContext, additionalData?: UnknownObject): void {
    const reqId = context.requestId || 'unknown';
    this.dependencies.logger?.logError?.(error, {
      hookName: this.name,
      stage: this.stage,
      requestId: reqId,
      ...additionalData
    });
  }
}
