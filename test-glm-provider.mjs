#!/usr/bin/env node

/**
 * 测试GLM Provider配置和HTTP请求
 */

import crypto from 'crypto';

// 模拟OpenAI Provider的关键逻辑
class GLMProviderTester {
  constructor() {
    this.config = {
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      apiKey: process.env.GLM_API_KEY
    };
  }

  // 模拟normalizeBaseUrl函数
  normalizeBaseUrl(u) {
    if (!u) return u;
    try {
      let s = String(u).trim();
      // Drop any explicit endpoint suffix if present
      s = s.replace(/\/(chat|completions|messages)(\/.*)?$/i, '');
      // Remove duplicate consecutive slashes (except protocol)
      s = s.replace(/([^:])\/+/g, '$1/');
      // If GLM coding paas path accidentally appends '/v1', drop it
      if (/open\.bigmodel\.cn/i.test(s) && /\/v1\/?$/i.test(s)) {
        s = s.replace(/\/v1\/?$/i, '');
      }
      return s;
    } catch { return u; }
  }

  // 模拟resolveApiKey函数
  resolveApiKey() {
    const cfg = this.config;
    const isRedacted = (s) => !!s && (/\*/.test(s) || /REDACTED/i.test(s));
    const pickFromConfig = () => {
      const direct = cfg?.apiKey;
      if (direct && String(direct).trim() && !isRedacted(direct)) return String(direct).trim();
      return undefined;
    };
    const c = pickFromConfig();
    if (c) return { key: c, source: 'config' };
    const envKey = String(process.env.GLM_API_KEY || process.env.ROUTECODEX_API_KEY || process.env.OPENAI_API_KEY || '').trim();
    if (envKey) return { key: envKey, source: 'env' };
    return { key: undefined, source: 'none' };
  }

  // 模拟buildAuthHeaders函数
  buildAuthHeaders(ctx, base = {}) {
    const headers = { ...base };
    if (!ctx) return headers;
    switch (ctx.type) {
      case 'apikey': {
        const name = ctx.credentials?.headerName || 'Authorization';
        const prefix = ctx.credentials?.prefix || 'Bearer ';
        headers[name] = prefix + (ctx.token || '');
        break;
      }
      case 'bearer':
        headers['Authorization'] = `Bearer ${ctx.token || ''}`;
        break;
    }
    return headers;
  }

  // 测试HTTP请求
  async testHTTPRequest() {
    console.log('🧪 测试GLM Provider HTTP请求逻辑...\n');

    // 1. 测试baseUrl规范化
    const originalBaseUrl = this.config.baseUrl;
    const normalizedBaseUrl = this.normalizeBaseUrl(originalBaseUrl);

    console.log('📍 BaseURL处理:');
    console.log(`  原始: ${originalBaseUrl}`);
    console.log(`  规范化: ${normalizedBaseUrl}`);
    console.log(`  是否相同: ${originalBaseUrl === normalizedBaseUrl ? '是' : '否'}\n`);

    // 2. 测试API Key解析
    const { key: apiKey, source: keySource } = this.resolveApiKey();

    console.log('🔑 API Key处理:');
    console.log(`  存在: ${!!apiKey}`);
    console.log(`  来源: ${keySource}`);
    console.log(`  前4字符: ${apiKey ? apiKey.slice(0, 4) : 'N/A'}****\n`);

    // 3. 构建请求配置
    const endpoint = normalizedBaseUrl.replace(/\/+$/, '') + '/chat/completions';
    const authCtx = { type: 'apikey', token: apiKey, credentials: this.config.auth?.credentials };
    const headers = this.buildAuthHeaders(authCtx, { 'Content-Type': 'application/json', 'User-Agent': 'RouteCodex/openai-compat' });

    console.log('🌐 HTTP请求配置:');
    console.log(`  端点: ${endpoint}`);
    console.log(`  认证头: ${headers.Authorization ? headers.Authorization.slice(0, 20) + '****' : '缺失'}\n`);

    // 4. 构建请求体
    const requestBody = {
      model: "glm-4.6",
      messages: [
        {
          role: "user",
          content: "你好，请回复一个简短的问候语"
        }
      ],
      max_tokens: 100
    };

    console.log('📤 请求体:');
    console.log(JSON.stringify(requestBody, null, 2));
    console.log();

    // 5. 发送实际请求
    try {
      console.log('🚀 发送HTTP请求...');
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      });

      console.log(`📊 响应状态: ${response.status} ${response.statusText}`);

      const responseText = await response.text();
      let responseJson;

      try {
        responseJson = JSON.parse(responseText);
        console.log('✅ JSON响应解析成功');
        console.log('📥 响应内容:');
        console.log(JSON.stringify(responseJson, null, 2));
      } catch (e) {
        console.log('❌ JSON解析失败，原始响应:');
        console.log(responseText);
      }

      return { success: response.ok, status: response.status, data: responseJson || responseText };

    } catch (error) {
      console.error('❌ 请求失败:', error.message);
      return { success: false, error: error.message };
    }
  }
}

// 运行测试
async function runTest() {
  console.log('🔍 GLM Provider 配置验证测试\n');
  console.log('===============================\n');

  const tester = new GLMProviderTester();
  const result = await tester.testHTTPRequest();

  console.log('\n===============================');
  console.log('📋 测试结果总结:');

  if (result.success) {
    console.log('✅ 测试通过: Provider配置正确，可以成功调用GLM API');
  } else {
    console.log('❌ 测试失败: Provider配置存在问题');
    console.log(`   状态码: ${result.status || 'N/A'}`);
    console.log(`   错误: ${result.error || 'N/A'}`);
  }

  console.log('\n🔧 问题诊断建议:');
  if (!result.success) {
    if (result.status === 401) {
      console.log('   - 401错误: 检查API Key是否正确设置');
      console.log('   - 确认GLM_API_KEY环境变量已设置');
      console.log('   - 验证API Key是否有效且未过期');
    } else if (result.status >= 500) {
      console.log('   - 服务器错误: GLM服务可能暂时不可用');
    } else {
      console.log('   - 其他错误: 检查网络连接和端点URL');
    }
  }
}

runTest().catch(console.error);