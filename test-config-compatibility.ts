#!/usr/bin/env node

/**
 * 测试配置文件兼容性
 * 验证兼容模块能否正确加载和处理标准配置文件
 */

import { CompatibilityManager } from './src/modules/pipeline/modules/compatibility/compatibility-manager.js';
import type { ModuleDependencies } from './src/types/module.types.js';

// 模拟依赖项
const mockDependencies: ModuleDependencies = {
  logger: {
    logModule: (module: string, action: string, data: any) => {
      console.log(`[${module}] ${action}:`, JSON.stringify(data, null, 2));
    },
    logError: (error: Error, context: any) => {
      console.error(`[ERROR] ${context.component}.${context.operation}:`, error.message);
    }
  },
  config: {},
  validators: {},
  transformers: {}
};

async function testConfigCompatibility() {
  console.log('🧪 开始测试配置文件兼容性...\n');

  try {
    // 1. 创建兼容性管理器
    const manager = new CompatibilityManager(mockDependencies);

    // 2. 初始化管理器
    console.log('📋 初始化兼容性管理器...');
    await manager.initialize();
    console.log('✅ 兼容性管理器初始化成功\n');

    // 3. 加载测试配置文件
    console.log('📁 加载配置文件...');
    const configPath = './test-compatibility-config.json';
    const moduleIds = await manager.loadModulesFromConfig(configPath);

    console.log(`✅ 成功加载 ${moduleIds.length} 个兼容性模块:`);
    moduleIds.forEach(id => console.log(`   - ${id}`));
    console.log();

    // 4. 验证模块是否正确创建
    console.log('🔍 验证模块状态...');
    const allModules = manager.getAllModuleInstances();

    allModules.forEach(instance => {
      console.log(`模块 ${instance.id}:`);
      console.log(`   类型: ${instance.config.type}`);
      console.log(`   Provider: ${instance.config.providerType}`);
      console.log(`   启用状态: ${instance.config.enabled}`);
      console.log(`   优先级: ${instance.config.priority}`);
      console.log(`   配置项: ${JSON.stringify(instance.config.config, null, 2)}`);
      console.log();
    });

    // 5. 获取统计信息
    console.log('📊 模块统计信息:');
    const stats = manager.getStats();
    console.log(JSON.stringify(stats, null, 2));
    console.log();

    // 6. 清理
    console.log('🧹 清理资源...');
    await manager.cleanup();
    console.log('✅ 清理完成\n');

    console.log('🎉 配置文件兼容性测试通过！');

  } catch (error) {
    console.error('❌ 测试失败:', error);
    process.exit(1);
  }
}

// 运行测试
testConfigCompatibility();