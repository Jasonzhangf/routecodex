/**
 * GLM兼容模块导出
 */

import type { ModuleDependencies } from '../../../modules/pipeline/types/module.types.js';
import type { CompatibilityContext } from '../compatibility-interface.js';
import type { UnknownObject } from '../../../modules/pipeline/types/common-types.js';
import { GLMCompatibility, type GLMCompatibilityConfig } from './glm-compatibility.js';

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
  config?: GLMCompatibilityConfig
) {
  const module = new GLMCompatibility(dependencies);
  if (config) {
    module.setConfig(config);
  }

  return {
    module,
    initialize: () => module.initialize(),
    processIncoming: (request: UnknownObject, context: CompatibilityContext) => module.processIncoming(request, context),
    processOutgoing: (response: UnknownObject, context: CompatibilityContext) => module.processOutgoing(response, context),
    cleanup: () => module.cleanup()
  };
}
