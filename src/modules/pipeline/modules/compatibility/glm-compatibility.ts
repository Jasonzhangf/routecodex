/**
 * GLM Compatibility Implementation (New Modular Version)
 *
 * New modular GLM compatibility implementation with Hook system and
 * configuration-driven field mapping. This implementation provides:
 * - Hook-based tool cleaning and validation
 * - Configuration-driven field mapping
 * - Modular architecture for easy maintenance
 * - Transparent interface compatibility
 */

import type { CompatibilityModule, ModuleConfig, ModuleDependencies } from '../../interfaces/pipeline-interfaces.js';
import type { SharedPipelineRequest } from '../../../../types/shared-dtos.js';
import type { TransformationRule } from '../../interfaces/pipeline-interfaces.js';
import type { PipelineDebugLogger as PipelineDebugLoggerInterface } from '../../interfaces/pipeline-interfaces.js';
import type { UnknownObject, /* LogData */ } from '../../../../types/common-types.js';
import type { CompatibilityContext } from './compatibility-interface.js';

// Import new modular components
import { CompatibilityModuleFactory } from './compatibility-factory.js';
import { CompatibilityManager } from './compatibility-manager.js';

// Ensure GLM module is registered
import './glm/index.js';

export class GLMCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'glm-compatibility';
  readonly config: ModuleConfig;
  readonly rules: TransformationRule[] = [];

  private isInitialized = false;
  private logger: PipelineDebugLoggerInterface;
  private compatibilityManager: CompatibilityManager | null = null;
  private moduleId: string | null = null;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.logger = dependencies.logger;
    this.id = `compatibility-glm-${Date.now()}`;
    this.config = config;
  }

  async initialize(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'initializing', { config: this.config });

      // Initialize compatibility manager with new modular architecture
      this.compatibilityManager = new CompatibilityManager(this.dependencies);
      await this.compatibilityManager.initialize();

      // Create GLM compatibility module using factory
      const moduleConfig = {
        id: 'glm-modular',
        type: 'glm',
        providerType: 'glm',
        enabled: true,
        priority: 1,
        profileId: 'glm-standard',
        config: {
          debugMode: true,
          strictValidation: true,
          // Preserve existing thinking config
          thinking: this.config?.config?.thinking,
          // Add new modular features with detailed GLM field mappings
          fieldMappings: {
            // Usage field mappings (GLM -> OpenAI format)
            'usage.prompt_tokens': {
              'targetPath': 'usage.input_tokens',
              'type': 'number',
              'direction': 'incoming',
              'conversion': 'direct'
            },
            'usage.completion_tokens': {
              'targetPath': 'usage.output_tokens',
              'type': 'number',
              'direction': 'incoming',
              'conversion': 'direct'
            },
            'usage.total_tokens': {
              'targetPath': 'usage.total_tokens',
              'type': 'number',
              'direction': 'incoming',
              'conversion': 'direct'
            },

            // Timestamp mappings
            'created_at': {
              'targetPath': 'created',
              'type': 'number',
              'direction': 'both',
              'conversion': 'direct'
            },

            // Reasoning content handling (GLM specific)
            'reasoning_content': {
              'targetPath': 'reasoning',
              'type': 'string',
              'direction': 'both',
              'conversion': 'extract_blocks',
              'nestedExtraction': {
                'patterns': ['<reasoning>', '</reasoning>', '<thinking>', '</thinking>'],
                'stripTags': true
              }
            },

            // Model field mapping
            'model': {
              'targetPath': 'model',
              'type': 'string',
              'direction': 'both',
              'conversion': 'direct'
            },

            // Message structure normalization
            'messages': {
              'targetPath': 'messages',
              'type': 'array',
              'direction': 'both',
              'conversion': 'normalize_structure',
              'arrayRules': {
                'content': {
                  'type': 'string_or_array',
                  'flattenArrays': true,
                  'nullToString': true
                },
                'tool_calls': {
                  'ensureArgumentsString': true,
                  'validateStructure': true
                }
              }
            },

            // Tool calls normalization
            'choices[].message.tool_calls': {
              'targetPath': 'choices[].message.tool_calls',
              'type': 'array',
              'direction': 'both',
              'conversion': 'normalize_tool_calls',
              'nestedRules': {
                'function.arguments': {
                  'type': 'string',
                  'ensureStringified': true,
                  'parseOnError': true
                }
              }
            },

            // Choice structure mapping
            'choices[].finish_reason': {
              'targetPath': 'choices[].finish_reason',
              'type': 'string',
              'direction': 'both',
              'conversion': 'map_values',
              'valueMapping': {
                'stop_sequence': 'stop',
                'max_tokens': 'length',
                'tool_calls': 'tool_calls'
              }
            }
          },
          toolCleaning: {
            maxToolContentLength: 512,
            enableTruncation: true,
            noisePatterns: [
              '<reasoning>',
              '</reasoning>',
              '<thinking>',
              '</thinking>'
            ]
          }
        },
        hookConfig: {
          enabled: true,
          debugMode: true,
          snapshotEnabled: false
        }
      };

      this.moduleId = await this.compatibilityManager.createModule(moduleConfig);

      this.validateConfig();
      this.isInitialized = true;
      this.logger.logModule(this.id, 'initialized', { moduleId: this.moduleId });
    } catch (error) {
      this.logger.logModule(this.id, 'initialization-error', { error });
      throw error;
    }
  }

  async processIncoming(requestParam: any): Promise<SharedPipelineRequest> {
    if (!this.isInitialized) {
      throw new Error('GLM Compatibility module is not initialized');
    }

    if (!this.compatibilityManager || !this.moduleId) {
      throw new Error('GLM Compatibility manager not properly initialized');
    }

    const isDto = this.isSharedPipelineRequest(requestParam);
    const dto = isDto ? requestParam as SharedPipelineRequest : null;
    const request = isDto ? dto!.data : requestParam as unknown;

    if (!request || typeof request !== 'object') {
      return isDto ? dto! : { data: request, route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } } as SharedPipelineRequest;
    }

    try {
      // Create compatibility context
      const context: CompatibilityContext = {
        compatibilityId: this.moduleId,
        profileId: 'glm-standard',
        providerType: 'glm',
        direction: 'incoming',
        stage: 'request_processing',
        requestId: (dto?.route?.requestId as string) || `req_${Date.now()}`,
        executionId: `exec_${Date.now()}`,
        timestamp: Date.now(),
        startTime: Date.now(),
        metadata: {
          dataSize: JSON.stringify(request).length,
          dataKeys: Object.keys(request),
          config: this.config.config
        }
      };

      // Process using new modular compatibility manager
      const processedRequest = await this.compatibilityManager.processRequest(
        this.moduleId,
        request as UnknownObject,
        context
      );

      return isDto ? { ...dto!, data: processedRequest } : { data: processedRequest, route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } } as SharedPipelineRequest;

    } catch (error) {
      this.logger.logModule(this.id, 'process-incoming-error', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async processOutgoing(response: any): Promise<unknown> {
    if (!this.isInitialized) {
      throw new Error('GLM Compatibility module is not initialized');
    }

    if (!this.compatibilityManager || !this.moduleId) {
      throw new Error('GLM Compatibility manager not properly initialized');
    }

    try {
      // Extract response data and metadata
      const isDto = response && typeof response === 'object' && 'data' in response && 'metadata' in response;
      const payload = isDto ? (response as any).data : response;
      const meta = isDto ? (response as any).metadata : undefined;

      // Create compatibility context for response processing
      const context: CompatibilityContext = {
        compatibilityId: this.moduleId,
        profileId: 'glm-standard',
        providerType: 'glm',
        direction: 'outgoing',
        stage: 'response_processing',
        requestId: meta?.requestId || `req_${Date.now()}`,
        executionId: `exec_${Date.now()}`,
        timestamp: Date.now(),
        startTime: Date.now(),
        metadata: {
          dataSize: JSON.stringify(payload).length,
          dataKeys: Object.keys(payload),
          config: this.config.config
        }
      };

      // Process response using new modular compatibility manager
      const processedResponse = await this.compatibilityManager.processResponse(
        this.moduleId,
        payload as UnknownObject,
        context
      );

      // Return response in expected format
      if (isDto) {
        return { ...(response as any), data: processedResponse };
      }
      return processedResponse;

    } catch (error) {
      this.logger.logModule(this.id, 'process-outgoing-error', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'cleanup-start');

      // Cleanup compatibility manager and modules
      if (this.compatibilityManager) {
        await this.compatibilityManager.cleanup();
        this.compatibilityManager = null;
      }

      this.moduleId = null;
      this.isInitialized = false;
      this.logger.logModule(this.id, 'cleanup-complete');
    } catch (error) {
      this.logger.logModule(this.id, 'cleanup-error', { error });
      throw error;
    }
  }

  async applyTransformations(data: any, _rules: TransformationRule[]): Promise<unknown> {
    // Delegated to new modular compatibility manager
    if (!this.compatibilityManager || !this.moduleId) {
      return data;
    }
    return data;
  }

  getStatus(): { id: string; type: string; isInitialized: boolean; ruleCount: number; lastActivity: number } {
    const managerStats = this.compatibilityManager ? this.compatibilityManager.getStats() : {};
    return {
      id: this.id,
      type: this.type,
      isInitialized: this.isInitialized,
      ruleCount: this.rules.length,
      lastActivity: Date.now(),
      moduleId: this.moduleId,
      managerStats
    };
  }

  private validateConfig(): void {
    if (!this.config?.type || this.config.type !== 'glm-compatibility') {
      throw new Error('Invalid GLM compatibility module type configuration');
    }
    this.logger.logModule(this.id, 'config-validation-success', { type: this.config.type });
  }

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

  private async sanitizeRequest(payload: UnknownObject): Promise<void> {
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

    let sanitized = result.payload;
    // Light-touch: overlay sanitized fields but do NOT prune unknown keys
    for (const [key, value] of Object.entries(sanitized)) {
      (payload as UnknownObject)[key] = value as unknown;
    }

    // 可选：使用核心归一化（配置驱动），仅做安全的轻量规范，不做语义改写
    try {
      if (this.compatPolicy.useCoreNormalize) {
        const core = await import('rcc-llmswitch-core/conversion');
        const normalized = (core as any)?.normalizeChatRequest?.(payload as any);
        if (normalized && typeof normalized === 'object') {
          sanitized = normalized as UnknownObject;
          for (const [key, value] of Object.entries(sanitized)) {
            (payload as UnknownObject)[key] = value as unknown;
          }
        }
      }
    } catch { /* ignore */ }

    // 工具文本化规范化由 llmswitch-core 统一处理；GLM 层不再收割 assistant.content，避免重复处理
    // 但为避免 GLM 500（上游对超大/非结构化工具结果文本敏感），做“尾部最小化清理”：
    // 仅针对“最后一对：assistant.tool_calls + 紧随的回合”，在以下场景清理：
    //  - 紧随回合是 assistant 且 content 为工具结果的非结构化文本（包含 rcc.result/exit_code/stdout 等特征），或文本异常膨胀
    try {
      const msgs: any[] = Array.isArray((payload as any).messages) ? ((payload as any).messages as any[]) : [];
      if (msgs.length >= 2) {
        // 查找最后一个含 tool_calls 的 assistant
        let idx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (!m || typeof m !== 'object') {continue;}
          if (String(m.role || '').toLowerCase() !== 'assistant') {continue;}
          if (Array.isArray((m as any).tool_calls) && (m as any).tool_calls.length > 0) { idx = i; break; }
        }
        if (idx >= 0 && idx + 1 < msgs.length) {
          // 只观察紧随的一个回合
          const next = msgs[idx + 1];
          const isToolRole = next && typeof next === 'object' && String(next.role || '').toLowerCase() === 'tool';
          if (!isToolRole) {
            // 非结构化工具结果常见于 assistant.content 文本
            const shouldTrim = (v: unknown): boolean => {
              try {
                if (typeof v !== 'string') {return false;}
                const s = String(v);
                const big = s.length > 8000; // 明显膨胀
                const looksResult = /(\bexit_code\b|\bduration_seconds\b|\bstdout\b|\bstderr\b)/i.test(s)
                  || /\bresult\b\s*:\s*\{/i.test(s)
                  || /\bexecuted\b\s*:\s*\{/i.test(s)
                  || /\bmetadata\b\s*:\s*\{/i.test(s)
                  || /\b\"version\"\s*:\s*\"rcc\.tool\.v1\"/i.test(s);
                return big || looksResult;
              } catch { return false; }
            };
            if (next && typeof next === 'object' && typeof (next as any).content === 'string' && shouldTrim((next as any).content)) {
              (next as any).content = '';
              this.logger.logModule(this.id, 'glm-minimal-tail-clean', { action: 'clear-next-assistant-content', index: idx + 1 });
            }
            // 某些情况下，工具结果被附着在含 tool_calls 的 assistant.content 末尾，也一并清理
            const cur = msgs[idx];
            if (cur && typeof cur === 'object' && typeof (cur as any).content === 'string' && shouldTrim((cur as any).content)) {
              (cur as any).content = '';
              this.logger.logModule(this.id, 'glm-minimal-tail-clean', { action: 'clear-current-assistant-content', index: idx });
            }
          }
        }
      }
    } catch (error) {
      // 快速死亡原则 - 暴露GLM tail清理错误（避免引用未定义变量）
      throw new EnhancedRouteCodexError(error as Error, {
        module: 'GLMCompatibility',
        file: 'src/modules/pipeline/modules/compatibility/glm-compatibility.ts',
        function: 'performMinimalTailCleanup',
        line: ErrorContextBuilder.extractLineNumber(error as Error),
        additional: { operation: 'glm-tail-cleanup' }
      });
    }

    // 删除 GLM 不接受的工具字段（配置驱动，默认开启）
    try {
      if (this.compatPolicy.removeFunctionStrict && Array.isArray((payload as any).tools)) {
        for (const t of ((payload as any).tools as any[])) {
          if (!t || typeof t !== 'object') {continue;}
          const fn = (t as any).function;
          if (fn && typeof fn === 'object' && 'strict' in fn) {
            delete (fn as any).strict;
          }
        }
      }
    } catch { /* ignore */ }

    // 精准清洗：仅清洗“最后一条 role=tool 的内容”——固定模式去噪并限制长度（固定 512 字节，无开关）
    // 目的：保留工具记忆，不删除历史，仅移除容易触发 GLM 500 的噪声/超长文本
    try {
      const msgs: any[] = Array.isArray((payload as any).messages) ? ((payload as any).messages as any[]) : [];
      if (msgs.length > 0) {
        let lastToolIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (!m || typeof m !== 'object') {continue;}
          const role = String((m as any).role || '').toLowerCase();
          if (role === 'tool') { lastToolIdx = i; break; }
        }
        if (lastToolIdx >= 0) {
          const maxLen = 512;
          const badPatterns: RegExp[] = [
            /failed in sandbox/ig,
            /unsupported call/ig,
            /工具调用不可用/ig,
          ];
          const tmsg = msgs[lastToolIdx];
          const c = (tmsg && typeof tmsg.content === 'string') ? String(tmsg.content) : '';
          if (c && typeof c === 'string') {
            let cleaned = c;
            for (const re of badPatterns) {cleaned = cleaned.replace(re, '');}
            // 以 UTF-8 字节为单位进行截断，并在预算内追加提示标记
            const marker = '…[truncated to 512B]';
            const toBytes = (s: string) => Buffer.byteLength(s, 'utf8');
            const sliceUtf8 = (s: string, bytes: number) => {
              if (bytes <= 0) {return '';}
              const buf = Buffer.from(s, 'utf8');
              if (buf.length <= bytes) {return s;}
              const cut = buf.subarray(0, bytes);
              let out = cut.toString('utf8');
              // 保障回转后不超预算
              while (toBytes(out) > bytes) {
                out = out.slice(0, Math.max(0, out.length - 1));
              }
              return out;
            };
            const cleanedBytes = toBytes(cleaned);
            if (cleanedBytes > maxLen) {
              const allowance = Math.max(0, maxLen - toBytes(marker));
              const head = sliceUtf8(cleaned, allowance);
              (tmsg as any).content = head + marker;
            } else {
              (tmsg as any).content = cleaned;
            }
            this.logger.logModule(this.id, 'glm-last-tool-clean', { index: lastToolIdx, originalBytes: c.length, cleanedBytes: cleaned.length, maxLen });
          }
        }
      }
    } catch { /* ignore */ }
  }

  private normalizeResponse(resp: any, metadata?: any): any {
    if (!resp || typeof resp !== 'object') {return resp;}
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
          // 不在 GLM 层进行任何“工具意图抽取/搬运”；由 llmswitch-core OpenAI 阶段统一处理。
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
            } catch (error) {
              // 快速死亡原则 - 暴露GLM工具调用参数序列化错误（避免引用未定义局部变量）
              throw new EnhancedRouteCodexError(error as Error, {
                module: 'GLMCompatibility',
                file: 'src/modules/pipeline/modules/compatibility/glm-compatibility.ts',
                function: 'normalizeResponse',
                line: ErrorContextBuilder.extractLineNumber(error as Error),
                additional: { operation: 'glm-tool-calls-serialization' }
              });
            }
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
      } catch (error) {
        // 快速死亡原则 - 暴露GLM消息标准化错误（避免引用未定义局部变量）
        throw new EnhancedRouteCodexError(error as Error, {
          module: 'GLMCompatibility',
          file: 'src/modules/pipeline/modules/compatibility/glm-compatibility.ts',
          function: 'normalizeResponse',
          line: ErrorContextBuilder.extractLineNumber(error as Error),
          additional: { operation: 'glm-message-normalization' }
        });
      }
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
      } catch (error) {
        // 快速死亡原则 - 暴露GLM usage字段标准化错误
        throw new EnhancedRouteCodexError(error as Error, {
          module: 'GLMCompatibility',
          file: 'src/modules/pipeline/modules/compatibility/glm-compatibility.ts',
          function: 'normalizeResponse',
          line: ErrorContextBuilder.extractLineNumber(error as Error),
          additional: { operation: 'glm-usage-normalization' }
        });
      }
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
          if (!b || typeof b !== 'object') {continue;}
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
      } catch (error) {
        // 快速死亡原则 - 暴露GLM tool_use映射错误
        throw new EnhancedRouteCodexError(error as Error, {
          module: 'GLMCompatibility',
          file: 'src/modules/pipeline/modules/compatibility/glm-compatibility.ts',
          function: 'normalizeResponse',
          line: ErrorContextBuilder.extractLineNumber(error as Error),
          additional: {
            operation: 'glm-tool-use-mapping',
            blocksCount: blocks.length,
            responseType: 'anthropic-message'
          }
        });
      }

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
    if (policy === 'strip') {return 'strip';}
    if (policy === 'preserve') {return 'preserve';}
    // auto: chat/messages strip; responses preserve
    if (ep.includes('/v1/responses')) {return 'preserve';}
    if (ep.includes('/v1/chat/completions')) {return 'strip';}
    if (ep.includes('/v1/messages')) {return 'strip';}
    return 'strip';
  }

  // No text-based tool-call extraction in GLM layer (handled in llmswitch-core OpenAI stage)

  private flattenAnthropicContent(blocks: any[]): string[] {
    const texts: string[] = [];
    for (const block of blocks) {
      if (!block) {continue;}
      if (typeof block === 'string') { const t = block.trim(); if (t) {texts.push(t);} continue; }
      if (typeof block === 'object') {
        const type = String((block as any).type || '').toLowerCase();
        if ((type === 'text' || type === 'input_text' || type === 'output_text') && typeof (block as any).text === 'string') {
          const t = (block as any).text.trim(); if (t) {texts.push(t);} continue; }
        if (Array.isArray((block as any).content)) {
          texts.push(...this.flattenAnthropicContent((block as any).content));
          continue;
        }
        if (typeof (block as any).content === 'string') { const t = (block as any).content.trim(); if (t) {texts.push(t);} continue; }
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
