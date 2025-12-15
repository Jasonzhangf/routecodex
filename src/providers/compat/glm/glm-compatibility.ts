import type { CompatibilityModule, CompatibilityContext } from '../compatibility-interface.js';
import type { UnknownObject } from '../../../modules/pipeline/types/common-types.js';
import type { ModuleDependencies } from '../../../modules/pipeline/types/module.types.js';
import { GLMFieldMappingProcessor } from './field-mapping/field-mapping-processor.js';
import { BaseCompatibility } from '../base-compatibility.js';
import {
  processGLMIncoming,
  processGLMOutgoing,
  createGLMProcessConfig,
  type GLMProcessConfig
} from './functions/glm-processor.js';

type ShapeFilterOverrides = {
  shapeFilterFile?: string;
  shapeProfile?: string;
};

export interface GLMCompatibilityConfig extends Record<string, unknown> {
  config?: ShapeFilterOverrides & Record<string, unknown>;
  profileId?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * GLM兼容模块
 * 实现OpenAI格式与GLM格式之间的双向转换
 */
export class GLMCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'chat:glm';
  readonly providerType = 'openai';

  private readonly fieldMappingProcessor: GLMFieldMappingProcessor;
  private readonly dependencies: ModuleDependencies;
  private baseCompat: BaseCompatibility | null = null;
  private injectedConfig: GLMCompatibilityConfig | null = null; // via setConfig
  private processConfig: GLMProcessConfig | null = null; // 函数化处理配置

  getConfig(): GLMCompatibilityConfig | null {
    return this.injectedConfig;
  }

  constructor(dependencies: ModuleDependencies) {
    this.id = `chat-glm-${Date.now()}`;
    this.dependencies = dependencies;

    // 初始化组件（仅字段映射；hooks 留空）
    this.fieldMappingProcessor = new GLMFieldMappingProcessor(dependencies);
  }

  // 允许 V2 工厂在创建后注入配置（与V1保持同一配置输入）
  setConfig(config: unknown): void {
    this.injectedConfig = isRecord(config) ? (config as GLMCompatibilityConfig) : null;
  }

  async initialize(): Promise<void> {
    this.dependencies.logger?.logModule(this.type, 'initializing', {
      compatibilityId: this.id,
      providerType: this.providerType
    });

    // 初始化各个组件
    await this.fieldMappingProcessor.initialize();

    // 基础兼容：通用逻辑 + GLM 配置 + hooks
    // 运行时路径：dist/providers/compat/glm/glm-compatibility.js
    // JSON 位于同级的 ./config/shape-filters.json
    let shapePath: string | undefined;
    try {
      const { fileURLToPath } = await import('url');
      const { dirname, join } = await import('path');
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const shapeFile = this.resolveShapeFilterFile();
      shapePath = join(__dirname, 'config', shapeFile);

    } catch { /* keep undefined to be safe */ }

    this.baseCompat = new BaseCompatibility(this.dependencies, {
      providerType: 'glm',
      shapeFilterConfigPath: shapePath || '',
      mapper: {
        mapIncoming: (req: UnknownObject) => this.fieldMappingProcessor.mapIncoming(req),
        mapOutgoing: (res: UnknownObject) => this.fieldMappingProcessor.mapOutgoing(res)
      },
      // hooks 留空，仅保留快照
    });
    await this.baseCompat.initialize();

    // 创建函数化处理配置
    this.processConfig = await createGLMProcessConfig(
      this.dependencies,
      this.injectedConfig ?? undefined,
      this.fieldMappingProcessor,
      this.baseCompat,
      this.id
    );

    this.dependencies.logger?.logModule(this.type, 'initialized', {
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
    this.dependencies.logger?.logModule(this.type, 'cleanup-start', {
      compatibilityId: this.id
    });

    // 清理各个组件（仅映射器）
    await this.fieldMappingProcessor.cleanup();

    // 清理函数化配置
    this.processConfig = null;

    this.dependencies.logger?.logModule(this.type, 'cleanup-complete', {
      compatibilityId: this.id
    });
  }

  private resolveShapeFilterFile(): string {
    const overrides: ShapeFilterOverrides | undefined = this.injectedConfig?.config;
    const fileOverride = typeof overrides?.shapeFilterFile === 'string'
      ? overrides.shapeFilterFile.trim()
      : '';
    if (fileOverride) {
      return fileOverride;
    }

    const profileOverride = (() => {
      if (typeof overrides?.shapeProfile === 'string' && overrides.shapeProfile.trim()) {
        return overrides.shapeProfile.trim();
      }
      if (typeof this.injectedConfig?.profileId === 'string' && this.injectedConfig.profileId.trim()) {
        return this.injectedConfig.profileId.trim();
      }
      return '';
    })();

    if (profileOverride) {
      return `shape-filters.${profileOverride}.json`;
    }

    return 'shape-filters.json';
  }
}
