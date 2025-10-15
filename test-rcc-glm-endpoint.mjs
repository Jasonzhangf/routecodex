#!/usr/bin/env node

/**
 * 测试RCC端点的GLM调用
 */

const RCC_PORT = 5520;
const RCC_BASE_URL = `http://localhost:${RCC_PORT}`;

async function testRCCEndpoint() {
  console.log('🔍 测试RCC端点的GLM调用\n');
  console.log('===============================\n');

  // 测试健康检查
  console.log('1️⃣ 检查RCC服务状态...');
  try {
    const healthResponse = await fetch(`${RCC_BASE_URL}/health`);
    if (healthResponse.ok) {
      console.log('✅ RCC服务正常运行');
    } else {
      console.log('❌ RCC服务异常');
      return;
    }
  } catch (error) {
    console.log('❌ 无法连接到RCC服务:', error.message);
    return;
  }

  // 测试OpenAI兼容端点
  console.log('\n2️⃣ 测试OpenAI兼容端点...');

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

  try {
    console.log('🚀 发送请求到RCC...');
    const startTime = Date.now();

    const response = await fetch(`${RCC_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GLM_API_KEY || 'test-key'}`
      },
      body: JSON.stringify(requestBody)
    });

    const endTime = Date.now();
    const responseTime = endTime - startTime;

    console.log(`📊 响应状态: ${response.status} ${response.statusText}`);
    console.log(`⏱️  响应时间: ${responseTime}ms`);

    const responseText = await response.text();

    if (response.ok) {
      try {
        const responseJson = JSON.parse(responseText);
        console.log('✅ JSON响应解析成功');
        console.log('📥 响应内容:');
        console.log(JSON.stringify(responseJson, null, 2));

        // 检查响应结构
        if (responseJson.choices && responseJson.choices.length > 0) {
          const choice = responseJson.choices[0];
          if (choice.message && choice.message.content) {
            console.log('\n💬 模型回复:', choice.message.content);
          }
          if (choice.message && choice.message.tool_calls) {
            console.log('\n🔧 工具调用:', choice.message.tool_calls);
          }
        }

      } catch (e) {
        console.log('❌ JSON解析失败，原始响应:');
        console.log(responseText);
      }
    } else {
      console.log('❌ 请求失败');
      console.log('📄 错误响应:');
      console.log(responseText);

      // 尝试解析错误信息
      try {
        const errorJson = JSON.parse(responseText);
        if (errorJson.error) {
          console.log('\n🚨 错误详情:');
          console.log(`   消息: ${errorJson.error.message || 'N/A'}`);
          console.log(`   类型: ${errorJson.error.type || 'N/A'}`);
          console.log(`   代码: ${errorJson.error.code || 'N/A'}`);
        }
      } catch (e) {
        // 无法解析JSON，显示原始响应
      }

      // 特殊处理401错误
      if (response.status === 401) {
        console.log('\n🔍 401错误分析:');
        console.log('   可能原因:');
        console.log('   1. API Key无效或过期');
        console.log('   2. 认证头格式错误');
        console.log('   3. 配置中API Key未正确传递到Provider');
        console.log('   4. Provider端点配置错误');
      }
    }

  } catch (error) {
    console.error('❌ 请求异常:', error.message);
  }

  console.log('\n===============================');
  console.log('📋 测试完成');
}

// 运行测试
testRCCEndpoint().catch(console.error);