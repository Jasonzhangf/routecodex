/**
 * 基础V1 vs V2测试
 * 绕过hooks编译问题，测试基础功能对比
 */

// 直接使用已编译的模块
import { readFileSync } from 'fs';

/**
 * 简单的HTTP请求工具
 */
async function makeRequest(url, options = {}) {
  const defaultOptions = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-key'
    }
  };

  const finalOptions = { ...defaultOptions, ...options };

  try {
    const startTime = Date.now();
    const response = await fetch(url, finalOptions);
    const responseTime = Date.now() - startTime;

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      data,
      responseTime
    };
  } catch (error) {
    throw new Error(`Request failed: ${error.message}`);
  }
}

/**
 * 读取测试配置
 */
function loadTestConfig() {
  try {
    return JSON.parse(readFileSync('./config/dry-run/single-test-request.json', 'utf-8'));
  } catch (error) {
    console.warn('Failed to load test config, using default');
    return {
      data: {
        model: 'gpt-4',
        messages: [
          { role: 'user', content: 'Test message from config' }
        ],
        temperature: 0.7,
        max_tokens: 100
      }
    };
  }
}

/**
 * 测试V1服务器
 */
async function testV1Server(testConfig) {
  console.log('🧪 Testing V1 Server...');

  try {
    // 健康检查
    const healthResult = await makeRequest('http://127.0.0.1:5506/health', { method: 'GET' });
    console.log('✅ V1 Health check:', healthResult.data.status);

    // 测试Chat Completions
    const chatResult = await makeRequest('http://127.0.0.1:5506/v1/chat/completions', {
      body: JSON.stringify(testConfig.data)
    });

    console.log('✅ V1 Chat Completions:', {
      status: chatResult.status,
      responseTime: chatResult.responseTime,
      hasId: !!chatResult.data.id,
      hasModel: !!chatResult.data.model,
      hasChoices: Array.isArray(chatResult.data.choices) && chatResult.data.choices.length > 0
    });

    return {
      success: true,
      version: 'V1',
      health: healthResult,
      chat: chatResult,
      timestamp: Date.now()
    };

  } catch (error) {
    console.error('❌ V1 Server test failed:', error.message);
    return {
      success: false,
      version: 'V1',
      error: error.message,
      timestamp: Date.now()
    };
  }
}

/**
 * 测试V2服务器
 */
async function testV2Server(testConfig) {
  console.log('🧪 Testing V2 Server...');

  try {
    // 健康检查
    const healthResult = await makeRequest('http://127.0.0.1:5507/health', { method: 'GET' });
    console.log('✅ V2 Health check:', healthResult.data.status);

    // 测试Chat Completions (V1兼容端点)
    const chatResultV1 = await makeRequest('http://127.0.0.1:5507/v1/chat/completions', {
      body: JSON.stringify(testConfig.data)
    });

    console.log('✅ V2 Chat Completions (V1 endpoint):', {
      status: chatResultV1.status,
      responseTime: chatResultV1.responseTime,
      hasId: !!chatResultV1.data.id,
      hasModel: !!chatResultV1.data.model,
      hasChoices: Array.isArray(chatResultV1.data.choices) && chatResultV1.data.choices.length > 0
    });

    // 测试V2专用端点
    let v2ChatResult = null;
    try {
      v2ChatResult = await makeRequest('http://127.0.0.1:5507/v2/chat/completions', {
        body: JSON.stringify(testConfig.data)
      });

      console.log('✅ V2 Chat Completions (V2 endpoint):', {
        status: v2ChatResult.status,
        responseTime: v2ChatResult.responseTime,
        hasId: !!v2ChatResult.data.id,
        hasModel: !!v2ChatResult.data.model,
        hasV2Enhancements: !!v2ChatResult.data.serverV2Enhanced,
        hasProcessingTime: !!v2ChatResult.data.processingTime
      });
    } catch (v2Error) {
      console.warn('⚠️  V2 endpoint failed (expected during development):', v2Error.message);
    }

    return {
      success: true,
      version: 'V2',
      health: healthResult,
      chatV1: chatResultV1,
      chatV2: v2ChatResult,
      timestamp: Date.now()
    };

  } catch (error) {
    console.error('❌ V2 Server test failed:', error.message);
    return {
      success: false,
      version: 'V2',
      error: error.message,
      timestamp: Date.now()
    };
  }
}

/**
 * 对比分析
 */
