/**
 * LMStudio 兼容模块导出与注册
 */

import { CompatibilityModuleFactory } from '../compatibility-factory.js';
import { LMStudioCompatibility } from '../lmstudio-compatibility.js';

// 注册 LM Studio 兼容模块（使用明确类型名，便于配置推断）
CompatibilityModuleFactory.registerModuleType('lmstudio-compatibility', LMStudioCompatibility as any);

export { LMStudioCompatibility } from '../lmstudio-compatibility.js';

