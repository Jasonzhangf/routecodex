/**
 * GLM兼容模块导出
 */

import type { ModuleDependencies } from '../../../modules/pipeline/types/module.types.js';
import { CompatibilityModuleFactory } from '../compatibility-factory.js';
import { GLMCompatibility } from './glm-compatibility.js';

// 注册GLM模块类型到工厂
// - 标准模块名：'glm'
// - 历史别名：'glm-compatibility'（旧配置与文档中使用）
CompatibilityModuleFactory.registerModuleType('glm', GLMCompatibility);
CompatibilityModuleFactory.registerModuleType('glm-compatibility', GLMCompatibility);

// 导出模块和组件
export { GLMCompatibility } from './glm-compatibility.js';
export { GLMFieldMappingProcessor } from './field-mapping/field-mapping-processor.js';
export { iFlowToolCleaningHook as GLMToolCleaningHook } from './hooks/glm-tool-cleaning-hook.js';
export { GLMRequestValidationHook } from './hooks/glm-request-validation-hook.js';
export { GLMResponseValidationHook } from './hooks/glm-response-validation-hook.js';
export { GLMResponseNormalizationHook } from './hooks/glm-response-normalization-hook.js';

/**
 * GLM兼容模块工厂函数
 * 提供便捷的创建方式
 */
export function createGLMCompatibilityModule(
  dependencies: ModuleDependencies,
  config?: {
    id?: string;
    profileId?: string;
  }
) {
  const module = new GLMCompatibility(dependencies);

  return {
    module,
    initialize: () => module.initialize(),
    processIncoming: (request: any, context: any) => module.processIncoming(request, context),
    processOutgoing: (response: any, context: any) => module.processOutgoing(response, context),
    cleanup: () => module.cleanup()
  };
}
