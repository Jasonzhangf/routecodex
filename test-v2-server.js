/**
 * V2服务器测试脚本
 * 用于验证V2服务器的基本功能
 */

import { ServerFactory } from './dist/server-factory.js';

async function testV2Server() {
  console.log('🚀 Testing RouteCodex Server V2...');

  try {
    // 创建V2服务器配置
    const v2Config = {
      server: {
        port: 5507,  // 使用不同端口避免冲突
        host: '127.0.0.1',
        useV2: true
      },
      logging: {
        level: 'info',
        enableConsole: true
      },
      providers: {
        'test-provider': {
          enabled: true,
          models: {
            'test-model': {
              maxTokens: 4096,
              temperature: 0.7
            }
          }
        }
      },
      v2Config: {
        enableHooks: true,
        enableMiddleware: true
      }
    };

    console.log('📝 Creating V2 server...');
    const server = await ServerFactory.createV2Server(v2Config);

    console.log('🔧 Initializing V2 server...');
    await server.initialize();

    console.log('▶️  Starting V2 server...');
    await server.start();

    // 获取服务器状态
    const status = server.getStatus();
    console.log('📊 Server Status:', {
      version: status.version,
      port: status.port,
      running: status.running,
      hooksEnabled: status.hooksEnabled,
      middlewareEnabled: status.middlewareEnabled
    });

    // 等待服务器完全启动
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 测试健康检查端点
    console.log('🏥 Testing health check...');
    try {
      const healthResponse = await fetch('http://127.0.0.1:5507/health-v2');
      const healthData = await healthResponse.json();
      console.log('✅ Health check passed:', healthData);
    } catch (error) {
      console.error('❌ Health check failed:', error.message);
    }

    // 测试Chat Completions端点
    console.log('💬 Testing chat completions...');
    try {
      const chatResponse = await fetch('http://127.0.0.1:5507/v2/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'test-model',
          messages: [
            { role: 'user', content: 'Hello, V2 server!' }
          ]
        })
      });

      if (chatResponse.ok) {
        const chatData = await chatResponse.json();
        console.log('✅ Chat completion passed:', {
          id: chatData.id,
          model: chatData.model,
          content: chatData.choices[0].message.content.substring(0, 50) + '...'
        });
      } else {
        console.error('❌ Chat completion failed:', chatResponse.status, chatResponse.statusText);
      }
    } catch (error) {
      console.error('❌ Chat completion error:', error.message);
    }

    // 测试模型列表端点
    console.log('📋 Testing models list...');
    try {
      const modelsResponse = await fetch('http://127.0.0.1:5507/v1/models');
      const modelsData = await modelsResponse.json();
      console.log('✅ Models list passed:', {
        object: modelsData.object,
        count: modelsData.data.length,
        models: modelsData.data.map(m => ({ id: m.id, owned_by: m.owned_by }))
      });
    } catch (error) {
      console.error('❌ Models list failed:', error.message);
    }

    // 停止服务器
    console.log('🛑 Stopping V2 server...');
    await server.stop();

    console.log('🎉 V2 Server test completed successfully!');

  } catch (error) {
    console.error('💥 V2 Server test failed:', error);
    process.exit(1);
  }
}

// 运行测试
testV2Server();