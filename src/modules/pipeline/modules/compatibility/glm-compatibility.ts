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
            const text = this.stripThinking(String(msg.content));
            // 1) 优先从文本中提取 rcc.tool.v1 包装（模型把工具调用写进了文本）
            let handled = false;
            try {
              const rcc = this.extractRCCToolCallsFromText(text);
              if (rcc && rcc.length) {
                const toolCalls = rcc.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.args }
                }));
                msg.tool_calls = Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : toolCalls;
                msg.content = '';
                handled = true;
              }
            } catch { /* ignore */ }

            // 1.5) 其次尝试提取 apply_patch 统一 diff（*** Begin Patch ... *** End Patch）
            if (!handled) {
              try {
                const patches = this.extractApplyPatchCallsFromText(text);
                if (patches && patches.length) {
                  const toolCalls = patches.map((call) => ({
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: call.args }
                  }));
                  msg.tool_calls = Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : toolCalls;
                  msg.content = '';
                  handled = true;
                }
              } catch { /* ignore */ }
            }

            // 2) 其次尝试旧的 <tool_call> 文本标记提取
            if (!handled) {
              const extracted = this.extractToolCallsFromText(text);
              if (extracted && extracted.length) {
                const toolCalls = extracted.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: { name: call.name, arguments: call.args }
                }));
                msg.tool_calls = Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : toolCalls;
                msg.content = '';
                handled = true;
              } else {
                msg.content = text;
              }
            }
          }
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

  // Extracts function tool calls from textual markup produced by some models
  // Supports patterns:
  // - <tool_call> ... <arg_key>command</arg_key><arg_value>["ls","-la"]</arg_value> ... </tool_call>
  // - Plain segments containing 'shell' and arg_key/arg_value pairs
  private extractToolCallsFromText(text: string): Array<{ id: string; name: string; args: string }> | null {
    try {
      const calls: Array<{ id: string; name: string; args: string }> = [];
      const toolBlocks: string[] = [];
      const toolCallRegex = /<tool_call[\s\S]*?>[\s\S]*?<\/tool_call>/gi;
      let m: RegExpExecArray | null;
      while ((m = toolCallRegex.exec(text)) !== null) {
        toolBlocks.push(m[0]);
      }
      const sources = toolBlocks.length ? toolBlocks : [text];
      const keyValRe = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi;
      for (const block of sources) {
        const nameMatch = block.match(/<tool_name>([\s\S]*?)<\/tool_name>/i);
        let name = (nameMatch && nameMatch[1] && String(nameMatch[1]).trim()) || (block.includes('shell') ? 'shell' : 'tool');
        const argsObj: Record<string, any> = {};
        let kv: RegExpExecArray | null;
        let anyKV = false;
        while ((kv = keyValRe.exec(block)) !== null) {
          const k = String(kv[1] || '').trim();
          let vRaw = String(kv[2] || '').trim();
          if (!k) continue;
          anyKV = true;
          // Attempt to parse JSON (array/object/primitive)
          let val: any = vRaw;
          try { val = JSON.parse(vRaw); } catch { /* keep string */ }
          argsObj[k] = val;
        }
        if (anyKV) {
          let argsStr = '{}';
          try { argsStr = JSON.stringify(argsObj); } catch { argsStr = '{}'; }
          const id = `call_${Math.random().toString(36).slice(2, 10)}`;
          calls.push({ id, name, args: argsStr });
        }
      }
      return calls.length ? calls : null;
    } catch { return null; }
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

  // 尝试从普通文本中提取 rcc.tool.v1 工具调用包装，并转换为 OpenAI tool_calls
  private extractRCCToolCallsFromText(text: string): Array<{ id?: string; name: string; args: string }> | null {
    try {
      if (typeof text !== 'string' || !text) return null;
      const out: Array<{ id?: string; name: string; args: string }> = [];
      const marker = /rcc\.tool\.v1/gi;
      let m: RegExpExecArray | null;
      while ((m = marker.exec(text)) !== null) {
        // 从命中的位置向左回溯到最近的 '{'
        let start = -1;
        for (let i = m.index; i >= 0; i--) {
          const ch = text[i];
          if (ch === '{') { start = i; break; }
          // 小优化：跨越太多字符放弃（避免 O(n^2)），但默认给足 4KB 回溯窗口
          if (m.index - i > 4096) break;
        }
        if (start < 0) continue;

        // 自左向右做“引号感知”的大括号配对，找到 JSON 末尾
        let depth = 0;
        let end = -1;
        let inStr = false;
        let quote: string | null = null;
        let esc = false;
        for (let j = start; j < text.length; j++) {
          const ch = text[j];
          if (inStr) {
            if (esc) { esc = false; continue; }
            if (ch === '\\') { esc = true; continue; }
            if (ch === quote) { inStr = false; quote = null; continue; }
            continue;
          } else {
            if (ch === '"' || ch === '\'') { inStr = true; quote = ch; continue; }
            if (ch === '{') { depth++; }
            else if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
          }
        }
        if (end < 0) continue;

        const jsonStr = text.slice(start, end + 1);
        let obj: any = null;
        try { obj = JSON.parse(jsonStr); } catch { obj = null; }
        if (!obj || typeof obj !== 'object') continue;
        if (String(obj.version || '').toLowerCase() !== 'rcc.tool.v1') continue;
        const tool = obj.tool || {};
        const name = typeof tool.name === 'string' && tool.name.trim() ? tool.name.trim() : undefined;
        if (!name) continue;
        const callId = typeof tool.call_id === 'string' && tool.call_id.trim() ? tool.call_id.trim() : undefined;
        const argsObj = (obj.arguments !== undefined ? obj.arguments : {});
        let argsStr = '{}';
        try { argsStr = JSON.stringify(argsObj ?? {}); } catch { argsStr = '{}'; }
        out.push({ id: callId, name, args: argsStr });

        // 移动游标，避免重复命中同一段落
        marker.lastIndex = end + 1;
      }
      return out.length ? out : null;
    } catch { return null; }
  }

  // 从文本中提取统一 diff 补丁块（*** Begin Patch ... *** End Patch），并映射为 apply_patch 工具调用
  private extractApplyPatchCallsFromText(text: string): Array<{ id?: string; name: string; args: string }> | null {
    try {
      if (typeof text !== 'string' || !text) return null;
      const out: Array<{ id?: string; name: string; args: string }> = [];

      // 支持代码围栏 ```patch ... ``` 或普通文本中直接出现补丁
      const candidates: string[] = [];
      const fenceRe = /```(?:patch)?\s*([\s\S]*?)\s*```/gi;
      let fm: RegExpExecArray | null;
      while ((fm = fenceRe.exec(text)) !== null) {
        const body = fm[1] || '';
        if (/\*\*\*\s+Begin Patch[\s\S]*?\*\*\*\s+End Patch/.test(body)) {
          candidates.push(body);
        }
      }
      // 非围栏：直接在整段文本中检测
      if (/\*\*\*\s+Begin Patch[\s\S]*?\*\*\*\s+End Patch/.test(text)) {
        candidates.push(text);
      }

      const genId = () => `call_${Math.random().toString(36).slice(2, 10)}`;

      for (const src of candidates) {
        // 可能存在多个补丁块，逐个提取
        const pg = /\*\*\*\s+Begin Patch[\s\S]*?\*\*\*\s+End Patch/gm;
        let pm: RegExpExecArray | null;
        while ((pm = pg.exec(src)) !== null) {
          const patch = pm[0];
          if (!patch || patch.length < 32) continue;
          let argsStr = '{}';
          try { argsStr = JSON.stringify({ patch }); } catch { argsStr = '{"patch":""}'; }
          out.push({ id: genId(), name: 'apply_patch', args: argsStr });
        }
      }

      return out.length ? out : null;
    } catch { return null; }
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
