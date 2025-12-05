/**
 * iFlow兼容模块导出
 */

import type { ModuleDependencies } from '../../../modules/pipeline/types/module.types.js';
import type { UnknownObject } from '../../../modules/pipeline/types/common-types.js';
import type { CompatibilityContext } from '../compatibility-interface.js';
import { CompatibilityModuleFactory } from '../compatibility-factory.js';
import { iFlowCompatibility } from './iflow-compatibility.js';

// 注册iFlow模块类型到工厂：
// - 'iflow'               → 新的模块化实现（用于标准兼容配置）
// - 'iflow-compatibility' → 兼容旧配置的别名（指向同一实现）
CompatibilityModuleFactory.registerModuleType('iflow', iFlowCompatibility);
CompatibilityModuleFactory.registerModuleType('iflow-compatibility', iFlowCompatibility);

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
  _config?: {
    id?: string;
    profileId?: string;
  }
) {
  const module = new iFlowCompatibility(dependencies);

  return {
    module,
    initialize: () => module.initialize(),
    processIncoming: (request: UnknownObject, context: CompatibilityContext) =>
      module.processIncoming(request, context),
    processOutgoing: (response: UnknownObject, context: CompatibilityContext) =>
      module.processOutgoing(response, context),
    cleanup: () => module.cleanup()
  };
}
