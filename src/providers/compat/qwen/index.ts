/**
 * Qwen 兼容模块导出与注册
 */

import { CompatibilityModuleFactory } from '../compatibility-factory.js';
import { QwenCompatibility } from '../qwen-compatibility.js';

// 注册 Qwen 兼容模块：
// - 标准名：'qwen-compatibility'
// - 简写别名：'qwen'
CompatibilityModuleFactory.registerModuleType('qwen-compatibility', QwenCompatibility);
CompatibilityModuleFactory.registerModuleType('qwen', QwenCompatibility);

export { QwenCompatibility } from '../qwen-compatibility.js';
