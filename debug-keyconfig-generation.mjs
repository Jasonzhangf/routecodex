#!/usr/bin/env node

/**
 * 调试keyConfig生成过程
 */

import fs from 'fs/promises';
import path from 'path';
import { CompatibilityEngine } from 'routecodex-config-compat';

async function debugKeyConfigGeneration() {
  console.log('🔍 调试keyConfig生成过程\n');
  console.log('===============================\n');

  try {
    // 1. 读取原始用户配置
    const userConfigPath = path.join(process.env.HOME, '.routecodex/config/glm-provider-config.json');
    const userConfigContent = await fs.readFile(userConfigPath, 'utf-8');
    const userConfig = JSON.parse(userConfigContent);

    console.log('1️⃣ 原始用户配置:');
    console.log('   顶级apiKey:', userConfig.apiKey ? `已设置 (${userConfig.apiKey[0].slice(0, 4)}****)` : '未设置');
    console.log('   virtualrouter.providers.glm.apiKey:', userConfig.virtualrouter?.providers?.glm?.apiKey || '未设置');
    console.log('   virtualrouter.providers.glm.auth:', userConfig.virtualrouter?.providers?.glm?.auth || '未设置');
    console.log();

    // 2. 模拟ConfigManager的预归一化
    const preNormalized = JSON.parse(JSON.stringify(userConfig));
    try {
      const vrNode = preNormalized?.virtualrouter || {};
      const provs = vrNode.providers || {};
      Object.keys(provs).forEach((pid) => {
        const p = provs[pid] || {};
        const family = String(p?.type || '').toLowerCase();
        if (family === 'glm') { p.type = 'custom'; }
        if (!p.id) { p.id = pid; }
        if (typeof p.enabled === 'undefined') { p.enabled = true; }
        if (p.baseURL && !p.baseUrl) { p.baseUrl = p.baseURL; }

        // 关键：检查apiKey处理逻辑
        const apiKeyArr = Array.isArray(p.apiKey) ? p.apiKey : (typeof p.apiKey === 'string' && p.apiKey ? [p.apiKey] : []);
        console.log(`2️⃣ Provider ${pid} 预归一化:`);
        console.log(`   原始apiKey:`, p.apiKey ? (Array.isArray(p.apiKey) ? `[${p.apiKey.length}个]` : typeof p.apiKey) : '未设置');
        console.log(`   apiKeyArr:`, apiKeyArr.length > 0 ? `[${apiKeyArr.length}个]` : '空数组');
        console.log(`   现有auth:`, p.auth || '无');

        if (!p.auth && apiKeyArr.length > 0) {
          p.auth = { type: 'apikey', apiKey: apiKeyArr[0] };
          console.log(`   ✅ 创建auth: { type: 'apikey', apiKey: ${apiKeyArr[0].slice(0, 4)}**** }`);
        } else {
          console.log(`   ⚠️  未创建auth块`);
        }

        if (!Array.isArray(p.keyAliases) || p.keyAliases.length === 0) {
          p.keyAliases = ['key1'];
        }
        provs[pid] = p;
      });
    } catch (error) {
      console.log('❌ 预归一化失败:', error.message);
    }

    console.log();
    console.log('3️⃣ 预归一化后的配置:');
    console.log('   virtualrouter.providers.glm.auth:', preNormalized.virtualrouter?.providers?.glm?.auth || '未设置');
    console.log('   virtualrouter.providers.glm.apiKey:', preNormalized.virtualrouter?.providers?.glm?.apiKey || '未设置');
    console.log();

    // 3. 使用CompatibilityEngine处理
    console.log('4️⃣ CompatibilityEngine处理...');
    const compatEngine = new CompatibilityEngine({ sanitizeOutput: false });

    try {
      const compatResult = await compatEngine.processCompatibility(
        JSON.stringify(preNormalized)
      );

      if (!compatResult.isValid) {
        console.log('❌ Compatibility处理失败:', compatResult.errors?.map(e => e.message).join(', '));
        return;
      }

      const compatConfig = compatResult.compatibilityConfig;
      console.log('✅ Compatibility处理成功');
      console.log();

      console.log('5️⃣ Compatibility结果分析:');

      // 检查keyMappings
      const keyMappings = compatConfig.keyMappings || {};
      console.log('   keyMappings.global.key1:', keyMappings.global?.key1 ? '已设置' : '未设置');
      console.log('   keyMappings.providers.glm.key1:', keyMappings.providers?.glm?.key1 ? '已设置' : '未设置');

      // 检查normalizedConfig
      const normConfig = compatConfig.normalizedConfig || {};
      console.log('   normalizedConfig.virtualrouter.providers.glm.apiKey:',
        normConfig.virtualrouter?.providers?.glm?.apiKey || '未设置');
      console.log('   normalizedConfig.virtualrouter.providers.glm.auth:',
        normConfig.virtualrouter?.providers?.glm?.auth || '未设置');

      // 检查routeTargets
      const routeTargets = compatConfig.routeTargets || {};
      console.log('   routeTargets.default:', routeTargets.default?.length || 0, '个目标');
      if (routeTargets.default?.length > 0) {
        routeTargets.default.forEach((target, i) => {
          console.log(`     [${i}] ${target.providerId}.${target.modelId}.${target.keyId} (actualKey: ${target.actualKey ? '已设置' : '未设置'})`);
        });
      }

      // 检查pipelineConfigs - 这里是关键！
      const pipelineConfigs = compatConfig.pipelineConfigs || {};
      console.log('   pipelineConfigs条目数:', Object.keys(pipelineConfigs).length);
      Object.entries(pipelineConfigs).forEach(([key, cfg]) => {
        console.log(`     ${key}:`);
        console.log(`       keyConfig.actualKey: ${cfg.keyConfig?.actualKey ? '已设置' : '未设置'}`);
        console.log(`       provider.config:`, cfg.provider?.config ? '存在' : '不存在');
      });

      console.log();
      console.log('6️⃣ 问题诊断:');

      // 检查是否存在keyConfig.actualKey缺失的情况
      let missingKeyConfig = false;
      Object.values(pipelineConfigs).forEach((cfg) => {
        if (!cfg.keyConfig?.actualKey) {
          missingKeyConfig = true;
        }
      });

      if (missingKeyConfig) {
        console.log('🚨 发现问题: pipelineConfigs中存在keyConfig.actualKey缺失的情况');
        console.log('   这会导致PipelineAssembler的authObj生成逻辑使用alias而非actualKey');
        console.log('   最终导致Provider收到{ type: "apikey", alias: "key1" }而非真实的API Key');
      } else {
        console.log('✅ keyConfig.actualKey设置正常');
      }

    } catch (error) {
      console.log('❌ CompatibilityEngine处理失败:', error.message);
      console.log('   Stack:', error.stack);
    }

  } catch (error) {
    console.log('❌ 调试过程失败:', error.message);
  }

  console.log('\n===============================');
  console.log('📋 keyConfig生成调试完成');
}

// 运行调试
debugKeyConfigGeneration().catch(console.error);