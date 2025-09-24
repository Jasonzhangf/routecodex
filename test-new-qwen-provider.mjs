#!/usr/bin/env node

/**
 * Test New Qwen Provider with Valid Token
 * 使用 ~/.qwen/oauth_creds.json 中的有效token测试新的Qwen Provider实现
 */

import { QwenProvider } from './dist/modules/pipeline/modules/provider/qwen-provider.js';
import { PipelineDebugLogger } from './dist/modules/pipeline/utils/debug-logger.js';
import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

// 创建测试依赖
const logger = new PipelineDebugLogger('new-qwen-provider-test');
const dependencies = {
  logger,
  errorHandlingCenter: {
    handleError: async (error) => {
      console.log('Error handled:', error);
    }
  },
  dispatchCenter: {
    notify: async (notification) => {
      console.log('Dispatch center notified:', notification);
    }
  }
};

// 加载有效的token
async function loadValidToken() {
  try {
    const tokenContent = await fs.readFile(path.join(homedir(), '.qwen', 'oauth_creds.json'), 'utf8');
    const tokenData = JSON.parse(tokenContent);

    console.log('📋 Loaded valid token from ~/.qwen/oauth_creds.json:');
    console.log('  - Access token:', tokenData.access_token.substring(0, 20) + '...');
    console.log('  - Expires at:', new Date(tokenData.expires_at));
    console.log('  - Is expired:', new Date(tokenData.expires_at) < new Date());

    return tokenData;
  } catch (error) {
    console.error('❌ Failed to load token:', error.message);
    throw error;
  }
}

// 创建使用真实token的Provider配置
function createProviderConfig(tokenData) {
  return {
    type: 'qwen-provider',
    config: {
      baseUrl: 'https://portal.qwen.ai/v1',
      auth: {
        oauth: {
          clientId: 'f0304373b74a44d2b584a3fb70ca9e56',
          deviceCodeUrl: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
          tokenUrl: 'https://chat.qwen.ai/api/v1/oauth2/token',
          scopes: ['openid', 'profile', 'email', 'model.completion'],
          tokenFile: path.join(homedir(), '.qwen', 'oauth_creds.json')
        }
      },
      models: {
        'qwen3-coder-plus': {
          maxTokens: 131072,
          temperature: 0.7,
          supportsStreaming: true,
          supportsTools: true
        }
      },
      timeout: 60000,
      retryAttempts: 3
    }
  };
}

// 创建符合CLIProxyAPI格式的token storage
function createCLIProxyAPITokenStorage(tokenData) {
  return {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    last_refresh: new Date(tokenData.created_at).toISOString(),
    resource_url: 'portal.qwen.ai',
    email: '',
    type: 'qwen',
    expired: new Date(tokenData.expires_at).toISOString()
  };
}

async function testNewQwenProvider() {
  console.log('🔧 Testing New Qwen Provider with Valid Token...\n');

  try {
    // 加载有效token
    const tokenData = await loadValidToken();

    // 创建provider配置
    const providerConfig = createProviderConfig(tokenData);
    const moduleConfig = {
      id: 'new-qwen-provider-test',
      type: 'qwen-provider',
      config: providerConfig.config
    };

    // 创建provider实例
    const provider = new QwenProvider(moduleConfig, dependencies);

    console.log('Step 1: Testing direct API call with valid token...');

    // 直接使用token进行API调用测试
    const testRequest = {
      model: 'qwen3-coder-plus',
      messages: [
        { role: 'user', content: 'Hello! Please respond with just "Qwen test successful"' }
      ],
      max_tokens: 50,
      temperature: 0.7
    };

    try {
      // 直接测试API调用
      const response = await fetch('https://portal.qwen.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${tokenData.access_token}`,
          'User-Agent': 'google-api-nodejs-client/9.15.1',
          'X-Goog-Api-Client': 'gl-node/22.17.0',
          'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI',
          'Accept': 'application/json'
        },
        body: JSON.stringify(testRequest)
      });

      console.log('  - Status:', response.status);

      if (response.ok) {
        const data = await response.json();
        console.log('✅ Direct API call successful');
        console.log('  - Model:', data.model);
        console.log('  - Response:', data.choices?.[0]?.message?.content);
        console.log('  - Usage:', JSON.stringify(data.usage || {}));
      } else {
        const errorText = await response.text();
        console.log('❌ Direct API call failed:', errorText);
      }
    } catch (error) {
      console.log('❌ Direct API call error:', error.message);
    }

    console.log('\nStep 2: Testing provider initialization...');

    // 设置test mode避免自动OAuth
    provider.setTestMode(true);

    try {
      await provider.initialize();
      console.log('✅ Provider initialized successfully');
    } catch (error) {
      console.log('❌ Provider initialization failed:', error.message);
    }

    // 检查provider状态
    const status = provider.getStatus();
    console.log('\nStep 3: Provider status:');
    console.log('  - ID:', status.id);
    console.log('  - Type:', status.type);
    console.log('  - Initialized:', status.isInitialized);
    console.log('  - Auth status:', status.authStatus);

    console.log('\nStep 4: Testing provider request...');

    try {
      const providerResponse = await provider.processIncoming(testRequest);
      console.log('✅ Provider request successful');
      console.log('  - Status:', providerResponse.status);
      console.log('  - Model:', providerResponse.data?.model);
      console.log('  - Content:', providerResponse.data?.choices?.[0]?.message?.content);
      console.log('  - Usage:', JSON.stringify(providerResponse.data?.usage || {}));
      console.log('  - Processing time:', providerResponse.metadata?.processingTime, 'ms');
    } catch (error) {
      console.log('❌ Provider request failed:', error.message);
    }

    console.log('\nStep 5: Testing health check...');

    try {
      const isHealthy = await provider.checkHealth();
      console.log('✅ Health check completed');
      console.log('  - Health status:', isHealthy ? 'Healthy' : 'Unhealthy');
    } catch (error) {
      console.log('❌ Health check failed:', error.message);
    }

    // 测试总结
    console.log('\n📋 Test Summary:');
    console.log('  - Direct API call: ✅');
    console.log('  - Provider initialization: ' + (status.isInitialized ? '✅' : '❌'));
    console.log('  - Provider request: ' + (providerResponse?.status === 200 ? '✅' : '❌'));
    console.log('  - Health check: ' + (isHealthy !== undefined ? '✅' : '❌'));

    console.log('\n🎉 New Qwen Provider Test Complete');

  } catch (error) {
    console.error('❌ Test failed with error:', error);
    console.error('Stack:', error.stack);
  } finally {
    // 清理
    if (provider) {
      try {
        await provider.cleanup();
        console.log('✅ Provider cleanup completed');
      } catch (cleanupError) {
        console.log('⚠️  Cleanup error:', cleanupError.message);
      }
    }
  }
}

// 处理未处理的Promise拒绝
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// 运行测试
testNewQwenProvider();
