#!/usr/bin/env node

/**
 * Server V2 Hook Integration Test
 * 测试hooks和snapshot功能是否正常工作
 */

import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';

const TEST_CONFIG = {
  server: {
    port: 5507, // 使用不同端口避免冲突
    host: '127.0.0.1',
    cors: {
      origin: '*',
      credentials: true
    },
    timeout: 30000,
    bodyLimit: '10mb',
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
    enableMiddleware: true,
    hookStages: ['server-entry', 'server-pre-process', 'server-post-process', 'server-response', 'server-final']
  }
};

async function startServer() {
  console.log('🚀 Starting Server V2 for Hook Integration Test...');

  // 创建测试配置文件
  const configPath = './test-server-v2-config.json';
  fs.writeFileSync(configPath, JSON.stringify(TEST_CONFIG, null, 2));

  // 设置环境变量
  process.env.ROUTECODEX_USE_V2 = 'true';
  process.env.ROUTECODEX_CONFIG_PATH = configPath;

  // 启动服务器
  const serverProcess = spawn('node', ['dist/index.js', 'start', '--config', configPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env
  });

  // 等待服务器启动
  await new Promise(resolve => setTimeout(resolve, 3000));

  return serverProcess;
}

async function testHookIntegration() {
  console.log('🧪 Testing Hook Integration...');

  const testData = {
    model: 'gpt-3.5-turbo',
    messages: [
      { role: 'user', content: 'Hello, this is a test message for hook integration.' }
    ],
    stream: false
  };

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(testData);

    const options = {
      hostname: '127.0.0.1',
      port: 5507,
      path: '/v2/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          console.log('✅ Hook Integration Test Response:', {
            status: res.statusCode,
            hasServerV2Enhanced: !!response.serverV2Enhanced,
            hasProcessingTime: !!response.processingTime,
            responseKeys: Object.keys(response)
          });
          resolve(response);
        } catch (error) {
          console.error('❌ Failed to parse response:', error);
          reject(error);
        }
      });
    });

    req.on('error', (error) => {
      console.error('❌ Hook Integration Test failed:', error);
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}

async function checkHookOutputs() {
  console.log('🔍 Checking Hook Outputs...');

  // 检查快照目录是否存在

  const snapshotDirs = [
    './debug-logs',
    './snapshots',
    './server-v2-snapshots'
  ];

  for (const dir of snapshotDirs) {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      console.log(`📸 ${dir}: ${files.length} files found`);
      if (files.length > 0) {
        console.log('   Latest files:', files.slice(-3));
      }
    } else {
      console.log(`📸 ${dir}: directory not found`);
    }
  }

  // 检查控制台输出中的hook执行日志
  console.log('📋 Checking console output for hook execution logs...');
  console.log('   (Look for hook-related messages in server output above)');
}

async function cleanup() {
  console.log('🧹 Cleaning up test resources...');

  const configPath = './test-server-v2-config.json';

  if (fs.existsSync(configPath)) {
    fs.unlinkSync(configPath);
  }
}

async function main() {
  let serverProcess = null;

  try {
    // 启动服务器
    serverProcess = await startServer();

    // 测试hook集成
    const response = await testHookIntegration();

    // 检查hook输出
    await checkHookOutputs();

    console.log('✅ Hook Integration Test completed successfully!');
    console.log('📊 Test Summary:');
    console.log(`   - Server V2 responded with ${response.serverV2Enhanced ? 'V2 enhanced' : 'standard'} format`);
    console.log(`   - Processing time: ${response.processingTime}ms`);
    console.log(`   - Hook execution: ${response.hooksExecuted ? 'enabled' : 'disabled'}`);

  } catch (error) {
    console.error('❌ Hook Integration Test failed:', error);
    process.exit(1);
  } finally {
    // 清理资源
    if (serverProcess) {
      serverProcess.kill();
    }
    await cleanup();
  }
}

// 运行测试
main().catch(console.error);