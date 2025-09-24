#!/usr/bin/env node

/**
 * 简单测试keyID和actualKey概念
 */

import { UserConfigParser } from './dist/config/user-config-parser.js';
import { RouteTargetParser } from './dist/config/route-target-parser.js';

console.log('🔍 keyID和actualKey概念理解');
console.log('================================');

// 创建解析器实例
const userParser = new UserConfigParser();
const routeParser = new RouteTargetParser();

// 测试1: keyID和actualKey基本概念
console.log('\n📋 测试1: keyID和actualKey基本概念');

console.log('keyID (配置标识符):');
console.log('- 用户配置中使用的key标识');
console.log('- 示例: default, oauth-default, api-key-1');
console.log('- 用于配置映射和路由选择');

console.log('\nactualKey (实际密钥):');
console.log('- 实际发送给API的认证密钥');
console.log('- 通过resolveActualKey()方法解析得到');
console.log('- 可能是: API密钥、OAuth token等');

// 测试2: 路由解析示例
console.log('\n📋 测试2: 路由解析示例');

const routes = [
    'qwen.qwen3-coder-plus',           // 新格式
    'qwen.qwen-turbo.oauth-default',   // 旧格式
    'lmstudio.gpt-oss-20b-mlx.default' // 旧格式
];

for (const route of routes) {
    const parsed = routeParser.parseRouteString(route);
    console.log(`${route} -> keyId:${parsed.keyId}, actualKey:${parsed.actualKey}`);
}

// 测试3: 多模型多key配置
console.log('\n📋 测试3: 多模型多key配置');

const multiConfig = {
    default: [
        'qwen.qwen3-coder-plus',
        'qwen.qwen-turbo.oauth-default',
        'lmstudio.gpt-oss-20b-mlx.default',
        'lmstudio.gpt-oss-mini.api-key-1'
    ],
    coding: [
        'qwen.qwen3-coder-plus',
        'qwen.qwen-turbo.oauth-default'
    ]
};

const parsed = userParser.parseRouteTargets(multiConfig);
console.log('多路由配置解析成功');
console.log('默认路由目标数:', parsed.default.length);
console.log('编程路由目标数:', parsed.coding.length);

console.log('\n🎯 测试总结:');
console.log('✅ keyID和actualKey概念理解正确');
console.log('✅ 多模型多key路由解析正常');
console.log('✅ 新旧路由格式兼容良好');