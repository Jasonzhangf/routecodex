#!/usr/bin/env node

/**
 * 调试流水线中的API Key传递
 */

import fs from 'fs/promises';
import path from 'path';

// 模拟PipelineAssembler的API Key传递逻辑
function debugAPIKeyFlow() {
  console.log('🔍 调试流水线中的API Key传递\n');
  console.log('===============================\n');

  // 1. 环境变量
  console.log('1️⃣ 环境变量检查:');
  const envKeys = ['GLM_API_KEY', 'ROUTECODEX_API_KEY', 'OPENAI_API_KEY'];
  envKeys.forEach(key => {
    const value = process.env[key];
    console.log(`   ${key}: ${value ? `已设置 (${value.slice(0, 4)}****)` : '未设置'}`);
  });
  console.log();

  // 2. 配置文件检查
  console.log('2️⃣ 配置文件检查:');
  const configFiles = [
    '~/.routecodex/config/glm-provider-config.json',
    '~/.routecodex/config/merged-config.5520.json'
  ];

  configFiles.forEach(async (file) => {
    const actualPath = file.replace('~', process.env.HOME);
    try {
      const content = await fs.readFile(actualPath, 'utf-8');
      const config = JSON.parse(content);

      console.log(`\n📁 ${file}:`);

      // 检查API Key位置
      const checkKey = (obj, path) => {
        const parts = path.split('.');
        let current = obj;
        for (const part of parts) {
          if (current && typeof current === 'object' && part in current) {
            current = current[part];
          } else {
            return null;
          }
        }
        return current;
      };

      const paths = [
        'apiKey',
        'auth.apiKey',
        'virtualrouter.providers.openai.apiKey',
        'virtualrouter.providers.glm.apiKey',
        'compatibilityConfig.originalConfig.virtualrouter.providers.openai.apiKey',
        'normalizedConfig.virtualrouter.providers.openai.apiKey',
        'keyMappings.global.key1',
        'keyMappings.providers.openai.key1'
      ];

      paths.forEach(path => {
        const value = checkKey(config, path);
        if (value) {
          if (Array.isArray(value)) {
            console.log(`   ${path}: [${value.length}个key] ${value[0] ? `(${value[0].slice(0, 4)}****)` : '(空)'}`);
          } else if (typeof value === 'string') {
            console.log(`   ${path}: ${value.slice(0, 4)}****`);
          } else {
            console.log(`   ${path}: ${typeof value} (已设置)`);
          }
        }
      });

    } catch (error) {
      console.log(`   ❌ 无法读取 ${file}: ${error.message}`);
    }
  });

  console.log('\n3️⃣ 流水线组装逻辑分析:');
  console.log('   PipelineAssembler中的API Key获取优先级:');
  console.log('   1. 系统配置中的auth.apiKey');
  console.log('   2. 系统配置中的顶级apiKey数组[0]');
  console.log('   3. 基于host匹配的provider配置');
  console.log('   4. 环境变量GLM_API_KEY');

  console.log('\n4️⃣ 问题诊断:');
  console.log('   根据错误信息分析:');
  console.log('   - pipelineId: "openai_key1.glm-4.6"');
  console.log('   - upstreamStatus: 401');
  console.log('   - baseUrl正确传递');
  console.log('   - 但API Key验证失败');

  console.log('\n🎯 可能的问题点:');
  console.log('   1. 配置文件中API Key位置不正确');
  console.log('   2. PipelineAssembler未找到API Key');
  console.log('   3. Provider中resolveApiKey逻辑问题');
  console.log('   4. Auth header构建问题');

  console.log('\n🔧 建议的修复步骤:');
  console.log('   1. 确认API Key在配置文件中的正确位置');
  console.log('   2. 检查merged-config中API Key是否被正确处理');
  console.log('   3. 验证Provider初始化时的API Key传递');
  console.log('   4. 检查buildAuthHeaders函数的输出');
}

// 模拟检查merged-config的API Key处理
async function checkMergedConfigKey() {
  console.log('\n===============================');
  console.log('5️⃣ 检查merged-config中的API Key处理:\n');

  try {
    const mergedConfigPath = path.join(process.env.HOME, '.routecodex/config/merged-config.5520.json');
    const content = await fs.readFile(mergedConfigPath, 'utf-8');
    const config = JSON.parse(content);

    // 检查keyMappings
    const keyMappings = config.compatibilityConfig?.keyMappings || {};
    console.log('🔑 Key Mappings:');
    console.log(`   global.key1: ${keyMappings.global?.key1 ? '已设置' : '未设置'}`);
    console.log(`   providers.openai.key1: ${keyMappings.providers?.openai?.key1 ? '已设置' : '未设置'}`);

    // 检查routeTargets
    const routeTargets = config.compatibilityConfig?.routeTargets || {};
    let hasValidKey = false;
    Object.values(routeTargets).forEach(targets => {
      targets.forEach(target => {
        if (target.actualKey && target.actualKey !== '***REDACTED***') {
          hasValidKey = true;
        }
      });
    });

    console.log(`\n🎯 RouteTargets中的实际Key: ${hasValidKey ? '已设置有效Key' : 'Key被REDACTED或缺失'}`);

    // 检查virtualrouter providers
    const vrProviders = config.virtualrouter?.providers || {};
    const openaiProvider = vrProviders.openai || {};
    console.log(`\n🏭 VirtualRouter OpenAI Provider:`);
    console.log(`   apiKey数组长度: ${openaiProvider.apiKey ? openaiProvider.apiKey.length : 0}`);
    console.log(`   第一个key: ${openaiProvider.apiKey?.[0] ? '已设置' : '未设置'}`);

  } catch (error) {
    console.log(`❌ 无法分析merged-config: ${error.message}`);
  }
}

// 运行调试
async function runDebug() {
  debugAPIKeyFlow();
  await checkMergedConfigKey();

  console.log('\n===============================');
  console.log('📋 调试完成');
  console.log('\n💡 根据分析，最可能的问题是:');
  console.log('   配置系统在处理API Key时，Key被正确存储但传递到Provider时出现问题');
  console.log('   需要检查PipelineAssembler的API Key enrich逻辑和Provider的resolveApiKey逻辑');
}

runDebug().catch(console.error);