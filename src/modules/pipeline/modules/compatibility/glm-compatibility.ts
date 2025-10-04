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
import { PipelineDebugLogger } from '../../utils/debug-logger.js';
import { loadToolMappings } from '../../../../config/tool-mapping-loader.js';
import { ToolMappingExecutor } from '../../utils/tool-mapping-executor.js';

export class GLMCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'glm-compatibility';
  readonly config: ModuleConfig;
  readonly rules: TransformationRule[] = [];

  private isInitialized = false;
  private logger: PipelineDebugLogger;
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
      if (this.useMappingConfig) {
        const cfg = loadToolMappings('glm');
        if (cfg) {
          this.mappingExecutor = new ToolMappingExecutor(cfg);
          this.logger.logModule(this.id, 'tool-mapping-config-loaded', { tools: Object.keys(cfg.tools || {}) });
        } else {
          this.logger.logModule(this.id, 'tool-mapping-config-missing');
        }
      }
      this.isInitialized = true;
      this.logger.logModule(this.id, 'initialized');
    } catch (error) {
      this.logger.logModule(this.id, 'initialization-error', { error });
      throw error;
    }
  }

  async processIncoming(requestParam: unknown): Promise<SharedPipelineRequest> {
    if (!this.isInitialized) {
      throw new Error('GLM Compatibility module is not initialized');
    }

    const isDto = requestParam && typeof requestParam === 'object' && 'data' in requestParam && 'route' in requestParam;
    const dto = isDto ? (requestParam as SharedPipelineRequest) : null;
    const request = isDto ? dto!.data : requestParam as Record<string, unknown> | null;

    if (!request || typeof request !== 'object') {
      return isDto ? dto! : { data: request, route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } } as SharedPipelineRequest;
    }

    const outbound = { ...(typeof request === 'object' && request !== null ? request : {}) };

    if (!this.forceDisableThinking && typeof outbound === 'object' && outbound !== null && !('thinking' in outbound)) {
      const payload = this.resolveThinkingPayload(outbound as Record<string, unknown>);
      if (payload) {
        (outbound as Record<string, unknown>).thinking = payload;
        this.logger.logModule(this.id, 'thinking-applied', {
          model: this.getModelId(outbound as Record<string, unknown>),
          payload
        });
      }
    }

    return isDto ? { ...dto!, data: outbound } : { data: outbound, route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } } as SharedPipelineRequest;
  }

  async processOutgoing(response: unknown): Promise<unknown> {
    if (!this.isInitialized) { throw new Error('GLM Compatibility module is not initialized'); }

    try {
      const body = this.unwrap(response);

      if (body && typeof body === 'object' && body !== null && 'choices' in body && Array.isArray(body.choices)) {
        body.choices = body.choices.map((c: unknown, idx: number) => {
          const out = { index: idx, ...(typeof c === 'object' && c !== null ? c : {}) };
          const msg = (typeof out === 'object' && out !== null && 'message' in out && typeof out.message === 'object' && out.message !== null) ? out.message : {} as Record<string, unknown>;
          // If GLM placed content into reasoning_content and left content empty, promote it.
          const rc = typeof (msg as Record<string, unknown>).reasoning_content === 'string' ? (msg as Record<string, unknown>).reasoning_content : '';
          if ((!((msg as Record<string, unknown>).content) || (msg as Record<string, unknown>).content === '') && typeof rc === 'string' && rc.trim()) {
            (msg as Record<string, unknown>).content = rc;
          }
          if ('reasoning_content' in msg) {
            try { delete (msg as Record<string, unknown>).reasoning_content; } catch { /* noop */ }
          }

          // If provider already returned tool_calls, normalize and blank out content
          try {
            if (Array.isArray((msg as Record<string, unknown>).tool_calls) && (msg as Record<string, unknown>).tool_calls.length > 0) {
              (msg as Record<string, unknown>).tool_calls = this.normalizeToolCallsForClient((msg as Record<string, unknown>).tool_calls as unknown[]);
              (msg as Record<string, unknown>).content = '';
              (out as Record<string, unknown>).message = msg;
              return out;
            }

            // Strip private reasoning markers and reconstruct tools
            let contentStr = typeof (msg as Record<string, unknown>).content === 'string' ? (msg as Record<string, unknown>).content : '';
            // Remove <think> blocks and stray tags
            contentStr = this.stripThinkBlocks(typeof contentStr === 'string' ? contentStr : '');
            if (contentStr) {
              const parsed = this.extractInvokeBlocks(contentStr);
              let calls = parsed.calls || [];
              const rest = parsed.rest || '';
              if (Array.isArray(calls) && calls.length) {
                // Keep only the first tool call to satisfy single-tool constraint
                if (calls.length > 1) { calls = [calls[0]]; }
                const reconstructed = calls.map((call, i) => ({
                  id: `call_${Date.now()}_${i}`,
                  type: 'function',
                  function: { name: call.name, arguments: JSON.stringify(call.args) }
                }));
                if (Array.isArray((msg as Record<string, unknown>).tool_calls) && (msg as Record<string, unknown>).tool_calls && (msg as Record<string, unknown>).tool_calls.length) {
                  (msg as Record<string, unknown>).tool_calls = [ ...(msg as Record<string, unknown>).tool_calls, ...reconstructed ];
                } else {
                  (msg as Record<string, unknown>).tool_calls = reconstructed;
                }
                // Normalize tool_calls to client schema (apply_patch -> { input }, shell command array)
                (msg as Record<string, unknown>).tool_calls = this.normalizeToolCallsForClient((msg as Record<string, unknown>).tool_calls as unknown[]);
                // When tool_calls exist, blank out content to avoid leaking markup or stray text
                (msg as Record<string, unknown>).content = '';
              } else if (this.mappingExecutor && this.useMappingConfig) {
                // Try config-driven mapping as a fallback when no calls parsed by built-ins
                try {
                  const mapped = this.mappingExecutor.apply(rest);
                  if (mapped.calls && Array.isArray(mapped.calls) && mapped.calls.length) {
                    const reconstructed = mapped.calls.map((call, i) => ({
                      id: `call_${Date.now()}_${i}`,
                      type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.args) }
                    }));
                    if (Array.isArray((msg as Record<string, unknown>).tool_calls) && (msg as Record<string, unknown>).tool_calls.length) {
                      (msg as Record<string, unknown>).tool_calls = [ ...(msg as Record<string, unknown>).tool_calls, ...reconstructed ];
                    } else {
                      (msg as Record<string, unknown>).tool_calls = reconstructed;
                    }
                    (msg as Record<string, unknown>).tool_calls = this.normalizeToolCallsForClient((msg as Record<string, unknown>).tool_calls as unknown[]);
                    (msg as Record<string, unknown>).content = '';
                  }
                } catch {
                  // ignore mapping errors
                }
              }
            }
          } catch { /* non-blocking */ }

          (out as Record<string, unknown>).message = msg;
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

  async applyTransformations(data: unknown, _rules: TransformationRule[]): Promise<unknown> {
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

  private normalizeThinkingConfig(value: unknown): ThinkingConfig | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const cfg = value as Record<string, unknown>;
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
      const cfg = raw as Record<string, unknown>;
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

  private clonePayload(payload: unknown): Record<string, unknown> | null {
    if (!payload || typeof payload !== 'object') {
      return { type: 'enabled' };
    }
    try {
      return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    } catch {
      return { type: 'enabled' };
    }
  }

  private unwrap(resp: unknown): unknown {
    try {
      const d = (resp as Record<string, unknown>)?.data;
      if (d && typeof d === 'object') {
        return d;
      }
      return resp;
    } catch {
      return resp;
    }
  }

  /**
   * Extract <invoke name="tool"> blocks (including variants like <invoke_plan>)
   * and convert to function call descriptors. Returns remaining content text as rest.
   */
  private extractInvokeBlocks(text: string): { calls: { name: string; args: Record<string, unknown> }[]; rest: string } {
    if (!text || typeof text !== 'string') { return { calls: [], rest: text }; }
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    let rest = text;

    // 1) HTML-like <invoke|function name="..."> ... </...>
    {
      const blockRe = /<(?:(invoke|function)(?:[_\w-]*))\b[^>]*\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/(?:\1)(?:[_\w-]*)>/gi;
      let m: RegExpExecArray | null;
      while ((m = blockRe.exec(text)) !== null) {
        const toolName = (m[2] || m[3] || m[4] || '').trim();
        const inner = m[5] || '';
        const args: Record<string, unknown> = {};
        const paramRe = /<(?:parameter|param|arg)\b[^>]*\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/(?:parameter|param|arg)>/gi;
        let pm: RegExpExecArray | null;
        while ((pm = paramRe.exec(inner)) !== null) {
          const key = (pm[1] || pm[2] || pm[3] || '').trim();
          let valRaw = (pm[4] || '').trim();
          valRaw = this.stripCodeFences(valRaw);
          try {
            const looksJson = /^(\{[\s\S]*\}|\[[\s\S]*\]|"[\s\S]*"|-?\d+(?:\.\d+)?|true|false|null)$/i.test(valRaw);
            args[key] = looksJson ? JSON.parse(valRaw) : valRaw;
          } catch {
            args[key] = valRaw;
          }
        }
        this.normalizeCommonToolArgs(toolName, args);
        calls.push({ name: toolName, args });
        rest = rest.replace(m[0], '').trim();
      }
    }

    // 2) <function_call> {...} wrapper
    {
      const fcRe = /<function_call[^>]*>([\s\S]*?)<\/function_call[^>]*>/gi;
      let m: RegExpExecArray | null;
      while ((m = fcRe.exec(text)) !== null) {
        const innerRaw = this.stripCodeFences((m[1] || '').trim());
        try {
          if (innerRaw) {
            const obj = JSON.parse(innerRaw);
            let name: string | undefined;
            let args: Record<string, unknown> = {};
            if (obj && typeof obj === 'object') {
              if (typeof obj.name === 'string') {
                name = obj.name;
              } else if (obj.function && typeof obj.function.name === 'string') {
                name = obj.function.name;
              }
              const rawArgs = obj.arguments ?? obj.function?.arguments;
              if (typeof rawArgs === 'string') {
                try { args = JSON.parse(rawArgs); } catch { args = { _raw: rawArgs }; }
              } else if (rawArgs && typeof rawArgs === 'object') {
                args = rawArgs;
              }
            }
            if (name) {
              this.normalizeCommonToolArgs(name, args);
              calls.push({ name, args });
              rest = rest.replace(m[0], '').trim();
            }
          }
        } catch { /* ignore malformed */ }
      }
    }

    // 3) [tool_call:name] { json } inline
    {
      const out = this.extractBracketToolCalls(rest);
      for (const c of out.calls) {
        calls.push(c);
      }
      rest = out.rest;
    }

    // 4) <tool_call:name> { json } inline
    {
      const tagRe = /<tool_call:([\w.-]+)\b[^>]*>/gi;
      let m: RegExpExecArray | null;
      while ((m = tagRe.exec(rest)) !== null) {
        const name = (m[1] || '').trim();
        // find JSON starting right after tag
        let idx = m.index + m[0].length;
        // skip whitespace/newlines
        while (idx < rest.length && /\s/.test(rest[idx])) { idx++; }
        let args: Record<string, unknown> = {};
        let endIndex = idx;
        if (idx < rest.length && rest[idx] === '{') {
          const bal = this.extractBalancedJson(rest, idx);
          if (bal.jsonText) {
            try { args = JSON.parse(this.stripCodeFences(bal.jsonText)); } catch { args = { _raw: bal.jsonText }; }
            endIndex = bal.endIndex;
          }
        }
        this.normalizeCommonToolArgs(name, args);
        calls.push({ name, args });
        // remove the tag and its JSON (if any) from remaining
        rest = (rest.slice(0, m.index) + rest.slice(endIndex)).trim();
        // reset regex lastIndex due to string mutation
        tagRe.lastIndex = 0;
      }
    }

    return { calls, rest };
  }

  // Remove wrapping Markdown code fences from parameter payloads
  private stripCodeFences(s: string): string {
    if (!s) {return s;}
    const t = s.trim();
    const fenceRe = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/;
    const m = fenceRe.exec(t);
    if (m) {return m[1];}
    const fenceSingle = /^```([\s\S]*?)```$/;
    const m2 = fenceSingle.exec(t);
    if (m2) {return m2[1];}
    return s;
  }

  // Remove <think>...</think> blocks and any stray <think> or </think> tags
  private stripThinkBlocks(s: string): string {
    if (!s || typeof s !== 'string') {return s as unknown as string;}
    try {
      let out = s.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');
      out = out.replace(/<\/?think\b[^>]*>/gi, '');
      return out;
    } catch {
      return s;
    }
  }

  // Remove noisy artifacts after extracting tool calls; return empty by default
  private sanitizePostToolContent(s: string): string {
    try {
      let out = this.stripThinkBlocks(s || '');
      // Remove common artifact lines (quotes, bullets, stray brackets)
      out = out
        .split(/\r?\n/)
        .filter(line => !/^\s*(?:[>\]\u25CF\u2022\-–—*▌•])\s*$/.test(line))
        .filter(line => !/^\s*Implement\s*\{.*\}\s*$/i.test(line))
        .filter(line => !/^\s*\[?function_call\]?/i.test(line))
        .filter(line => !/^\s*\[?tool_call:/i.test(line))
        .join('\n')
        .trim();
      // Unless explicitly requested, drop any remaining text to ensure tool call is last
      if (process.env.ROUTECODEX_KEEP_TOOL_PREAMBLE === '1') {
        return out;
      }
      return '';
    } catch {
      return '';
    }
  }

  private normalizeCommonToolArgs(toolName: string, args: Record<string, unknown>): void {
    if (toolName === 'shell') {
      const cmd = args.command;
      if (typeof cmd === 'string' && cmd.trim().length > 0) {
        args.command = ['bash', '-lc', cmd];
      } else if (Array.isArray(cmd)) {
        args.command = cmd.map((x: unknown) => String(x));
      }
    }
  }

  // Map tool_calls to client-supported schema
  private normalizeToolCallsForClient(list: unknown[]): unknown[] {
    try {
      return (Array.isArray(list) ? list : []).map((tc: unknown) => {
        const out = { ...(typeof tc === 'object' && tc !== null ? tc : {}) };
        const fn = { ...((typeof out === 'object' && out !== null && 'function' in out) ? (out as Record<string, unknown>).function as Record<string, unknown> : {} as Record<string, unknown>) };
        const name = String((typeof fn === 'object' && fn !== null && 'name' in fn) ? fn.name : '').trim();
        const rawArgs = (typeof fn === 'object' && fn !== null && 'arguments' in fn) ? fn.arguments : undefined;
        let argsObj: Record<string, unknown> = {};
        if (typeof rawArgs === 'string' && rawArgs.length > 0) {
          try { argsObj = JSON.parse(rawArgs); } catch { argsObj = { _raw: rawArgs }; }
        } else if (rawArgs && typeof rawArgs === 'object' && rawArgs !== null) {
          argsObj = rawArgs as Record<string, unknown>;
        }
        if (name === 'apply_patch') {
          let patch = '';
          if (typeof (argsObj?.input) === 'string' && argsObj.input.trim()) { patch = argsObj.input; }
          else if (typeof (argsObj?.patch) === 'string' && argsObj.patch.trim()) { patch = argsObj.patch; }
          else if (typeof (argsObj?.diff) === 'string' && argsObj.diff.trim()) { patch = argsObj.diff; }
          else if (typeof (argsObj?._raw) === 'string' && argsObj._raw.includes('*** Begin Patch')) { patch = argsObj._raw; }
          else if (Array.isArray(argsObj?.command) && String(argsObj.command[0]) === 'apply_patch') { patch = String(argsObj.command.slice(1).join(' ')); }
          (out as Record<string, unknown>).function = { name: 'apply_patch', arguments: JSON.stringify({ input: patch }) };
          return out;
        }
        if (name === 'update_plan') {
          // Ensure required shape: { plan: [] } at minimum
          const plan = Array.isArray((argsObj || {}).plan) ? (argsObj || {}).plan : [];
          const explanation = typeof (argsObj || {}).explanation === 'string' ? (argsObj || {}).explanation : '';
          (out as Record<string, unknown>).function = { name: 'update_plan', arguments: JSON.stringify({ explanation, plan }) };
          return out;
        }
        if (name === 'shell') {
          const cmd = (argsObj || {}).command;
          const tryParseArray = (s: string): string[] | null => { try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(String) : null; } catch { return null; } };
          if (typeof cmd === 'string') {
            const parsed = tryParseArray(cmd);
            (out as Record<string, unknown>).function = { name: 'shell', arguments: JSON.stringify({ command: parsed || ['bash','-lc',cmd] }) };
          } else if (Array.isArray(cmd)) {
            (out as Record<string, unknown>).function = { name: 'shell', arguments: JSON.stringify({ command: cmd.map(String) }) };
          } else {
            (out as Record<string, unknown>).function = { name: 'shell', arguments: JSON.stringify(argsObj || {}) };
          }
          return out;
        }
        (out as Record<string, unknown>).function = { name, arguments: JSON.stringify(argsObj || {}) };
        return out;
      });
    } catch {
      return list;
    }
  }

  private extractBracketToolCalls(input: string): { calls: { name: string; args: Record<string, unknown> }[]; rest: string } {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    let remaining = input;
    const tagRe = /\[tool_call:([\w.-]+)\]/gi;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(input)) !== null) {
      const name = (m[1] || '').trim();
      let idx = m.index + m[0].length;
      while (idx < input.length && /\s/.test(input[idx])) {idx++;}
      if (idx < input.length && input[idx] === '{') {
        // JSON object follows
        const { jsonText, endIndex } = this.extractBalancedJson(input, idx);
        if (jsonText) {
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(this.stripCodeFences(jsonText)); } catch { args = { _raw: jsonText }; }
          this.normalizeCommonToolArgs(name, args);
          calls.push({ name, args });
          const full = input.slice(m.index, endIndex);
          remaining = remaining.replace(full, '').trim();
          continue;
        }
      }
      // No JSON args present; create an empty-args tool_call to avoid leaking as text
      calls.push({ name, args: {} });
      // Remove just the tag occurrence from remaining
      remaining = remaining.replace(m[0], '').trim();
    }
    return { calls, rest: remaining };
  }

  private extractBalancedJson(input: string, startIndex: number): { jsonText: string | null; endIndex: number } {
    let i = startIndex;
    if (input[i] !== '{') {return { jsonText: null, endIndex: startIndex };}
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; i < input.length; i++) {
      const ch = input[i];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = false; continue; }
      } else {
        if (ch === '"') { inString = true; continue; }
        if (ch === '{') { depth++; }
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            const end = i + 1;
            return { jsonText: input.slice(startIndex, end), endIndex: end };
          }
        }
      }
    }
    return { jsonText: null, endIndex: input.length };
  }
}

interface ThinkingConfig {
  enabled: boolean;
  payload: Record<string, unknown> | null;
  models: Record<string, ThinkingModelConfig> | null;
}

interface ThinkingModelConfig {
  enabled: boolean;
  payload: Record<string, unknown> | null;
}
