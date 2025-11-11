import type { ModuleConfig } from '../../interfaces/pipeline-interfaces.js';
import type { PipelineModule } from '../../interfaces/pipeline-interfaces.js';
import type { ModuleDependencies } from '../../../../types/module.types.js';
import type { SharedPipelineRequest, SharedPipelineResponse } from '../../../../types/shared-dtos.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import { CompatibilityManager } from './compatibility-manager.js';
// Ensure built-in compatibility submodules (e.g., 'glm') register with the factory
import './index.js';

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
  private directBase: any = null; // BaseCompatibility when using files-direct mode
  private useDirect = false;
  private injectedConfig: unknown = undefined;

  constructor(config: ModuleConfig, dependencies: ModuleDependencies) {
    this.id = `compatibility-${Date.now()}`;
    this.config = config;
    this.deps = dependencies;
  }

  public async initialize(): Promise<void> {
    this.manager = new CompatibilityManager(this.deps);
    await this.manager.initialize();

    // 兼容两种路径：
    // A) files-direct（推荐）：config.config.files 指定 shapeFilters/fieldMappings 文件，由 StandardCompatibility 直接加载 JSON（不走子模块）
    // B) legacy-submodule：无 files 时，按 moduleType 通过工厂创建子模块（保持 V1 行为）
    try {
      const cc: any = (this.config as any)?.config || {};
      const moduleType: string | undefined = typeof cc.moduleType === 'string' && cc.moduleType.trim() ? String(cc.moduleType).trim() : undefined;
      const moduleCfg: Record<string, unknown> = (cc.moduleConfig && typeof cc.moduleConfig === 'object') ? (cc.moduleConfig as Record<string, unknown>) : {};
      const providerType: string = typeof cc.providerType === 'string' ? String(cc.providerType) : (moduleType || 'generic');
      const files = (cc.files && typeof cc.files === 'object') ? (cc.files as Record<string, unknown>) : {};

      const hasFiles = typeof files['shapeFilters'] === 'string' || typeof files['fieldMappings'] === 'string';
      if (hasFiles) {
        // Direct JSON path mode
        const providerDir = String(providerType).toLowerCase();
        const shapeName = String(files['shapeFilters'] || 'shape-filters.json');
        const mapName = String(files['fieldMappings'] || 'field-mappings.json');
        const { fileURLToPath } = await import('url');
        const { dirname, join, isAbsolute } = await import('path');
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        const shapePath = isAbsolute(shapeName) ? shapeName : join(__dirname, providerDir, 'config', shapeName);
        // field mappings 暂不强制注入到 BaseCompatibility（保留通用过滤路径）；如需，可在 mapper 中加载并应用
        this.directBase = new (await import('./base-compatibility.js')).BaseCompatibility(this.deps, {
          providerType: providerType,
          shapeFilterConfigPath: shapePath,
        });
        await this.directBase.initialize();
        this.useDirect = true;
        this.deps.logger?.logModule(this.id, 'files-direct-loaded', { providerType, shapePath, mapName });
      } else {
        // Legacy submodule path（保持老行为，V1/V2兼容）
        const createCfg: any = {
          id: `${moduleType || 'compat'}-${Date.now()}`,
          type: moduleType || 'passthrough-compatibility',
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
    this.injectedConfig = cfg;
  }

  public getConfig(): unknown {
    return this.injectedConfig ?? (this.config as any)?.config ?? null;
  }

  public async cleanup(): Promise<void> {
    // No specific cleanup required; manager will be GC'ed.
    this.isReady = false;
  }

  public get isInitialized(): boolean { return this.isReady; }

  private async applyAll(request: UnknownObject, requestId: string): Promise<UnknownObject> {
    if (this.useDirect && this.directBase) {
      const out = await this.directBase.processIncoming((request as any).data ?? request, { requestId } as any);
      return { ...request, data: out } as any;
    }
    if (!this.manager || this.loadedModuleIds.length === 0) return request;
    let cur = request;
    for (const mid of this.loadedModuleIds) {
      cur = await this.manager.processRequest(mid, cur, undefined);
      this.deps.logger?.logModule(this.id, 'compat-applied', { moduleId: mid, requestId });
    }
    return cur;
  }

  private async applyAllResponse(response: UnknownObject, requestId: string): Promise<UnknownObject> {
    if (this.useDirect && this.directBase) {
      const out = await this.directBase.processOutgoing((response as any).data ?? response, { requestId } as any);
      return { ...response, data: out } as any;
    }
    if (!this.manager || this.loadedModuleIds.length === 0) return response;
    let cur = response;
    for (const mid of this.loadedModuleIds) {
      cur = await this.manager.processResponse(mid, cur, undefined);
      this.deps.logger?.logModule(this.id, 'compat-applied-response', { moduleId: mid, requestId });
    }
    return cur;
  }

  public async processIncoming(request: SharedPipelineRequest): Promise<SharedPipelineRequest> {
    if (!this.isReady) throw new Error('StandardCompatibility not initialized');
    const reqId = request?.route?.requestId || 'unknown';
    const inPayload = (request && typeof request === 'object' && (request as any).data) ? (request as any).data as UnknownObject : (request as unknown as UnknownObject);
    const outPayload = await this.applyAll(inPayload, reqId);
    return { ...request, data: outPayload } as SharedPipelineRequest;
  }

  public async processOutgoing(response: SharedPipelineResponse): Promise<SharedPipelineResponse> {
    if (!this.isReady) throw new Error('StandardCompatibility not initialized');
    const reqId = (response && (response as any).metadata && typeof (response as any).metadata.requestId === 'string') ? (response as any).metadata.requestId : 'unknown';
    const inPayload = (response && typeof response === 'object' && (response as any).data) ? (response as any).data as UnknownObject : (response as unknown as UnknownObject);
    const outPayload = await this.applyAllResponse(inPayload, reqId);
    return { ...response, data: outPayload } as SharedPipelineResponse;
  }
}
