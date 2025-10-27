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
import type { UnknownObject, /* LogData */ } from '../../../../types/common-types.js';
import { sanitizeAndValidateOpenAIChat } from '../../utils/preflight-validator.js';
import { stripThinkingTags } from '../../../../server/utils/text-filters.js';

export class GLMCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'glm-compatibility';
  readonly config: ModuleConfig;
  readonly rules: TransformationRule[] = [];

  private isInitialized = false;
  private logger: PipelineDebugLoggerInterface;
  private readonly forceDisableThinking: boolean;
  // Mapping config removed: router layer must not parse/reshape tool arguments.

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.logger = dependencies.logger;
    this.id = `compatibility-glm-${Date.now()}`;
    this.config = config;
    this.forceDisableThinking = process.env.RCC_GLM_DISABLE_THINKING === '1';
    this.thinkingDefaults = this.normalizeThinkingConfig(this.config?.config?.thinking);
  }

  async initialize(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'initializing', { config: this.config });
      this.validateConfig();
      // Tool-mapping disabled: follow CCR approach (no router-level semantic parsing of tool arguments)
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

    // Map OpenAI Chat → GLM request nuances (content flattening; assistant tool_calls → content=null)
    try {
      if (Array.isArray((outbound as any).messages)) {
        (outbound as any).messages = ((outbound as any).messages as any[]).map((m: any) => {
          const msg = { ...(m || {}) };
          const role = typeof msg.role === 'string' ? msg.role : 'user';
          if (role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
            msg.content = null;
          } else if (Array.isArray(msg.content)) {
            const parts = (msg.content as any[])
              .map((p: any) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : '')))
              .filter((s: string) => !!s.trim());
            msg.content = parts.join('\n');
          } else if (msg.content === undefined) {
            msg.content = '';
          }
          return msg;
        });
      }
    } catch { /* keep original on failure */ }

    this.sanitizeRequest(outbound);

    return isDto ? { ...dto!, data: outbound } : { data: outbound, route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } } as SharedPipelineRequest;
  }

  async processOutgoing(response: any): Promise<unknown> {
    if (!this.isInitialized) { throw new Error('GLM Compatibility module is not initialized'); }
    // Normalize GLM responses to OpenAI Chat Completions shape when needed
    const isDto = response && typeof response === 'object' && 'data' in response && 'metadata' in response;
    const payload = isDto ? (response as any).data : response;
    const out = this.normalizeResponse(payload);
    if (isDto) {
      return { ...(response as any), data: out };
    }
    return out;
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

  private sanitizeRequest(payload: UnknownObject): void {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const result = sanitizeAndValidateOpenAIChat(payload, { target: 'glm' });

    if (result.issues.length) {
      this.logger.logModule(this.id, 'glm-preflight-issues', {
        count: result.issues.length,
        issues: result.issues.map((issue) => ({ level: issue.level, code: issue.code }))
      });
    }

    const sanitized = result.payload;
    // Light-touch: overlay sanitized fields but do NOT prune unknown keys
    for (const [key, value] of Object.entries(sanitized)) {
      (payload as UnknownObject)[key] = value as unknown;
    }
  }

  private normalizeResponse(resp: any): any {
    if (!resp || typeof resp !== 'object') return resp;
    // Already OpenAI chat completion
    if ('choices' in resp) {
      const r = { ...resp } as Record<string, unknown>;
      // Strip thinking segments from assistant message content (Chat 端口不外泄思考)
      try {
        const choices = Array.isArray((r as any).choices) ? (r as any).choices : [];
        for (const c of choices) {
          const msg = c?.message || {};
          if (typeof msg?.content === 'string') {
            msg.content = this.stripThinking(String(msg.content));
          }
        }
      } catch { /* ignore */ }
      if (!('object' in r)) {
        r.object = 'chat.completion';
      }
      return r;
    }
    // GLM often returns Anthropic-style message { type, role, content[], stop_reason, usage, id, model, created }
    if ((resp as any).type === 'message' && Array.isArray((resp as any).content)) {
      const blocks = ((resp as any).content as any[]);
      // Collect text blocks into assistant content (after stripping thinking)
      const content = this.flattenAnthropicContent(blocks).map(t => this.stripThinking(t)).join('\n');
      // Map tool_use blocks back to OpenAI tool_calls
      const toolCalls: any[] = [];
      try {
        for (const b of blocks) {
          if (!b || typeof b !== 'object') continue;
          const type = String((b as any).type || '').toLowerCase();
          if (type === 'tool_use') {
            const name = typeof (b as any).name === 'string' ? (b as any).name : undefined;
            // In Anthropic format, input holds the function arguments object
            const input = (b as any).input ?? {};
            if (name) {
              let args = '{}';
              try { args = JSON.stringify(input ?? {}); } catch { args = '{}'; }
              const id = typeof (b as any).id === 'string' && (b as any).id.trim()
                ? (b as any).id
                : `call_${Math.random().toString(36).slice(2, 10)}`;
              toolCalls.push({ id, type: 'function', function: { name, arguments: args } });
            }
          }
        }
      } catch { /* ignore tool_use mapping errors and keep text-only */ }

      const stop = (resp as any).stop_reason || undefined;
      const finish = stop === 'max_tokens' ? 'length' : (stop || (toolCalls.length ? 'tool_calls' : 'stop'));
      const message: Record<string, unknown> = { role: 'assistant', content };
      if (toolCalls.length) {
        (message as any).tool_calls = toolCalls;
      }
      const openai = {
        id: (resp as any).id || `chatcmpl_${Math.random().toString(36).slice(2)}`,
        object: 'chat.completion',
        created: (resp as any).created || Math.floor(Date.now()/1000),
        model: (resp as any).model || 'unknown',
        choices: [ { index: 0, message, finish_reason: finish } ],
        usage: (resp as any).usage || undefined
      } as Record<string, unknown>;
      return openai;
    }
    return resp;
  }

  private flattenAnthropicContent(blocks: any[]): string[] {
    const texts: string[] = [];
    for (const block of blocks) {
      if (!block) continue;
      if (typeof block === 'string') { const t = block.trim(); if (t) texts.push(t); continue; }
      if (typeof block === 'object') {
        const type = String((block as any).type || '').toLowerCase();
        if ((type === 'text' || type === 'input_text' || type === 'output_text') && typeof (block as any).text === 'string') {
          const t = (block as any).text.trim(); if (t) texts.push(t); continue; }
        if (Array.isArray((block as any).content)) {
          texts.push(...this.flattenAnthropicContent((block as any).content));
          continue;
        }
        if (typeof (block as any).content === 'string') { const t = (block as any).content.trim(); if (t) texts.push(t); continue; }
      }
    }
    return texts;
  }

  // Remove <think>...</think> blocks and stray <think> tags
  private stripThinking(text: string): string {
    return stripThinkingTags(String(text));
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
