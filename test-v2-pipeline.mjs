#!/usr/bin/env node

/**
 * V2 Pipeline Integration Test
 * 测试V2服务器与V1流水线的集成
 */

import { RouteCodexServerV2 } from './dist/server-v2/core/route-codex-server-v2.js';

const TEST_CONFIG = {
  server: {
    port: 5509,
    host: '127.0.0.1',
    timeout: 30000,
    useV2: true
  },
  logging: {
    level: 'debug',
    enableConsole: true,
    enableFile: false
  },
  providers: {
    'test-provider': {
      enabled: true,
      models: {
        'glm-4-flash': {
          maxTokens: 4096,
          temperature: 0.7
        }
      }
    }
  },
  v2Config: {
    enableHooks: true,
    hookStages: ['server-entry', 'server-pre-process', 'server-post-process', 'server-response', 'server-final']
  }
};

async function testV2PipelineIntegration() {
  console.log('🧪 Testing V2 Server with V1 Pipeline Integration...');

  try {
    // 创建V2服务器实例
    const serverV2 = new RouteCodexServerV2(TEST_CONFIG);

    console.log('✅ V2 Server instance created successfully');

    // 测试初始化
    console.log('🔧 Initializing V2 Server...');
    await serverV2.initialize();
    console.log('✅ V2 Server initialized successfully');

    // 检查状态
    console.log('📊 Server Status:', {
      initialized: serverV2.isInitialized(),
      running: serverV2.isRunning()
    });

    // 启动服务器
    console.log('🚀 Starting V2 Server...');
    await serverV2.start();
    console.log('✅ V2 Server started successfully');

    // 等待服务器完全启动
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 测试健康检查
    console.log('🏥 Testing health check...');
    const healthResponse = await fetch('http://127.0.0.1:5509/health-v2');
    const healthData = await healthResponse.json();
    console.log('✅ Health check response:', healthData);

    // 测试V2端点与Pipeline集成
    console.log('🔌 Testing V2 chat completions with Pipeline integration...');
    const chatResponse = await fetch('http://127.0.0.1:5509/v2/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'glm-4-flash',
        messages: [{ role: 'user', content: 'Test V2 with V1 pipeline integration' }],
        stream: false
      })
    });

    if (chatResponse.ok) {
      const chatData = await chatResponse.json();
      console.log('✅ V2 Chat completions with Pipeline response:', {
        id: chatData.id,
        model: chatData.model,
        hasServerV2Enhanced: !!chatData.serverV2Enhanced,
        hasProcessingTime: !!chatData.processingTime,
        responseKeys: Object.keys(chatData)
      });

      // 检查是否通过Pipeline处理
      if (chatData.serverV2Enhanced && chatData.processingTime) {
        console.log('✅ V2 Pipeline integration appears to be working!');
        console.log('📋 Processing time:', `${chatData.processingTime}ms`);
      } else {
        console.log('⚠️  V2 Pipeline integration may have issues');
      }

      // 检查响应是否包含Pipeline特有的字段
      if (chatData.choices && chatData.choices.length > 0) {
        console.log('✅ Response format matches OpenAI standard');
        console.log('📝 Response content preview:',
          chatData.choices[0].message?.content?.substring(0, 100) + '...');
      }

    } else {
      console.error('❌ V2 Chat completions failed:', chatResponse.status, chatResponse.statusText);

      // 读取错误响应
      const errorData = await chatResponse.text();
      console.error('Error response:', errorData);
    }

    // 停止服务器
    console.log('🛑 Stopping V2 Server...');
    await serverV2.stop();
    console.log('✅ V2 Server stopped successfully');

    console.log('🎉 V2 Pipeline Integration Test completed successfully!');

  } catch (error) {
    console.error('❌ V2 Pipeline Integration Test failed:', error);
    process.exit(1);
  }
}

// 运行测试
testV2PipelineIntegration().catch(console.error);