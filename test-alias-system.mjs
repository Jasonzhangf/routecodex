#!/usr/bin/env node

import { UserConfigParser } from './src/config/user-config-parser.ts';

// 测试顺序索引别名系统
const testConfig = {
  virtualrouter: {
    inputProtocol: 'openai',
    outputProtocol: 'openai',
    providers: {
      'openai': {
        type: 'openai',
        baseURL: 'https://api.openai.com',
        apiKey: ['sk-real-key-1', 'sk-real-key-2', 'sk-real-key-3'], // 真实key
        models: {
          'gpt-3.5-turbo': {
            maxContext: 4096,
            maxTokens: 2048
          }
        }
      }
    },
    routing: {
      'all-keys': ['openai.gpt-3.5-turbo'], // 不填key，使用全部（key1, key2, key3）
      'specific-key1': ['openai.gpt-3.5-turbo.key1'], // 使用第1个key
      'specific-key2': ['openai.gpt-3.5-turbo.key2'], // 使用第2个key
      'mixed-keys': ['openai.gpt-3.5-turbo.key1', 'openai.gpt-3.5-turbo.key3'] // 混合使用
    }
  }
};

function testAliasSystem(config, testName) {
  console.log(`\n=== ${testName} ===`);
  
  try {
    const parser = new UserConfigParser();
    console.log('开始解析配置...');
    const result = parser.parseUserConfig(config);
    
    console.log('配置解析完成');
    console.log('路由目标（使用key别名）：');
    console.log('routeTargets keys:', Object.keys(result.routeTargets));
    
    // 检查每个路由的详细信息
    for (const [routeName, targets] of Object.entries(result.routeTargets)) {
      console.log(`\n  ${routeName}: (${targets.length} targets)`);
      if (targets.length === 0) {
        console.log('    [空目标列表]');
      } else {
        targets.forEach((target, index) => {
          console.log(`    ${index + 1}. ${target.providerId}.${target.modelId}.${target.keyId} (actualKey: ${target.actualKey})`);
        });
      }
    }
    
    console.log('\n流水线配置（使用key别名）：');
    const pipelineKeys = Object.keys(result.pipelineConfigs);
    console.log(`找到 ${pipelineKeys.length} 个流水线配置`);
    
    for (const [configKey, config] of Object.entries(result.pipelineConfigs)) {
      console.log(`  ${configKey}:`);
      console.log(`    keyConfig:`, config.keyConfig);
    }
    
  } catch (error) {
    console.error('错误:', error.message);
    console.error('堆栈:', error.stack);
  }
}

testAliasSystem(testConfig, '顺序索引别名系统');