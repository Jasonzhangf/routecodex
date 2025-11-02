#!/usr/bin/env node

/**
 * Simple V2 Server Test
 * 直接测试V2服务器组件
 */

import { RouteCodexServerV2 } from './dist/server-v2/core/route-codex-server-v2.js';

const TEST_CONFIG = {
  server: {
    port: 5508,
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
        'gpt-3.5-turbo': {
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

async function testV2Server() {
  console.log('🧪 Testing V2 Server Components...');

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
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 测试健康检查
    console.log('🏥 Testing health check...');
    const healthResponse = await fetch('http://127.0.0.1:5508/health-v2');
    const healthData = await healthResponse.json();
    console.log('✅ Health check response:', healthData);

    // 测试V2端点
    console.log('🔌 Testing V2 chat completions endpoint...');
    const chatResponse = await fetch('http://127.0.0.1:5508/v2/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'Test V2 hooks integration' }],
        stream: false
      })
    });

    if (chatResponse.ok) {
      const chatData = await chatResponse.json();
      console.log('✅ V2 Chat completions response:', {
        id: chatData.id,
        model: chatData.model,
        hasServerV2Enhanced: !!chatData.serverV2Enhanced,
        hasProcessingTime: !!chatData.processingTime,
        responseKeys: Object.keys(chatData)
      });

      // 检查hooks是否执行
      if (chatData.serverV2Enhanced && chatData.processingTime) {
        console.log('✅ V2 Hooks appear to be working!');
      } else {
        console.log('⚠️  V2 Hooks may not be fully enabled');
      }
    } else {
      console.error('❌ V2 Chat completions failed:', chatResponse.status, chatResponse.statusText);
    }

    // 停止服务器
    console.log('🛑 Stopping V2 Server...');
    await serverV2.stop();
    console.log('✅ V2 Server stopped successfully');

    console.log('🎉 V2 Server Test completed successfully!');

  } catch (error) {
    console.error('❌ V2 Server Test failed:', error);
    process.exit(1);
  }
}

// 运行测试
testV2Server().catch(console.error);