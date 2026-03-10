#!/usr/bin/env node

/**
 * 直接使用codex样本的C4M测试脚本
 * 复用真实的请求格式进行测试
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// 读取C4M配置
let C4M_CONFIG;
try {
  const configPath = '/Users/fanzhang/.routecodex/provider/c4m/config.v1.json';
  const configData = readFileSync(configPath, 'utf8');
  C4M_CONFIG = JSON.parse(configData);
  console.log('✅ 成功读取C4M配置');
} catch (error) {
  console.error('❌ 无法读取C4M配置:', error.message);
  process.exit(1);
}

// 读取codex样本的请求体
let CODEX_SAMPLE_REQUEST;
try {
  const samplePath = '/Users/fanzhang/.routecodex/codex-samples/openai-responses/req_1763733582430_c30ihldix_provider-request.json';
  const sampleData = JSON.parse(readFileSync(samplePath, 'utf8'));
  CODEX_SAMPLE_REQUEST = sampleData.body;
  console.log('✅ 成功读取codex样本请求');
} catch (error) {
  console.error('❌ 无法读取codex样本:', error.message);
  process.exit(1);
}

// 提取C4M配置信息
const C4M_SETTINGS = {
  baseURL: C4M_CONFIG.virtualrouter.providers.c4m.baseURL,
  apiKey: C4M_CONFIG.virtualrouter.providers.c4m.auth.apiKey,
  model: 'gpt-5.1'
};

console.log('🔧 C4M配置信息:');
console.log(`   - 基础URL: ${C4M_SETTINGS.baseURL}`);
console.log(`   - API Key: ${C4M_SETTINGS.apiKey.substring(0, 10)}...`);

// HTTP请求工具
async function c4mRequest(url, body) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'responses-2024-12-17',
        'Authorization': `Bearer ${C4M_SETTINGS.apiKey}`
      },
      body: JSON.stringify(body)
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorText}`);
    }

    return await response.text();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('请求超时');
    }
    throw error;
  }
}

// 测试1：直接使用codex样本的完整请求
async function testCodexSampleRequest() {
  console.log('\n🎯 测试1: 直接使用codex样本的完整请求');

  try {
    const result = await c4mRequest(`${C4M_SETTINGS.baseURL}/responses`, CODEX_SAMPLE_REQUEST);
    console.log('✅ 成功: codex样本请求正常');
    console.log('📄 响应长度:', result.length, '字符');
    return true;
  } catch (error) {
    console.error('❌ 失败:', error.message);
    return false;
  }
}

// 测试2：使用codex样本格式，但修改为简单对话
async function testSimpleConversation() {
  console.log('\n🎯 测试2: 使用codex样本格式，修改为简单对话');

  // 使用codex样本结构，但过滤掉max_tokens字段（在兼容层处理）
  const { max_tokens, ...filteredSample } = CODEX_SAMPLE_REQUEST;
  const simpleRequest = {
    ...filteredSample,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '你好，请回复一个简短的问候语'
          }
        ]
      }
    ]
  };

  try {
    const result = await c4mRequest(`${C4M_SETTINGS.baseURL}/responses`, simpleRequest);
    console.log('✅ 成功: 简单对话请求正常');
    console.log('📄 响应长度:', result.length, '字符');

    // 尝试解析SSE流
    const lines = result.split('\n').filter(line => line.trim());
    const eventCount = lines.filter(line => line.startsWith('event:')).length;
    const dataCount = lines.filter(line => line.startsWith('data:')).length;

    console.log(`📡 SSE事件: ${eventCount}个event, ${dataCount}个data`);
    return true;
  } catch (error) {
    console.error('❌ 失败:', error.message);
    return false;
  }
}

// 主测试函数
async function main() {
  console.log('🏆 C4M直接样本测试');
  console.log('='.repeat(50));

  const results = [];

  // 执行测试
  results.push(await testCodexSampleRequest());
  results.push(await testSimpleConversation());

  // 生成报告
  console.log('\n📊 测试报告');
  console.log('='.repeat(50));

  const successCount = results.filter(r => r).length;
  const totalCount = results.length;

  console.log(`✅ 成功测试: ${successCount}/${totalCount}`);
  console.log(`❌ 失败测试: ${totalCount - successCount}/${totalCount}`);

  if (successCount === totalCount) {
    console.log('\n🎉 所有测试通过！C4M Responses API工作正常');
    process.exit(0);
  } else {
    console.log('\n⚠️ 部分测试失败，C4M配置可能需要调整');
    process.exit(1);
  }
}

// 运行测试
main().catch(error => {
  console.error('💥 测试失败:', error);
  process.exit(1);
});