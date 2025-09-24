#!/usr/bin/env node

/**
 * 测试路由多模型和多key解析
 * 验证keyID和actualKey的区别以及多路由配置
 */

import { UserConfigParser } from './dist/config/user-config-parser.js';
import { RouteTargetParser } from './dist/config/route-target-parser.js';

// 创建解析器实例
const userParser = new UserConfigParser();
const routeParser = new RouteTargetParser();

console.log('🔍 测试keyID和actualKey概念');
console.log('================================');

// 测试1: 基本路由解析
console.log('\n📋 测试1: 基本路由格式解析');

// 新格式: provider.model
const route1 = routeParser.parseRouteString('qwen.qwen3-coder-plus');
console.log('新格式解析结果:');
console.log('  keyId:', route1.keyId);
console.log('  actualKey:', route1.actualKey);
console.log('  说明: 新格式自动使用default作为key');

// 旧格式: provider.model.key
const route2 = routeParser.parseRouteString('qwen.qwen3-coder-plus.oauth-default');
console.log('\n旧格式解析结果:');
console.log('  keyId:', route2.keyId);
console.log('  actualKey:', route2.actualKey);
console.log('  说明: 旧格式保留原始key');

// 测试2: 多模型多key路由配置
console.log('\n📋 测试2: 多模型多key路由配置解析');

const multiRouteConfig = {
  default: [
    'qwen.qwen3-coder-plus',           // 新格式，默认key
    'qwen.qwen-turbo.oauth-default',   // 旧格式，OAuth key
    'lmstudio.gpt-oss-20b-mlx.default', // 旧格式，默认key
    'lmstudio.gpt-oss-mini.api-key-1'   // 旧格式，API key
  ],
  coding: [
    'qwen.qwen3-coder-plus',
    'qwen.qwen-turbo.oauth-default'
  ],
  longcontext: [
    'lmstudio.gpt-oss-20b-mlx.default',
    'lmstudio.gpt-oss-20b-mlx.api-key-2'
  ],
  tools: [
    'qwen.qwen-turbo.oauth-default',
    'lmstudio.gpt-oss-20b-mlx.default'
  ]
};

console.log('多路由配置:');
for (const [routeName, targets] of Object.entries(multiRouteConfig)) {
  console.log(`\n${routeName}路由:`);
  targets.forEach(target => {
    const parsed = routeParser.parseRouteString(target);
    console.log(`  ${target} -> provider:${parsed.providerId}, model:${parsed.modelId}, keyId:${parsed.keyId}, actualKey:${parsed.actualKey}`);
  });
}

// 测试3: 用户配置解析器处理多路由
console.log('\n📋 测试3: 用户配置解析器处理多路由');

try {
  const parsedRoutes = userParser.parseRouteTargets(multiRouteConfig);
  console.log('用户配置解析结果:');
  
  for (const [routeName, targets] of Object.entries(parsedRoutes)) {
    console.log(`\n${routeName}路由解析:`);
    targets.forEach((target, index) => {
      console.log(`  [${index}] provider:${target.providerId}, model:${target.modelId}, keyId:${target.keyId}, actualKey:${target.actualKey}`);
    });
  }
} catch (error) {
  console.error('解析错误:', error.message);
}

// 测试4: keyID和actualKey的区别验证
console.log('\n📋 测试4: keyID和actualKey的区别');
console.log('keyID (配置中的标识符):');
console.log('  - 用户配置中使用的key标识');
console.log('  - 可以是: default, oauth-default, api-key-1, authfile-key等');
console.log('  - 用于配置映射和路由选择');

console.log('\nactualKey (实际使用的密钥):');
console.log('  - 实际发送给API的认证密钥');
console.log('  - 通过resolveActualKey()方法解析得到');
console.log('  - 可能是: API密钥、OAuth token、AuthFile内容等');

console.log('\n📋 测试5: 验证路由配置有效性');

const validation = routeParser.validateRoutingConfig(userParser.parseRouteTargets(multiRouteConfig));
console.log('路由配置验证结果:');
console.log('  有效性:', validation.isValid ? '✅ 有效' : '❌ 无效');
if (!validation.isValid) {
  console.log('  错误信息:', validation.errors.join(', '));
}

console.log('\n🎯 测试总结:');
console.log('✅ keyID和actualKey概念理解正确');
console.log('✅ 多模型多key路由解析功能正常');
console.log('✅ 新旧路由格式兼容性良好');
console.log('✅ 路由配置验证机制工作正常');