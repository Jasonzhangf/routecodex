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
import { sanitizeAndValidateOpenAIChat } from '../../utils/preflight-validator.js';
import { stripThinkingTags } from '../../../../server/utils/text-filters.js';
import { ErrorContextBuilder, EnhancedRouteCodexError } from '../../../../server/utils/error-context.js';

// Import new modular components
import { CompatibilityModuleFactory } from './compatibility-factory.js';
import { CompatibilityManager } from './compatibility-manager.js';
import { UniversalShapeFilter } from './filters/universal-shape-filter.js';
import { BlacklistSanitizer } from './filters/blacklist-sanitizer.js';

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
  private readonly forceDisableThinking: boolean;
  private readonly compatPolicy: { removeFunctionStrict: boolean; useCoreNormalize: boolean };
  private readonly thinkingDefaults: ThinkingConfig | null;

  constructor(config: ModuleConfig, private dependencies: ModuleDependencies) {
    this.logger = dependencies.logger;
    this.id = `compatibility-glm-${Date.now()}`;
    this.config = config;
    // Initialize compat/thinking policies (parity with legacy GLM compat)
    this.forceDisableThinking = String(process.env.RCC_GLM_DISABLE_THINKING || '0') === '1';
    this.thinkingDefaults = this.normalizeThinkingConfig((this.config as any)?.config?.thinking);
    const compatCfg = (((this.config as any)?.config || {}) as any).compat || {};
    const envRemove = String(process.env.RCC_GLM_REMOVE_FUNCTION_STRICT || '1') !== '0';
    const envNormalize = String(process.env.RCC_GLM_USE_CORE_NORMALIZE || '0') === '1';
    this.compatPolicy = {
      removeFunctionStrict: typeof compatCfg.removeFunctionStrict === 'boolean' ? compatCfg.removeFunctionStrict : envRemove,
      useCoreNormalize: typeof compatCfg.useCoreNormalize === 'boolean' ? compatCfg.useCoreNormalize : envNormalize,
    };
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

    // 对于 Anthropic Messages 等非 GLM Chat 协议（entryEndpoint 包含 /v1/messages），
    // 直接透传，不应用任何 GLM 兼容逻辑，避免错误地重写 tool 结果或提示字段。
    try {
      const meta = (dto?.metadata ?? {}) as any;
      const entryEndpoint = String(
        meta?.entryEndpoint ??
        (requestParam as any)?.entryEndpoint ??
        ''
      ).toLowerCase();
      if (entryEndpoint.includes('/v1/messages')) {
        return isDto ? dto! : requestParam as SharedPipelineRequest;
      }
    } catch { /* best-effort; fallthrough to normal path */ }

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

      // Write compat-pre snapshot (endpoint-aware when available)
      try {
        const entryEndpoint = (dto?.metadata as any)?.entryEndpoint as string | undefined;
        const reqId = context.requestId;
        const { writeCompatSnapshot } = await import('./utils/snapshot-writer.js');
        await writeCompatSnapshot({ phase: 'compat-pre', requestId: reqId, data: request as UnknownObject, entryEndpoint });
      } catch { /* non-blocking */ }

      // Pre-guard: apply provider JSON shape filter directly (配置驱动的字段级规则)，确保关键字段规范（如删除 assistant.tool_calls）
      // 仍在兼容层内执行，符合“唯一入口/最小兼容层”原则
      let preFiltered = request as UnknownObject;
      try {
        const { fileURLToPath } = await import('url');
        const { dirname, join } = await import('path');
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        const shapePath = join(__dirname, 'glm', 'config', 'shape-filters.json');
        const filter = new UniversalShapeFilter({ configPath: shapePath });
        await filter.initialize();
        preFiltered = await filter.applyRequestFilter(preFiltered);
        // Blacklist sanitizer: remove provider-incompatible fields before manager processing
        try {
          const blacklistPath = join(__dirname, 'glm', 'config', 'blacklist-rules.json');
          const bl = new BlacklistSanitizer({ configPath: blacklistPath });
          await bl.initialize();
          preFiltered = await bl.apply(preFiltered);
        } catch { /* ignore blacklist errors */ }
      } catch { /* best-effort; fall back to manager */ }

      // Process using modular compatibility manager（包含字段映射、校验、hooks 等）
      let processedRequest = await this.compatibilityManager.processRequest(this.moduleId, preFiltered, context);

      // Final preflight for GLM: enforce last-user policy and sanitize payload to avoid upstream 1214
      const preflight = sanitizeAndValidateOpenAIChat(processedRequest as any, { target: 'glm', enableTools: true, glmPolicy: 'compat' });
      if (Array.isArray(preflight.issues) && preflight.issues.length) {
        const errs = preflight.issues.filter(i => i.level === 'error');
        if (errs.length) {
          const detail = errs.map(e => e.code).join(',');
          const baseError = new Error(`compat-validation-failed: ${detail}`);
          // Wrap in EnhancedRouteCodexError for unified error pipeline
          throw new EnhancedRouteCodexError(baseError, { module: 'GLMCompatibility', function: 'processIncoming', requestId: context.requestId, additional: { issues: preflight.issues } } as any);
        }
      }
      processedRequest = preflight.payload as UnknownObject;

      // Write compat-post snapshot
      try {
        const entryEndpoint = (dto?.metadata as any)?.entryEndpoint as string | undefined;
        const reqId = context.requestId;
        const { writeCompatSnapshot } = await import('./utils/snapshot-writer.js');
        await writeCompatSnapshot({ phase: 'compat-post', requestId: reqId, data: processedRequest as UnknownObject, entryEndpoint });
      } catch { /* non-blocking */ }

      return isDto
        ? { ...dto!, data: processedRequest }
        : { data: processedRequest, route: { providerId: 'unknown', modelId: 'unknown', requestId: 'unknown', timestamp: Date.now() }, metadata: {}, debug: { enabled: false, stages: {} } } as SharedPipelineRequest;

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

      // 同样地，对于 /v1/messages 路径，GLM 兼容模块不应修改 Anthropic 响应，直接透传
      try {
        const entryEndpoint = String(meta?.entryEndpoint || '').toLowerCase();
        if (entryEndpoint.includes('/v1/messages')) {
          return response;
        }
      } catch { /* ignore and continue */ }

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

      // Write compat-pre snapshot for outgoing
      try {
        const entryEndpoint = (meta?.entryEndpoint as string | undefined) || undefined;
        const reqId = context.requestId;
        const { writeCompatSnapshot } = await import('./utils/snapshot-writer.js');
        await writeCompatSnapshot({ phase: 'compat-pre', requestId: reqId, data: payload as UnknownObject, entryEndpoint });
      } catch { /* ignore */ }

      // Process response using new modular compatibility manager
      const processedResponse = await this.compatibilityManager.processResponse(
        this.moduleId,
        payload as UnknownObject,
        context
      );

      // Write compat-post snapshot for outgoing
      try {
        const entryEndpoint = (meta?.entryEndpoint as string | undefined) || undefined;
        const reqId = context.requestId;
        const { writeCompatSnapshot } = await import('./utils/snapshot-writer.js');
        await writeCompatSnapshot({ phase: 'compat-post', requestId: reqId, data: processedResponse as UnknownObject, entryEndpoint });
      } catch { /* ignore */ }

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

  // Helpers (parity with legacy implementation)
  private normalizeThinkingConfig(value: any): ThinkingConfig | null {
    if (!value || typeof value !== 'object') return null;
    const cfg = value as UnknownObject;
    return {
      enabled: cfg.enabled !== false,
      payload: this.clonePayload(cfg.payload),
      models: this.normalizePerModel(cfg.models)
    };
  }

  private normalizePerModel(value: any): Record<string, ThinkingModelConfig> | null {
    if (!value || typeof value !== 'object') return null;
    const map: Record<string, ThinkingModelConfig> = {};
    for (const [model, raw] of Object.entries(value as UnknownObject)) {
      if (!raw || typeof raw !== 'object') continue;
      const cfg = raw as UnknownObject;
      map[model] = {
        enabled: cfg.enabled !== false,
        payload: this.clonePayload(cfg.payload)
      };
    }
    return Object.keys(map).length ? map : null;
  }

  private clonePayload(payload: any): UnknownObject | null {
    if (!payload || typeof payload !== 'object') return { type: 'enabled' } as any;
    try { return JSON.parse(JSON.stringify(payload)) as UnknownObject; } catch { return { type: 'enabled' } as any; }
  }

  private getModelId(request: Record<string, unknown>): string | null {
    if (request && typeof request === 'object' && request !== null) {
      if ('route' in request && typeof (request as any).route?.modelId === 'string') {
        return (request as any).route.modelId;
      }
      if (typeof (request as any).model === 'string') return (request as any).model;
    }
    return null;
  }

  private resolveReasoningPolicy(entryEndpointRaw: string): 'strip' | 'preserve' {
    const policy = String(process.env.RCC_REASONING_POLICY || 'auto').trim().toLowerCase();
    const ep = String(entryEndpointRaw || '').toLowerCase();
    if (policy === 'strip') return 'strip';
    if (policy === 'preserve') return 'preserve';
    if (ep.includes('/v1/responses')) return 'preserve';
    if (ep.includes('/v1/chat/completions')) return 'strip';
    if (ep.includes('/v1/messages')) return 'strip';
    return 'strip';
  }

  private flattenAnthropicContent(blocks: any[]): string[] {
    const texts: string[] = [];
    for (const block of blocks) {
      if (!block) continue;
      if (typeof block === 'string') { const t = block.trim(); if (t) texts.push(t); continue; }
      if (typeof block === 'object') {
        const type = String((block as any).type || '').toLowerCase();
        if ((type === 'text' || type === 'input_text' || type === 'output_text') && typeof (block as any).text === 'string') {
          const t = (block as any).text.trim(); if (t) texts.push(t); continue;
        }
        if (Array.isArray((block as any).content)) { texts.push(...this.flattenAnthropicContent((block as any).content)); continue; }
        if (typeof (block as any).content === 'string') { const t = (block as any).content.trim(); if (t) texts.push(t); continue; }
      }
    }
    return texts;
  }

  // Added: missing methods (migrated from broken tail section)
  async cleanup(): Promise<void> {
    try {
      this.logger.logModule(this.id, 'cleanup-start');
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
    // Delegated to modular manager: GLM compat does minimal, no-op here
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

  private resolveThinkingPayload(request: Record<string, unknown>): Record<string, unknown> | null {
    if (this.forceDisableThinking) return null;
    const defaults = this.thinkingDefaults;
    if (!defaults || !defaults.enabled) return null;
    const modelId = this.getModelId(request);
    const modelOverride = this.extractModelConfig(modelId);
    if (modelOverride && modelOverride.enabled === false) return null;
    const payloadSource = modelOverride?.payload ?? defaults.payload;
    return this.clonePayload(payloadSource);
  }

  private extractModelConfig(modelId: string | null): ThinkingModelConfig | null {
    if (!modelId) return null;
    const models = this.thinkingDefaults?.models;
    if (models && models[modelId]) return models[modelId];
    return null;
  }

  private isSharedPipelineRequest(obj: any): obj is SharedPipelineRequest {
    return obj && typeof obj === 'object' && 'data' in obj && 'route' in obj;
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
