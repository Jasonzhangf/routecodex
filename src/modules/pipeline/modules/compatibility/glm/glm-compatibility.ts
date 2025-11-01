import type { CompatibilityModule, CompatibilityContext } from '../../compatibility-interface.js';
import type { UnknownObject } from '../../../../../../types/common-types.js';
import type { ModuleDependencies } from '../../../../../../types/module.types.js';
import { GLMFieldMappingProcessor } from './field-mapping/field-mapping-processor.js';
import { GLMToolCleaningHook } from './hooks/glm-tool-cleaning-hook.js';
import { GLMRequestValidationHook } from './hooks/glm-request-validation-hook.js';
import { GLMResponseValidationHook } from './hooks/glm-response-validation-hook.js';
import { GLMResponseNormalizationHook } from './hooks/glm-response-normalization-hook.js';

/**
 * GLM兼容模块
 * 实现OpenAI格式与GLM格式之间的双向转换
 */
export class GLMCompatibility implements CompatibilityModule {
  readonly id: string;
  readonly type = 'glm';
  readonly providerType = 'glm';

  private fieldMappingProcessor: GLMFieldMappingProcessor;
  private toolCleaningHook: GLMToolCleaningHook;
  private requestValidationHook: GLMRequestValidationHook;
  private responseValidationHook: GLMResponseValidationHook;
  private responseNormalizationHook: GLMResponseNormalizationHook;
  private dependencies: ModuleDependencies;

  constructor(dependencies: ModuleDependencies) {
    this.id = `glm-compatibility-${Date.now()}`;
    this.dependencies = dependencies;

    // 初始化组件
    this.fieldMappingProcessor = new GLMFieldMappingProcessor(dependencies);
    this.toolCleaningHook = new GLMToolCleaningHook(dependencies);
    this.requestValidationHook = new GLMRequestValidationHook(dependencies);
    this.responseValidationHook = new GLMResponseValidationHook(dependencies);
    this.responseNormalizationHook = new GLMResponseNormalizationHook(dependencies);
  }

  async initialize(): Promise<void> {
    this.dependencies.logger?.logModule('glm-compatibility', 'initializing', {
      compatibilityId: this.id,
      providerType: this.providerType
    });

    // 初始化各个组件
    await this.fieldMappingProcessor.initialize();
    await this.toolCleaningHook.initialize();
    await this.requestValidationHook.initialize();
    await this.responseValidationHook.initialize();
    await this.responseNormalizationHook.initialize();

    this.dependencies.logger?.logModule('glm-compatibility', 'initialized', {
      compatibilityId: this.id,
      providerType: this.providerType
    });
  }

  async processIncoming(request: UnknownObject, context: CompatibilityContext): Promise<UnknownObject> {
    this.dependencies.logger?.logModule('glm-compatibility', 'processIncoming-start', {
      compatibilityId: this.id,
      requestId: context.requestId
    });

    try {
      // 1. Hook: 工具清洗
      const cleanedRequest = await this.toolCleaningHook.execute(request, context);

      // 2. 标准字段映射
      const mappedRequest = await this.fieldMappingProcessor.mapIncoming(cleanedRequest);

      // 3. Hook: 请求字段校验
      const validatedRequest = await this.requestValidationHook.execute(mappedRequest, context);

      this.dependencies.logger?.logModule('glm-compatibility', 'processIncoming-success', {
        compatibilityId: this.id,
        requestId: context.requestId
      });

      return validatedRequest;
    } catch (error) {
      this.dependencies.logger?.logError?.(error as Error, {
        compatibilityId: this.id,
        requestId: context.requestId,
        stage: 'processIncoming'
      });
      throw error;
    }
  }

  async processOutgoing(response: UnknownObject, context: CompatibilityContext): Promise<UnknownObject> {
    this.dependencies.logger?.logModule('glm-compatibility', 'processOutgoing-start', {
      compatibilityId: this.id,
      requestId: context.requestId
    });

    try {
      // 1. 标准字段映射
      const mappedResponse = await this.fieldMappingProcessor.mapOutgoing(response);

      // 2. Hook: 响应字段校验
      const validatedResponse = await this.responseValidationHook.execute(mappedResponse, context);

      // 3. Hook: 响应标准化
      const normalizedResponse = await this.responseNormalizationHook.execute(validatedResponse, context);

      this.dependencies.logger?.logModule('glm-compatibility', 'processOutgoing-success', {
        compatibilityId: this.id,
        requestId: context.requestId
      });

      return normalizedResponse;
    } catch (error) {
      this.dependencies.logger?.logError?.(error as Error, {
        compatibilityId: this.id,
        requestId: context.requestId,
        stage: 'processOutgoing'
      });
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    this.dependencies.logger?.logModule('glm-compatibility', 'cleanup-start', {
      compatibilityId: this.id
    });

    // 清理各个组件
    await this.fieldMappingProcessor.cleanup();
    await this.toolCleaningHook.cleanup();
    await this.requestValidationHook.cleanup();
    await this.responseValidationHook.cleanup();
    await this.responseNormalizationHook.cleanup();

    this.dependencies.logger?.logModule('glm-compatibility', 'cleanup-complete', {
      compatibilityId: this.id
    });
  }
}