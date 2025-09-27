/**
 * GLM Compatibility Implementation
 *
 * Normalizes GLM-specific OpenAI-compatible responses so downstream
 * consumers always see text in message.content. GLM often returns
 * reasoning_content while leaving content empty when reasoning is enabled.
 */

import type { CompatibilityModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { TransformationRule } from '../../interfaces/pipeline-interfaces.js';
import { PipelineDebugLogger } from '../../utils/debug-logger.js';

export class GLMCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'glm-compatibility';
  readonly config: ModuleConfig;
  readonly rules: TransformationRule[] = [];

  private isInitialized = false;
  private logger: PipelineDebugLogger;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.logger = dependencies.logger as any;
    this.id = `compatibility-glm-${Date.now()}`;
    this.config = config;
    this.thinkingDefaults = this.normalizeThinkingConfig(this.config?.config?.thinking);
  }

  async initialize(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'initializing', { config: this.config });
      this.validateConfig();
      this.isInitialized = true;
      this.logger.logModule(this.id, 'initialized');
    } catch (error) {
      this.logger.logModule(this.id, 'initialization-error', { error });
      throw error;
    }
  }

  async processIncoming(request: any): Promise<any> {
    if (!this.isInitialized) {
      throw new Error('GLM Compatibility module is not initialized');
    }

    if (!request || typeof request !== 'object') {
      return request;
    }

    const outbound = { ...request };

    if (outbound.thinking === undefined) {
      const payload = this.resolveThinkingPayload(outbound);
      if (payload) {
        outbound.thinking = payload;
        this.logger.logModule(this.id, 'thinking-applied', {
          model: this.getModelId(outbound),
          payload
        });
      }
    }

    return outbound;
  }

  async processOutgoing(response: any): Promise<any> {
    if (!this.isInitialized) { throw new Error('GLM Compatibility module is not initialized'); }

    try {
      const body = this.unwrap(response);

      if (body && Array.isArray((body as any).choices)) {
        (body as any).choices = (body as any).choices.map((c: any, idx: number) => {
          const out = { index: idx, ...(c || {}) } as any;
          const msg = out.message || {};
          // If GLM placed content into reasoning_content and left content empty, promote it.
          const rc = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : '';
          if ((!msg.content || msg.content === '') && rc.trim()) {
            msg.content = rc;
          }
          if ('reasoning_content' in msg) {
            try { delete (msg as any).reasoning_content; } catch { /* noop */ }
          }
          out.message = msg;
          return out;
        });
      }

      return response;
    } catch (error) {
      this.logger.logModule(this.id, 'processing-response-error', { error });
      return response;
    }
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

  async applyTransformations(data: any, _rules: TransformationRule[]): Promise<any> {
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

  private resolveThinkingPayload(request: any): Record<string, any> | null {
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

  private getModelId(request: any): string | null {
    if (request?.route?.modelId && typeof request.route.modelId === 'string') {
      return request.route.modelId;
    }
    if (typeof request?.model === 'string') {
      return request.model;
    }
    return null;
  }

  private normalizeThinkingConfig(value: unknown): ThinkingConfig | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const cfg = value as any;
    return {
      enabled: cfg.enabled !== false,
      payload: this.clonePayload(cfg.payload),
      models: this.normalizePerModel(cfg.models)
    };
  }

  private normalizePerModel(value: unknown): Record<string, ThinkingModelConfig> | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const map: Record<string, ThinkingModelConfig> = {};
    for (const [model, raw] of Object.entries(value as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const cfg: any = raw;
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

  private clonePayload(payload: unknown): Record<string, any> | null {
    if (!payload || typeof payload !== 'object') {
      return { type: 'enabled' };
    }
    try {
      return JSON.parse(JSON.stringify(payload));
    } catch {
      return { type: 'enabled' };
    }
  }

  private unwrap(resp: any): any {
    try {
      const d = resp?.data;
      if (d && typeof d === 'object') {
        return d;
      }
      return resp;
    } catch {
      return resp;
    }
  }
}

interface ThinkingConfig {
  enabled: boolean;
  payload: Record<string, any> | null;
  models: Record<string, ThinkingModelConfig> | null;
}

interface ThinkingModelConfig {
  enabled: boolean;
  payload: Record<string, any> | null;
}
