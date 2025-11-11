/**
 * iFlow兼容模块导出
 */

import type { ModuleDependencies } from '../../../../../types/module.types.js';
import { CompatibilityModuleFactory } from '../compatibility-factory.js';
import { iFlowCompatibility } from './iflow-compatibility.js';

// 注册iFlow模块类型到工厂（仅标准模块名，无历史别名）
CompatibilityModuleFactory.registerModuleType('iflow', iFlowCompatibility);

// 导出模块和组件
export { iFlowCompatibility } from './iflow-compatibility.js';
export { iFlowFieldMappingProcessor } from './field-mapping/iflow-field-mapping-processor.js';
export { iFlowToolCleaningHook } from './hooks/iflow-tool-cleaning-hook.js';
export { iFlowRequestValidationHook } from './hooks/iflow-request-validation-hook.js';
export { iFlowResponseValidationHook } from './hooks/iflow-response-validation-hook.js';
export { iFlowResponseNormalizationHook } from './hooks/iflow-response-normalization-hook.js';

/**
 * iFlow兼容模块工厂函数
 * 提供便捷的创建方式
 */
export function createiFlowCompatibilityModule(
  dependencies: ModuleDependencies,
  config?: {
    id?: string;
    profileId?: string;
  }
) {
  const module = new iFlowCompatibility(dependencies);

  return {
    module,
    initialize: () => module.initialize(),
    processIncoming: (request: any, context: any) => module.processIncoming(request, context),
    processOutgoing: (response: any, context: any) => module.processOutgoing(response, context),
    cleanup: () => module.cleanup()
  };
}
