/**
 * GLM Compatibility Implementation
 *
 * Normalizes GLM-specific OpenAI-compatible responses so downstream
 * consumers always see text in message.content. GLM often returns
 * reasoning_content while leaving content empty when reasoning is enabled.
 */

import type { CompatibilityModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest } from '../../../../types/shared-dtos.js';
import type { TransformationRule } from '../../interfaces/pipeline-interfaces.js';
import type { PipelineDebugLogger as PipelineDebugLoggerInterface } from '../../interfaces/pipeline-interfaces.js';
import { loadToolMappings } from '../../../../config/tool-mapping-loader.js';
import { ToolMappingExecutor } from '../../utils/tool-mapping-executor.js';
import type { UnknownObject, /* LogData */ } from '../../../../types/common-types.js';

export class GLMCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'glm-compatibility';
  readonly config: ModuleConfig;
  readonly rules: TransformationRule[] = [];

  private isInitialized = false;
  private logger: PipelineDebugLoggerInterface;
  private readonly forceDisableThinking: boolean;
  private readonly useMappingConfig: boolean;
  private mappingExecutor: ToolMappingExecutor | null = null;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.logger = dependencies.logger;
    this.id = `compatibility-glm-${Date.now()}`;
    this.config = config;
    this.forceDisableThinking = process.env.RCC_GLM_DISABLE_THINKING === '1';
    this.useMappingConfig = process.env.RCC_GLM_USE_MAPPING_CONFIG === '1';
    this.thinkingDefaults = this.normalizeThinkingConfig(this.config?.config?.thinking);
  }

  async initialize(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'initializing', { config: this.config });
      this.validateConfig();
      // Minimal mode: do not load tool-mapping by default. Respect explicit opt-in via env only.
      if (this.useMappingConfig) {
        const cfg = loadToolMappings('glm');
        if (cfg) {
          this.mappingExecutor = new ToolMappingExecutor(cfg);
          this.logger.logModule(this.id, 'tool-mapping-config-loaded', { tools: Object.keys(cfg.tools || {}) });
        }
      }
      this.isInitialized = true;
      this.logger.logModule(this.id, 'initialized');
    } catch (error) {
      this.logger.logModule(this.id, 'initialization-error', { error });
      throw error;
    }
  }

  async processIncoming(requestParam: any): Promise<SharedPipelineRequest> {
    if (!this.isInitialized) {
      throw new Error('GLM Compatibility module is not initialized');
    }

    const isDto = this.isSharedPipelineRequest(requestParam);
    const dto = isDto ? requestParam as SharedPipelineRequest : null;
    const request = isDto ? dto!.data : requestParam as unknown;

    if (!request || typeof request !== 'object') {
      return isDto ? dto! : { data: request, route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } } as SharedPipelineRequest;
    }

    const outbound = { ...(typeof request === 'object' && request !== null ? request : {}) } as UnknownObject;

    if (!this.forceDisableThinking && typeof outbound === 'object' && outbound !== null && !('thinking' in outbound)) {
      const payload = this.resolveThinkingPayload(outbound);
      if (payload) {
        outbound.thinking = payload;
        this.logger.logModule(this.id, 'thinking-applied', {
          model: this.getModelId(outbound),
          payload
        });
      }
    }

    return isDto ? { ...dto!, data: outbound } : { data: outbound, route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } } as SharedPipelineRequest;
  }

  async processOutgoing(response: any): Promise<unknown> {
    if (!this.isInitialized) { throw new Error('GLM Compatibility module is not initialized'); }
    // Revert to passthrough behavior as requested
    return response;
  }

  async cleanup(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'cleanup-start');
      this.isInitialized = false;
      this.logger.logModule(this.id, 'cleanup-complete');
    } catch (error) {
      this.logger.logModule(this.id, 'cleanup-error', { error });
      throw error;
    }
  }

  async applyTransformations(data: any, _rules: TransformationRule[]): Promise<unknown> {
    // Currently no explicit transformation rules required beyond reasoning_content handling
    return data;
  }

  getStatus(): { id: string; type: string; isInitialized: boolean; ruleCount: number; lastActivity: number } {
    return {
      id: this.id,
      type: this.type,
      isInitialized: this.isInitialized,
      ruleCount: this.rules.length,
      lastActivity: Date.now()
    };
  }

  private validateConfig(): void {
    if (!this.config?.type || this.config.type !== 'glm-compatibility') {
      throw new Error('Invalid GLM compatibility module type configuration');
    }
    this.logger.logModule(this.id, 'config-validation-success', { type: this.config.type });
  }

  private readonly thinkingDefaults: ThinkingConfig | null;

  private resolveThinkingPayload(request: Record<string, unknown>): Record<string, unknown> | null {
    if (this.forceDisableThinking) {
      return null;
    }
    const defaults = this.thinkingDefaults;
    if (!defaults || !defaults.enabled) {
      return null;
    }

    const modelId = this.getModelId(request);
    const modelOverride = this.extractModelConfig(modelId);
    if (modelOverride && modelOverride.enabled === false) {
      return null;
    }

    const payloadSource = modelOverride?.payload ?? defaults.payload;
    return this.clonePayload(payloadSource);
  }

  private getModelId(request: Record<string, unknown>): string | null {
    if (request && typeof request === 'object' && request !== null) {
      if ('route' in request && typeof request.route === 'object' && request.route !== null && 'modelId' in request.route && typeof request.route.modelId === 'string') {
        return request.route.modelId;
      }
      if ('model' in request && typeof request.model === 'string') {
        return request.model;
      }
    }
    return null;
  }

  private normalizeThinkingConfig(value: any): ThinkingConfig | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const cfg = value as UnknownObject;
    return {
      enabled: cfg.enabled !== false,
      payload: this.clonePayload(cfg.payload),
      models: this.normalizePerModel(cfg.models)
    };
  }

  private normalizePerModel(value: any): Record<string, ThinkingModelConfig> | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const map: Record<string, ThinkingModelConfig> = {};
    for (const [model, raw] of Object.entries(value as UnknownObject)) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const cfg = raw as UnknownObject;
      map[model] = {
        enabled: cfg.enabled !== false,
        payload: this.clonePayload(cfg.payload)
      };
    }
    return Object.keys(map).length > 0 ? map : null;
  }

  private extractModelConfig(modelId: string | null): ThinkingModelConfig | null {
    if (!modelId) {
      return null;
    }
    const models = this.thinkingDefaults?.models;
    if (models && models[modelId]) {
      return models[modelId];
    }
    return null;
  }

  private clonePayload(payload: any): UnknownObject | null {
    if (!payload || typeof payload !== 'object') {
      return { type: 'enabled' };
    }
    try {
      return JSON.parse(JSON.stringify(payload)) as UnknownObject;
    } catch {
      return { type: 'enabled' };
    }
  }

  private unwrap(resp: any): any {
    try {
      const d = (resp as UnknownObject)?.data;
      if (d && typeof d === 'object') {
        return d;
      }
      return resp;
    } catch {
      return resp;
    }
  }

  // Heavy extraction of tool calls from content has been removed in minimal mode.

  // Legacy heavy transformations removed: no reconstruction/parsing of tool calls from content.
  // We intentionally trust upstream OpenAI-compatible schemas and only do minimal compatibility.

  /**
   * Type guard for SharedPipelineRequest
   */
  private isSharedPipelineRequest(obj: any): obj is SharedPipelineRequest {
    return obj !== null && 
           typeof obj === 'object' && 
           'data' in obj && 
           'route' in obj &&
           'metadata' in obj &&
           'debug' in obj;
  }
}

interface ThinkingConfig {
  enabled: boolean;
  payload: UnknownObject | null;
  models: Record<string, ThinkingModelConfig> | null;
}

interface ThinkingModelConfig {
  enabled: boolean;
  payload: UnknownObject | null;
}
