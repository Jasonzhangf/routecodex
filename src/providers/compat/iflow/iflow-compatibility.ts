import type { CompatibilityModule, CompatibilityContext } from '../compatibility-interface.js';
import type { UnknownObject } from '../../../modules/pipeline/types/common-types.js';
import type { ModuleDependencies } from '../../../modules/pipeline/types/module.types.js';
import { iFlowFieldMappingProcessor } from './field-mapping/iflow-field-mapping-processor.js';
import { BaseCompatibility } from '../base-compatibility.js';
import {
  processiFlowIncoming,
  processiFlowOutgoing,
  createiFlowProcessConfig,
  type iFlowProcessConfig
} from './functions/iflow-processor.js';

/**
 * iFlow兼容模块
 * 实现OpenAI格式与iFlow格式之间的双向转换
 */
export class iFlowCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'iflow';
  readonly providerType = 'iflow';

  private fieldMappingProcessor: iFlowFieldMappingProcessor;
  private dependencies: ModuleDependencies;
  private baseCompat: BaseCompatibility | null = null;
  private processConfig: iFlowProcessConfig | null = null; // 函数化处理配置
  private injectedConfig: any = null;

  constructor(dependencies: ModuleDependencies) {
    this.id = `iflow-compatibility-${Date.now()}`;
    this.dependencies = dependencies;

    // 初始化组件（仅字段映射；hooks 留空）
    this.fieldMappingProcessor = new iFlowFieldMappingProcessor(dependencies);
  }

  // 允许配置注入（与GLM模块保持一致）
  setConfig(config: any) {
    try {
      this.injectedConfig = config && typeof config === 'object' ? config : null;
    } catch {
      this.injectedConfig = null;
    }
  }

  getConfig(): any {
    return this.injectedConfig;
  }

  async initialize(): Promise<void> {
    this.dependencies.logger?.logModule('iflow-compatibility', 'initializing', {
      compatibilityId: this.id,
      providerType: this.providerType
    });

    // 初始化各个组件
    await this.fieldMappingProcessor.initialize();

    // 基础兼容：通用逻辑 + iFlow 配置 + hooks
    // 运行时路径：dist/providers/compat/iflow/iflow-compatibility.js
    // JSON 位于同级的 ./config/shape-filters.json
    let shapePath: string | undefined = undefined;
    try {
      const { fileURLToPath } = await import('url');
      const { dirname, join } = await import('path');
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      shapePath = join(__dirname, 'config', 'shape-filters.json');

    } catch { /* keep undefined to be safe */ }

    this.baseCompat = new BaseCompatibility(this.dependencies, {
      providerType: "iflow",
      shapeFilterConfigPath: shapePath || '',
      mapper: {
        mapIncoming: async (req: UnknownObject) => await this.fieldMappingProcessor.mapIncoming(req),
        mapOutgoing: async (res: UnknownObject) => await this.fieldMappingProcessor.mapOutgoing(res)
      },
      // hooks 留空，仅保留快照
    });
    await this.baseCompat.initialize();

    // 创建函数化处理配置
    this.processConfig = await createiFlowProcessConfig(
      this.dependencies,
      this.fieldMappingProcessor,
      this.baseCompat,
      this.id
    );

    this.dependencies.logger?.logModule('iflow-compatibility', 'initialized', {
      compatibilityId: this.id,
      providerType: this.providerType
    });
  }

  async processIncoming(request: UnknownObject, context: CompatibilityContext): Promise<UnknownObject> {
    if (!this.processConfig) {
      throw new Error('iFlowCompatibility not properly initialized - processConfig missing');
    }

    // 委托给函数化实现，保持接口完全不变
    return await processiFlowIncoming(request, this.processConfig, context);
  }

  async processOutgoing(response: UnknownObject, context: CompatibilityContext): Promise<UnknownObject> {
    if (!this.processConfig) {
      throw new Error('iFlowCompatibility not properly initialized - processConfig missing');
    }

    // 委托给函数化实现，保持接口完全不变
    return await processiFlowOutgoing(response, this.processConfig, context);
  }

  async cleanup(): Promise<void> {
    this.dependencies.logger?.logModule('iflow-compatibility', 'cleanup-start', {
      compatibilityId: this.id
    });

    // 清理各个组件（仅映射器）
    await this.fieldMappingProcessor.cleanup();

    // 清理函数化配置
    this.processConfig = null;

    this.dependencies.logger?.logModule('iflow-compatibility', 'cleanup-complete', {
      compatibilityId: this.id
    });
  }
}
