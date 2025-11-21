import type { ModuleConfig } from '../../interfaces/pipeline-interfaces.js';
import type { PipelineModule } from '../../interfaces/pipeline-interfaces.js';
import type { ModuleDependencies } from '../../../../types/module.types.js';
import type { SharedPipelineRequest, SharedPipelineResponse } from '../../../../types/shared-dtos.js';
import type { UnknownObject } from '../../../../types/common-types.js';
import { CompatibilityManager } from './compatibility-manager.js';
// Ensure built-in compatibility submodules (legacy path) register with the factory
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
  private injectedConfig: unknown = undefined;

  constructor(config: ModuleConfig, dependencies: ModuleDependencies) {
    this.id = `compatibility-${Date.now()}`;
    this.config = config;
    this.deps = dependencies;
  }

  public async initialize(): Promise<void> {
    this.manager = new CompatibilityManager(this.deps);
    await this.manager.initialize();

    // 仅保留 legacy 子模块路径：按 moduleType 通过工厂创建子模块（保持 V1 行为）
    try {
      const cc: any = (this.config as any)?.config || {};
      const moduleType: string | undefined = typeof cc.moduleType === 'string' && cc.moduleType.trim() ? String(cc.moduleType).trim() : undefined;
      const moduleCfg: Record<string, unknown> = (cc.moduleConfig && typeof cc.moduleConfig === 'object') ? (cc.moduleConfig as Record<string, unknown>) : {};
      const providerType: string = typeof cc.providerType === 'string' ? String(cc.providerType) : (moduleType || 'generic');

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
    if (!this.manager || this.loadedModuleIds.length === 0) return request;
    let cur = request;
    for (const mid of this.loadedModuleIds) {
      // 根据出口协议（由 providerType 推导）构造上下文，便于子模块按目标协议分支处理
      const ctx = this.buildContextFor(mid, 'incoming', cur, requestId);
      cur = await this.manager.processRequest(mid, cur, ctx as any);
      this.deps.logger?.logModule(this.id, 'compat-applied', { moduleId: mid, requestId });
    }
    return cur;
  }

  private async applyAllResponse(response: UnknownObject, requestId: string): Promise<UnknownObject> {
    if (!this.manager || this.loadedModuleIds.length === 0) return response;
    let cur = response;
    for (const mid of this.loadedModuleIds) {
      const ctx = this.buildContextFor(mid, 'outgoing', cur, requestId);
      cur = await this.manager.processResponse(mid, cur, ctx as any);
      this.deps.logger?.logModule(this.id, 'compat-applied-response', { moduleId: mid, requestId });
    }
    return cur;
  }

  // 计算出口协议，并构建 CompatibilityContext；
  // 规则：
  // - providerType: 'responses'  → targetProtocol: 'openai-responses'
  // - providerType: 'anthropic'  → targetProtocol: 'anthropic-messages'
  // - 其它（openai/glm/qwen/iflow/lmstudio）→ 'openai-chat'
  private buildContextFor(moduleId: string, direction: 'incoming' | 'outgoing', data: UnknownObject, requestId: string) {
    const provType = (() => {
      try { return this.manager?.getModuleInstance(moduleId)?.config?.providerType as string; } catch { return ''; }
    })();
    const providerType = typeof provType === 'string' && provType.trim() ? provType.trim().toLowerCase() : 'openai';
    const targetProtocol = providerType === 'responses'
      ? 'openai-responses'
      : (providerType === 'anthropic' ? 'anthropic-messages' : 'openai-chat');
    const entryEndpoint = (() => {
      try { return String((data as any)?.metadata?.entryEndpoint || (data as any)?.entryEndpoint || ''); } catch { return ''; }
    })();
    const stream = (() => { try { return !!((data as any)?.metadata?.stream === true || (data as any)?.stream === true); } catch { return false; } })();
    return {
      compatibilityId: moduleId,
      profileId: `${providerType}-default`,
      providerType,
      direction,
      stage: direction === 'incoming' ? 'request_processing' : 'response_processing',
      requestId,
      executionId: `exec-${Date.now()}-${Math.random().toString(36).slice(2,9)}`,
      timestamp: Date.now(),
      startTime: Date.now(),
      metadata: {
        dataSize: JSON.stringify(data || {}).length,
        dataKeys: Object.keys((data as any) || {}),
        entryEndpoint,
        stream,
        targetProtocol
      }
    };
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
