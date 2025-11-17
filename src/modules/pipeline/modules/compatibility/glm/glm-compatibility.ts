import type { CompatibilityModule, CompatibilityContext } from '../compatibility-interface.js';
import type { UnknownObject } from '../../../../../types/common-types.js';
import type { ModuleDependencies } from '../../../../../types/module.types.js';
import { GLMFieldMappingProcessor } from './field-mapping/field-mapping-processor.js';
import { BaseCompatibility } from '../base-compatibility.js';
import { sanitizeAndValidateOpenAIChat } from '../../../utils/preflight-validator.js';

/**
 * GLM兼容模块
 * 实现OpenAI格式与GLM格式之间的双向转换
 */
export class GLMCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'glm';
  readonly providerType = 'glm';

  private fieldMappingProcessor: GLMFieldMappingProcessor;
  private dependencies: ModuleDependencies;
  private baseCompat: BaseCompatibility | null = null;
  private injectedConfig: any = null; // via setConfig
  getConfig(): any { return this.injectedConfig; }

  constructor(dependencies: ModuleDependencies) {
    this.id = `glm-compatibility-${Date.now()}`;
    this.dependencies = dependencies;

    // 初始化组件（仅字段映射；hooks 留空）
    this.fieldMappingProcessor = new GLMFieldMappingProcessor(dependencies);
  }

  // 允许 V2 工厂在创建后注入配置（与V1保持同一配置输入）
  setConfig(config: any) {
    try {
      this.injectedConfig = config && typeof config === 'object' ? config : null;
    } catch { this.injectedConfig = null; }
  }

  async initialize(): Promise<void> {
    this.dependencies.logger?.logModule('glm-compatibility', 'initializing', {
      compatibilityId: this.id,
      providerType: this.providerType
    });

    // 初始化各个组件
    await this.fieldMappingProcessor.initialize();

    // 基础兼容：通用逻辑 + GLM 配置 + hooks
    // 运行时路径：dist/modules/pipeline/modules/compatibility/glm/glm-compatibility.js
    // JSON 位于同级的 ./config/shape-filters.json
    let shapePath: string | undefined = undefined;
    try {
      const { fileURLToPath } = await import('url');
      const { dirname, join } = await import('path');
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      // 支持从配置选择特定形状过滤文件：
      // 优先级：config.config.shapeFilterFile | config.config.shapeProfile | profileId | 默认
      const shapeFile = (() => {
        const cc = (this.injectedConfig && (this.injectedConfig as any).config) ? (this.injectedConfig as any).config : {};
        if (typeof (cc as any).shapeFilterFile === 'string' && (cc as any).shapeFilterFile.trim()) {
          return String((cc as any).shapeFilterFile).trim();
        }
        const profile = (typeof (cc as any).shapeProfile === 'string' && (cc as any).shapeProfile.trim())
          ? String((cc as any).shapeProfile).trim()
          : (typeof (this.injectedConfig as any)?.profileId === 'string' ? String((this.injectedConfig as any).profileId) : '');
        if (profile) {
          // 允许 'strict' → shape-filters.strict.json 这样的命名
          return `shape-filters.${profile}.json`;
        }
        return 'shape-filters.json';
      })();
      shapePath = join(__dirname, 'config', shapeFile);

    } catch { /* keep undefined to be safe */ }

    this.baseCompat = new BaseCompatibility(this.dependencies, {
      providerType: 'glm',
      shapeFilterConfigPath: shapePath || '',
      mapper: {
        mapIncoming: async (req: UnknownObject) => await this.fieldMappingProcessor.mapIncoming(req),
        mapOutgoing: async (res: UnknownObject) => await this.fieldMappingProcessor.mapOutgoing(res)
      },
      // hooks 留空，仅保留快照
    });
    await this.baseCompat.initialize();

    this.dependencies.logger?.logModule('glm-compatibility', 'initialized', {
      compatibilityId: this.id,
      providerType: this.providerType
    });
  }

  async processIncoming(request: UnknownObject, context: CompatibilityContext): Promise<UnknownObject> {
    const reqId = (context as any)?.requestId || 'unknown';
    this.dependencies.logger?.logModule('glm-compatibility', 'processIncoming-start', {
      compatibilityId: this.id,
      requestId: reqId
    });

    try {
      // 仅在 GLM Chat provider 上生效：
      // - providerType !== 'glm'（例如 anthropic/responses 等协议型 provider）时，直接透传，避免错误地将
      //   Anthropic/Responses 形状当作 OpenAI Chat 进行预检与重写。
      const providerFamily = String((context as any)?.providerType || '').toLowerCase();
      if (providerFamily && providerFamily !== 'glm') {
        return request;
      }

      // Extract DTO payload if present
      const isDto = request && typeof request === 'object' && (
        Object.prototype.hasOwnProperty.call(request as Record<string, unknown>, 'data') ||
        Object.prototype.hasOwnProperty.call(request as Record<string, unknown>, 'route') ||
        Object.prototype.hasOwnProperty.call(request as Record<string, unknown>, 'metadata')
      );
      const payloadIn: UnknownObject = (isDto && (request as any).data && typeof (request as any).data === 'object')
        ? ((request as any).data as UnknownObject)
        : (request as UnknownObject);

      let out = await this.baseCompat!.processIncoming(payloadIn as UnknownObject, context);
      // 最后一公里：再次收敛 tools schema，移除 oneOf，统一 shell.command 为 string[]（GLM更友好）
      this.sanitizeGLMToolsSchema(out);
      // 可选预检：严格策略仅在配置启用时生效；不猜，不默认
      try {
        const enabled = Boolean((this as any)?.config?.config?.policy?.preflight === true);
        if (enabled) {
          const pre = sanitizeAndValidateOpenAIChat(out as any, { target: 'glm', enableTools: true, glmPolicy: 'compat' });
          if (Array.isArray(pre.issues) && pre.issues.length) {
            const errs = pre.issues.filter(i => i.level === 'error');
            if (errs.length) {
              const detail = errs.map(e => `${e.code}`).join(',');
              const err: any = new Error(`compat-validation-failed: ${detail}`);
              err.status = 400;
              err.code = 'compat_validation_failed';
              throw err;
            }
            this.dependencies.logger?.logModule('glm-compatibility', 'preflight-warnings', { requestId: reqId, count: pre.issues.length });
          }
          out = pre.payload as UnknownObject;
        }
      } catch (e) {
        throw e;
      }
      this.dependencies.logger?.logModule('glm-compatibility', 'processIncoming-success', { compatibilityId: this.id, requestId: reqId });
      // Re-wrap into DTO if needed
      if (isDto) {
        const dto: any = request || {};
        return { ...dto, data: out } as UnknownObject;
      }
      return out;
    } catch (error) {
      this.dependencies.logger?.logError?.(error as Error, {
        compatibilityId: this.id,
        requestId: reqId,
        stage: 'processIncoming'
      });
      throw error;
    }
  }

  async processOutgoing(response: UnknownObject, context: CompatibilityContext): Promise<UnknownObject> {
    const reqId = (context as any)?.requestId || 'unknown';
    this.dependencies.logger?.logModule('glm-compatibility', 'processOutgoing-start', {
      compatibilityId: this.id,
      requestId: reqId
    });

    try {
      const providerFamily = String((context as any)?.providerType || '').toLowerCase();
      if (providerFamily && providerFamily !== 'glm') {
        return response;
      }

      const out = await this.baseCompat!.processOutgoing(response as UnknownObject, context);
      this.dependencies.logger?.logModule('glm-compatibility', 'processOutgoing-success', { compatibilityId: this.id, requestId: reqId });
      return out;
    } catch (error) {
      this.dependencies.logger?.logError?.(error as Error, {
        compatibilityId: this.id,
        requestId: reqId,
        stage: 'processOutgoing'
      });
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    this.dependencies.logger?.logModule('glm-compatibility', 'cleanup-start', {
      compatibilityId: this.id
    });

    // 清理各个组件（仅映射器）
    await this.fieldMappingProcessor.cleanup();

    this.dependencies.logger?.logModule('glm-compatibility', 'cleanup-complete', {
      compatibilityId: this.id
    });
  }

  // 本地收敛（与字段映射器中的逻辑一致）：去掉 oneOf，统一为数组字符串
  private sanitizeGLMToolsSchema(data: UnknownObject): void {
    try {
      const tools = (data as any)?.tools;
      if (!Array.isArray(tools)) return;
      for (const t of tools) {
        if (!t || typeof t !== 'object') continue;
        const fn = (t as any).function;
        // 移除 OpenAI 扩展字段 strict（GLM 不接受）
        try { if (fn && typeof fn === 'object' && 'strict' in fn) { delete (fn as any).strict; } } catch { /* ignore */ }
        const name = typeof fn?.name === 'string' ? fn.name : undefined;
        const params = fn?.parameters && typeof fn.parameters === 'object' ? fn.parameters : undefined;
        if (!params || !name) continue;
        const props = (params as any).properties && typeof (params as any).properties === 'object' ? (params as any).properties : undefined;
        if (!props) continue;
        if (name === 'shell' && props.command) {
          const cmd = props.command as any;
          if (cmd && typeof cmd === 'object') {
            delete cmd.oneOf;
            cmd.type = 'array';
            cmd.items = { type: 'string' };
            if (typeof cmd.description !== 'string' || !cmd.description) {
              cmd.description = 'Shell command argv tokens. Use ["bash","-lc","<cmd>"] form.';
            }
          } else {
            (props as any).command = {
              description: 'Shell command argv tokens. Use ["bash","-lc","<cmd>"] form.',
              type: 'array',
              items: { type: 'string' }
            };
          }
          if (!Array.isArray((params as any).required)) (params as any).required = [];
          const req: string[] = (params as any).required;
          if (!req.includes('command')) req.push('command');
          if (typeof (params as any).type !== 'string') (params as any).type = 'object';
          if (typeof (params as any).additionalProperties !== 'boolean') (params as any).additionalProperties = false;
        }
      }
    } catch { /* ignore */ }
  }
}
