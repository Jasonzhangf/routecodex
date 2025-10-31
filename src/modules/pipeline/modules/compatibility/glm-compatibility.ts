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
// GLM 专用：从 reasoning_content 文本中提取工具调用
import { harvestToolCallsFromText } from './glm-utils/text-to-toolcalls.js';

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

    this.sanitizeRequest(outbound);

    // 方案B：若在最小清理后上下文有效消息为空，则不向上游发送，直接中止并交由上层返回错误
    try {
      const msgs: any[] = Array.isArray((outbound as any).messages) ? ((outbound as any).messages as any[]) : [];
      const nonSystem = msgs.filter((m: any) => m && typeof m === 'object' && String(m.role || '').toLowerCase() !== 'system');
      if (nonSystem.length === 0) {
        const err = new Error('empty_prompt_after_cleanup');
        (err as any).code = 'empty_prompt_after_cleanup';
        (err as any).details = { reason: 'All messages removed by GLM minimal cleanup (empty or invalid)', stage: 'glm-compatibility' };
        throw err;
      }
    } catch (e) {
      throw e;
    }

    return isDto ? { ...dto!, data: outbound } : { data: outbound, route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } } as SharedPipelineRequest;
  }

  async processOutgoing(response: any): Promise<unknown> {
    if (!this.isInitialized) { throw new Error('GLM Compatibility module is not initialized'); }
    // Normalize GLM responses to OpenAI Chat Completions shape when needed
    const isDto = response && typeof response === 'object' && 'data' in response && 'metadata' in response;
    const payload = isDto ? (response as any).data : response;
    const meta = isDto ? (response as any).metadata : undefined;
    const out = this.normalizeResponse(payload, meta);
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

    // 按规范：不再进行“历史工具调用”级别的裁剪（避免模型遗忘与重复调用）。
    // 最小化的 GLM 兼容处理（例如仅保留最后一条 assistant.tool_calls、将该条 content 置为 null、参数规范化）
    // 已在 preflight 阶段完成：sanitizeAndValidateOpenAIChat(payload, { target: 'glm' })。
    // 这里无需再对历史进行删除或裁剪。
  }

  private normalizeResponse(resp: any, metadata?: any): any {
    if (!resp || typeof resp !== 'object') return resp;
    const entryEndpoint = metadata?.entryEndpoint || metadata?.endpoint || '';
    const reasoningPolicy = this.resolveReasoningPolicy(entryEndpoint);
    // Already OpenAI chat completion
    if ('choices' in resp) {
      const r = { ...resp } as Record<string, unknown>;
      // Strip thinking segments from assistant message content (Chat/Anthropic 端口不外泄思考)
      try {
        const choices = Array.isArray((r as any).choices) ? (r as any).choices : [];
        for (const c of choices) {
          const msg = c?.message || {};
          if (typeof msg?.content === 'string') {
            const text = stripThinkingTags(String(msg.content));
            (msg as any).content = text;
          }
          // 在 GLM 兼容层针对 reasoning_content 进行供应商专用的工具提取：
          // 若 message.tool_calls 为空且 reasoning_content 是文本，则抽取其中的工具意图，
          // 将其规范化为 OpenAI tool_calls；剩余文本（去除思考标签后）仅在 content 为空时回填。
          try {
            const hasCalls = Array.isArray((msg as any).tool_calls) && (msg as any).tool_calls.length > 0;
            const rcText = (msg as any).reasoning_content;
            const contentStr = typeof (msg as any).content === 'string' ? String((msg as any).content) : '';
            if (!hasCalls && typeof rcText === 'string' && rcText.trim().length > 0) {
              const { toolCalls, remainder } = harvestToolCallsFromText(String(rcText));
              if (toolCalls.length > 0) {
                // 规范化为 OpenAI tool_calls 结构（arguments 必须为字符串）
                (msg as any).tool_calls = toolCalls.map(tc => ({
                  id: tc.id && String(tc.id).trim() ? String(tc.id) : `call_${Math.random().toString(36).slice(2, 10)}`,
                  type: 'function',
                  function: { name: tc.name, arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}) }
                }));
                // 若 content 为空，则用余下文本（剔除思考标签）回填；否则保留现有 content
                if (!contentStr || !contentStr.trim().length) {
                  (msg as any).content = stripThinkingTags(String(remainder || ''));
                }
                // 统一标记 finish_reason 为 tool_calls（覆盖不一致的 'stop' 等值）
                (c as any).finish_reason = 'tool_calls';
              }
            }
          } catch { /* ignore harvest errors */ }
          // If GLM placed visible text in reasoning_content and content is empty, promote it into content (after stripping thinking tags)
          try {
            // 仅在 chat/completions（strip 策略）下，将 reasoning_content 的可见文本提升为 content；
            // Responses 路径（preserve 策略）保持现状，避免改变原始结构。
            if (reasoningPolicy === 'strip') {
              const rcText = (msg as any).reasoning_content;
              const hasCalls = Array.isArray((msg as any).tool_calls) && (msg as any).tool_calls.length > 0;
              const contentStr = typeof (msg as any).content === 'string' ? String((msg as any).content) : '';
              if (!hasCalls && typeof rcText === 'string' && rcText.trim().length > 0 && (!contentStr || !contentStr.trim().length)) {
                (msg as any).content = stripThinkingTags(String(rcText));
              }
            }
          } catch { /* ignore promote errors */ }
          // Reasoning content handling by endpoint policy
          if (reasoningPolicy === 'strip') {
            if ('reasoning_content' in msg) { delete (msg as any).reasoning_content; }
          }
          // Ensure tool_calls.function.arguments are strings for downstream OpenAI consumers
          if (Array.isArray(msg?.tool_calls)) {
            try {
              msg.tool_calls = msg.tool_calls.map((tc: any) => {
                const t = { ...(tc || {}) };
                if (t.function && typeof t.function === 'object') {
                  const fn = { ...t.function };
                  if (fn.arguments !== undefined && typeof fn.arguments !== 'string') {
                    try { fn.arguments = JSON.stringify(fn.arguments); } catch { fn.arguments = String(fn.arguments); }
                  }
                  t.function = fn;
                }
                return t;
              });
            } catch { /* ignore */ }
            if (msg.tool_calls.length && (msg.content === undefined)) {
              msg.content = null;
            }
          } else if (Array.isArray(msg?.content)) {
            // Flatten content arrays to string when no tool_calls present
            const parts = (msg.content as any[])
              .map((p: any) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : '')))
              .filter((s: string) => !!s.trim());
            msg.content = parts.join('\n');
          } else if (msg.content === undefined || msg.content === null) {
            msg.content = '';
          }
        }
      } catch { /* ignore */ }
      // created_at -> created if needed
      if ((r as any).created === undefined && typeof (r as any).created_at === 'number') {
        (r as any).created = (r as any).created_at;
      }
      // usage.output_tokens -> usage.completion_tokens if missing
      try {
        const u = (r as any).usage;
        if (u && typeof u === 'object' && u.output_tokens !== undefined && u.completion_tokens === undefined) {
          u.completion_tokens = u.output_tokens;
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
      const content = this.flattenAnthropicContent(blocks).map(t => stripThinkingTags(String(t))).join('\n');
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

  // Decide how to handle reasoning content based on endpoint or env policy
  private resolveReasoningPolicy(entryEndpointRaw: string): 'strip' | 'preserve' {
    const policy = String(process.env.RCC_REASONING_POLICY || 'auto').trim().toLowerCase();
    const ep = String(entryEndpointRaw || '').toLowerCase();
    if (policy === 'strip') return 'strip';
    if (policy === 'preserve') return 'preserve';
    // auto: chat/messages strip; responses preserve
    if (ep.includes('/v1/responses')) return 'preserve';
    if (ep.includes('/v1/chat/completions')) return 'strip';
    if (ep.includes('/v1/messages')) return 'strip';
    return 'strip';
  }

  // No text-based tool-call extraction in GLM layer (handled in llmswitch-core OpenAI stage)

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

  // 文本工具提取逻辑已迁移到 llmswitch-core 的 OpenAI 工具阶段；此处不再保留重复实现


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