function analyzeResults(v1Result, v2Result) {
  console.log('\n📊 Comparative Analysis:');

  if (!v1Result.success || !v2Result.success) {
    console.log('❌ Cannot compare due to test failures');
    return null;
  }

  const comparison = {
    healthComparison: {
      v1Status: v1Result.health.data.status,
      v2Status: v2Result.health.data.status,
      statusMatch: v1Result.health.data.status === v2Result.health.data.status
    },
    performanceComparison: {
      v1Time: v1Result.chat.responseTime,
      v2Time: v2Result.chatV1.responseTime,
      timeDifference: v2Result.chatV1.responseTime - v1Result.chat.responseTime,
      v2Faster: v2Result.chatV1.responseTime < v1Result.chat.responseTime
    },
    responseComparison: {
      v1Id: v1Result.chat.data.id,
      v2Id: v2Result.chatV1.data.id,
      v1Model: v1Result.chat.data.model,
      v2Model: v2Result.chatV1.data.model,
      v1HasChoices: Array.isArray(v1Result.chat.data.choices) && v1Result.chat.data.choices.length > 0,
      v2HasChoices: Array.isArray(v2Result.chatV1.data.choices) && v2Result.chatV1.data.choices.length > 0
    }
  };

  // V2增强功能检查
  if (v2Result.chatV2) {
    comparison.v2Enhancements = {
      v2EndpointWorking: true,
      hasV2Enhancements: !!v2Result.chatV2.data.serverV2Enhanced,
      hasProcessingTime: !!v2Result.chatV2.data.processingTime,
      hasHookStats: !!v2Result.chatV2.data.hookStats
    };
  } else {
    comparison.v2Enhancements = {
      v2EndpointWorking: false,
      reason: 'V2 endpoint not available'
    };
  }

  console.log('  Health Status Match:', comparison.healthComparison.statusMatch ? '✅' : '❌');
  console.log('  Performance:', comparison.performanceComparison.v2Faster ? '✅ V2 Faster' : '❌ V1 Faster',
             `(${comparison.performanceComparison.timeDifference}ms difference)`);
  console.log('  Response Structure Match:', comparison.responseComparison.v1HasChoices === comparison.responseComparison.v2HasChoices ? '✅' : '❌');
  console.log('  V2 Enhancements:', comparison.v2Enhancements.v2EndpointWorking ? '✅' : '⚠️ ');

  return comparison;
}

/**
 * 主测试函数
 */
async function runBasicComparisonTest() {
  console.log('🚀 Starting Basic V1 vs V2 Comparison Test...\n');

  // 检查服务器是否运行
  console.log('🔍 Checking server availability...');

  let v1Available = false;
  let v2Available = false;

  try {
    await makeRequest('http://127.0.0.1:5506/health', { method: 'GET' });
    v1Available = true;
    console.log('✅ V1 Server available');
  } catch (error) {
    console.log('❌ V1 Server not available:', error.message);
  }

  try {
    await makeRequest('http://127.0.0.1:5507/health', { method: 'GET' });
    v2Available = true;
    console.log('✅ V2 Server available');
  } catch (error) {
    console.log('❌ V2 Server not available:', error.message);
  }

  if (!v1Available || !v2Available) {
    console.log('\n💡 Please ensure both servers are running:');
    console.log('   V1: Start with `rcc4 start --config ~/.route-claudecode/config/v4/single-provider/lmstudio-v4-5506.json --port 5506`');
    console.log('   V2: Start with `node test-v2-server.js`');
    process.exit(1);
  }

  // 加载测试配置
  const testConfig = loadTestConfig();
  console.log('📋 Test config loaded:', {
    model: testConfig.data.model,
    messageCount: testConfig.data.messages.length,
    hasTools: !!testConfig.data.tools
  });

  // 运行测试
  console.log('\n🧪 Running comparative tests...\n');

  const v1Result = await testV1Server(testConfig);
  await new Promise(resolve => setTimeout(resolve, 1000)); // 间隔

  const v2Result = await testV2Server(testConfig);

  // 分析结果
  const comparison = analyzeResults(v1Result, v2Result);

  // 生成报告
  const report = {
    testInfo: {
      timestamp: Date.now(),
      testConfig: testConfig.data,
      serversAvailable: { v1: v1Available, v2: v2Available }
    },
    results: {
      v1: v1Result,
      v2: v2Result,
      comparison: comparison
    }
  };

  // 保存报告
  try {
    const fs = await import('fs/promises');
    await fs.mkdir('./test-reports', { recursive: true });
    await fs.writeFile('./test-reports/basic-v1-v2-comparison.json', JSON.stringify(report, null, 2));
    console.log('\n📄 Report saved to: ./test-reports/basic-v1-v2-comparison.json');
  } catch (error) {
    console.warn('Failed to save report:', error.message);
  }

  // 总结
  console.log('\n🎉 Test Summary:');
  console.log(`  V1: ${v1Result.success ? '✅ Success' : '❌ Failed'}`);
  console.log(`  V2: ${v2Result.success ? '✅ Success' : '❌ Failed'}`);

  if (comparison) {
    console.log(`  Performance: ${comparison.performanceComparison.v2Faster ? 'V2 is faster' : 'V1 is faster'}`);
    console.log(`  V2 Enhancements: ${comparison.v2Enhancements.v2EndpointWorking ? 'Available' : 'Not available'}`);
  }

  console.log('\n✨ Basic comparison test completed!');
}

// 运行测试
runBasicComparisonTest().catch(console.error);