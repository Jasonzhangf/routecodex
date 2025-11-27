import type { CompatibilityModule, CompatibilityContext } from '../compatibility-interface.js';
import type { UnknownObject } from '../../../../../types/common-types.js';
import type { ModuleDependencies } from '../../../../../types/module.types.js';
import { GLMFieldMappingProcessor } from './field-mapping/field-mapping-processor.js';
import { BaseCompatibility } from '../base-compatibility.js';
import {
  processGLMIncoming,
  processGLMOutgoing,
  createGLMProcessConfig,
  type GLMProcessConfig
} from './functions/glm-processor.js';

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
  private processConfig: GLMProcessConfig | null = null; // 函数化处理配置

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
    // 运行时路径：dist/modules/pipeline/modules/provider/v2/compatibility/glm/glm-compatibility.js
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

    // 创建函数化处理配置
    this.processConfig = await createGLMProcessConfig(
      this.dependencies,
      this.injectedConfig,
      this.fieldMappingProcessor,
      this.baseCompat,
      this.id
    );

    this.dependencies.logger?.logModule('glm-compatibility', 'initialized', {
      compatibilityId: this.id,
      providerType: this.providerType
    });
  }

  async processIncoming(request: UnknownObject, context: CompatibilityContext): Promise<UnknownObject> {
    if (!this.processConfig) {
      throw new Error('GLMCompatibility not properly initialized - processConfig missing');
    }

    // 委托给函数化实现，保持接口完全不变
    return await processGLMIncoming(request, this.processConfig, context);
  }

  async processOutgoing(response: UnknownObject, context: CompatibilityContext): Promise<UnknownObject> {
    if (!this.processConfig) {
      throw new Error('GLMCompatibility not properly initialized - processConfig missing');
    }

    // 委托给函数化实现，保持接口完全不变
    return await processGLMOutgoing(response, this.processConfig, context);
  }

  async cleanup(): Promise<void> {
    this.dependencies.logger?.logModule('glm-compatibility', 'cleanup-start', {
      compatibilityId: this.id
    });

    // 清理各个组件（仅映射器）
    await this.fieldMappingProcessor.cleanup();

    // 清理函数化配置
    this.processConfig = null;

    this.dependencies.logger?.logModule('glm-compatibility', 'cleanup-complete', {
      compatibilityId: this.id
    });
  }
}
