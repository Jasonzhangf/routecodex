import type {
  ModuleConfig,
  PipelineModule
} from '../../modules/pipeline/interfaces/pipeline-interfaces.js';
import type { ModuleDependencies } from '../../modules/pipeline/types/module.types.js';
import type { SharedPipelineRequest, SharedPipelineResponse } from '../../modules/pipeline/types/shared-dtos.js';
import type { UnknownObject } from '../../modules/pipeline/types/common-types.js';
import { CompatibilityManager } from './compatibility-manager.js';
import { resolveCompatibilityModuleTypes } from './standard-compatibility-utils.js';
import type { CompatibilityModuleConfig } from './compatibility-factory.js';
// Ensure built-in compatibility submodules (legacy path) register with the factory
import './index.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Standard V2 Compatibility module
 * - Always present in pipeline
 * - Loads and applies provider-specific compatibility submodule(s) ONLY when explicitly configured
 * - No guessing, no fallback
 */
export class StandardCompatibility implements PipelineModule {
  public readonly id: string;
  public readonly type = 'compatibility';
  public readonly config: ModuleConfig;
  private readonly deps: ModuleDependencies;
  private manager: CompatibilityManager | null = null;
  private loadedModuleIds: string[] = [];
  private isReady = false;
  private injectedConfig: Record<string, unknown> | null = null;

  constructor(config: ModuleConfig, dependencies: ModuleDependencies) {
    this.id = `compatibility-${Date.now()}`;
    this.config = config;
    this.deps = dependencies;
  }

  public async initialize(): Promise<void> {
    this.manager = new CompatibilityManager(this.deps);
    await this.manager.initialize();

    try {
      const cc = this.getActiveConfig();
      const moduleCfg: Record<string, unknown> =
        isRecord(cc.moduleConfig) ? cc.moduleConfig : {};
      const providerType: string =
        typeof cc.providerType === 'string' && cc.providerType.trim()
          ? cc.providerType.trim()
          : 'generic';
      const moduleTypes = resolveCompatibilityModuleTypes(cc);
      if (moduleTypes.length === 0) {
        this.deps.logger?.logModule(this.id, 'compatibility-skipped', { reason: 'no-modules-declared' });
      }
      for (const moduleType of moduleTypes) {
        const createCfg: CompatibilityModuleConfig = {
          id: `${moduleType}-${Date.now()}`,
          type: moduleType,
          providerType,
          enabled: true,
          priority: 1,
          config: moduleCfg
        };
        const moduleId = await this.manager.createModule(createCfg);
        this.loadedModuleIds.push(moduleId);
        this.deps.logger?.logModule(this.id, 'module-loaded', { moduleId, moduleType, providerType });
      }
      this.isReady = true;
    } catch (error) {
      this.deps.logger?.logError?.(error as Error, { component: 'StandardCompatibility', stage: 'initialize' });
      throw error;
    }
  }

  // 新增：配置注入/读取（V2 调用，V1 不调用不影响）
  public setConfig(cfg: unknown): void {
    this.injectedConfig = isRecord(cfg) ? cfg : null;
  }

  public getConfig(): unknown {
    return this.getActiveConfig();
  }

  public async cleanup(): Promise<void> {
    // No specific cleanup required; manager will be GC'ed.
    this.isReady = false;
  }

  public get isInitialized(): boolean { return this.isReady; }

  private async applyAll(request: UnknownObject, requestId: string): Promise<UnknownObject> {
    if (!this.manager || this.loadedModuleIds.length === 0) {
      return request;
    }
    let cur = request;
    for (const mid of this.loadedModuleIds) {
      cur = await this.manager.processRequest(mid, cur, undefined);
      this.deps.logger?.logModule(this.id, 'compat-applied', { moduleId: mid, requestId });
    }
    return cur;
  }

  private async applyAllResponse(response: UnknownObject, requestId: string): Promise<UnknownObject> {
    if (!this.manager || this.loadedModuleIds.length === 0) {
      return response;
    }
    let cur = response;
    for (const mid of this.loadedModuleIds) {
      cur = await this.manager.processResponse(mid, cur, undefined);
      this.deps.logger?.logModule(this.id, 'compat-applied-response', { moduleId: mid, requestId });
    }
    return cur;
  }

  public async processIncoming(request: SharedPipelineRequest): Promise<SharedPipelineRequest> {
    if (!this.isReady) {
      throw new Error('StandardCompatibility not initialized');
    }
    const reqId = request?.route?.requestId || 'unknown';
    const inPayload = isRecord(request.data) ? request.data : {};
    const outPayload = await this.applyAll(inPayload, reqId);
    return { ...request, data: outPayload };
  }

  public async processOutgoing(response: SharedPipelineResponse): Promise<SharedPipelineResponse> {
    if (!this.isReady) {
      throw new Error('StandardCompatibility not initialized');
    }
    const reqId = typeof response.metadata?.requestId === 'string' ? response.metadata.requestId : 'unknown';
    const inPayload = isRecord(response.data) ? response.data : {};
    const outPayload = await this.applyAllResponse(inPayload, reqId);
    return { ...response, data: outPayload };
  }

  private getActiveConfig(): Record<string, unknown> {
    if (this.injectedConfig) {
      return this.injectedConfig;
    }
    return isRecord(this.config.config) ? this.config.config : {};
  }
}
