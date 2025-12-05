/**
 * Passthrough 兼容模块注册
 */

import { CompatibilityModuleFactory } from '../compatibility-factory.js';
import { PassthroughCompatibility } from '../passthrough-compatibility.js';

// 注册 Passthrough 兼容模块（用于 openai 等无需特殊兼容的 provider）
CompatibilityModuleFactory.registerModuleType('passthrough-compatibility', PassthroughCompatibility);

export { PassthroughCompatibility } from '../passthrough-compatibility.js';
