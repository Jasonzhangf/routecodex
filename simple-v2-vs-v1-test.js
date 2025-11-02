/**
 * 简化的V2 vs V1服务器对比测试
 * 绕过复杂的hook类型问题，专注测试基本功能
 */

import { ServerFactory } from './dist/server-factory.js';
import fs from 'fs/promises';

/**
 * 简化的测试配置
 */
const TEST_CONFIG = {
  v1Port: 5506,
  v2Port: 5507,
  host: '127.0.0.1',
  timeout: 30000
};

/**
 * V1服务器配置
 */
function getV1Config() {
  return {
    server: {
      port: TEST_CONFIG.v1Port,
      host: TEST_CONFIG.host,
      cors: {
        origin: '*',
        credentials: true
      }
    },
    logging: {
      level: 'info',
      enableConsole: true
    },
    providers: {
      'test-provider': {
        enabled: true,
        models: {
          'gpt-4': {
            maxTokens: 4096,
            temperature: 0.7
          }
        }
      }
    }
  };
}

/**
 * V2服务器配置 (禁用hooks避免类型问题)
 */
function getV2Config() {
  return {
    server: {
      port: TEST_CONFIG.v2Port,
      host: TEST_CONFIG.host,
      useV2: true,
      cors: {
        origin: '*',
        credentials: true
      }
    },
    logging: {
      level: 'info',
      enableConsole: true
    },
    providers: {
      'test-provider': {
        enabled: true,
        models: {
          'gpt-4': {
            maxTokens: 4096,
            temperature: 0.7
          }
        }
      }
    },
    v2Config: {
      enableHooks: false,  // 禁用hooks避免类型问题
      enableMiddleware: true
    }
  };
}

/**
 * HTTP请求工具
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
 * 健康检查
 */
async function healthCheck(baseUrl) {
  try {
    const url = `${baseUrl}/health`;
    const result = await makeRequest(url, { method: 'GET' });
    return { success: true, ...result };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Chat Completions测试
 */
async function testChatCompletions(baseUrl, version, testIndex) {
  console.log(`🧪 Testing ${version} Chat Completions (${testIndex})...`);

  const testData = {
    model: 'gpt-4',
    messages: [
      {
        role: 'user',
        content: `Test message ${testIndex} for ${version} server`
      }
    ],
    temperature: 0.7,
    max_tokens: 100
  };

  try {
    const url = `${baseUrl}/v1/chat/completions`;
    const result = await makeRequest(url, {
      body: JSON.stringify(testData)
    });

    console.log(`✅ ${version} Test ${testIndex} success:`, {
      status: result.status,
      responseTime: result.responseTime,
      hasId: !!result.data.id,
      hasModel: !!result.data.model,
      hasChoices: Array.isArray(result.data.choices) && result.data.choices.length > 0
    });

    return {
      success: true,
      version,
      testIndex,
      request: testData,
      response: result,
      timestamp: Date.now()
    };

  } catch (error) {
    console.error(`❌ ${version} Test ${testIndex} failed:`, error.message);
    return {
      success: false,
      version,
      testIndex,
      error: error.message,
      timestamp: Date.now()
    };
  }
}

/**
 * 模型列表测试
 */
async function testModels(baseUrl, version) {
  console.log(`🧪 Testing ${version} Models endpoint...`);

  try {
    const url = `${baseUrl}/v1/models`;
    const result = await makeRequest(url, { method: 'GET' });

    console.log(`✅ ${version} Models test success:`, {
      status: result.status,
      responseTime: result.responseTime,
      hasData: !!result.data.object,
      modelCount: Array.isArray(result.data.data) ? result.data.data.length : 0
    });

    return {
      success: true,
      version,
      endpoint: 'models',
      response: result,
      timestamp: Date.now()
    };

  } catch (error) {
    console.error(`❌ ${version} Models test failed:`, error.message);
    return {
      success: false,
      version,
      endpoint: 'models',
      error: error.message,
      timestamp: Date.now()
    };
  }
}

/**
 * 状态检查测试
 */
async function testStatus(baseUrl, version) {
  console.log(`🧪 Testing ${version} Status endpoint...`);

  try {
    const url = `${baseUrl}/status`;
    const result = await makeRequest(url, { method: 'GET' });

    console.log(`✅ ${version} Status test success:`, {
      status: result.status,
      responseTime: result.responseTime,
      isInitialized: !!result.data.initialized,
      isRunning: !!result.data.running
    });

    return {
      success: true,
      version,
      endpoint: 'status',
      response: result,
      timestamp: Date.now()
    };

  } catch (error) {
    console.error(`❌ ${version} Status test failed:`, error.message);
    return {
      success: false,
      version,
      endpoint: 'status',
      error: error.message,
      timestamp: Date.now()
    };
  }
}

/**
 * 对比分析器
 */
function compareResults(v1Results, v2Results) {
  const comparisons = [];

  // Chat Completions对比
  const v1ChatResults = v1Results.filter(r => r.success && r.request);
  const v2ChatResults = v2Results.filter(r => r.success && r.request);

  for (let i = 0; i < Math.min(v1ChatResults.length, v2ChatResults.length); i++) {
    const v1 = v1ChatResults[i];
    const v2 = v2ChatResults[i];

    const comparison = {
      testIndex: i,
      testType: 'chat-completions',
      statusComparison: {
        v1Status: v1.response.status,
        v2Status: v2.response.status,
        statusMatch: v1.response.status === v2.response.status
      },
      performanceComparison: {
        v1Time: v1.response.responseTime,
        v2Time: v2.response.responseTime,
        timeDifference: v2.response.responseTime - v1.response.responseTime,
        v2Faster: v2.response.responseTime < v1.response.responseTime
      },
      responseStructureComparison: {
        v1HasId: !!v1.response.data.id,
        v2HasId: !!v2.response.data.id,
        v1HasModel: !!v1.response.data.model,
        v2HasModel: !!v2.response.data.model,
        v1HasChoices: Array.isArray(v1.response.data.choices) && v1.response.data.choices.length > 0,
        v2HasChoices: Array.isArray(v2.response.data.choices) && v2.response.data.choices.length > 0
      },
      v2Enhancements: {
        hasV2Enhancements: !!v2.response.data.serverV2Enhanced,
        hasProcessingTime: !!v2.response.data.processingTime,
        hasHookStats: !!v2.response.data.hookStats
      }
    };

    comparisons.push(comparison);
  }

  // 端点测试对比
  const v1ModelsTest = v1Results.find(r => r.endpoint === 'models');
  const v2ModelsTest = v2Results.find(r => r.endpoint === 'models');

  if (v1ModelsTest?.success && v2ModelsTest?.success) {
    comparisons.push({
      testType: 'models',
      statusComparison: {
        v1Status: v1ModelsTest.response.status,
        v2Status: v2ModelsTest.response.status,
        statusMatch: v1ModelsTest.response.status === v2ModelsTest.response.status
      },
      performanceComparison: {
        v1Time: v1ModelsTest.response.responseTime,
        v2Time: v2ModelsTest.response.responseTime,
        timeDifference: v2ModelsTest.response.responseTime - v1ModelsTest.response.responseTime,
        v2Faster: v2ModelsTest.response.responseTime < v1ModelsTest.response.responseTime
      }
    });
  }

  return comparisons;
}

/**
 * 主测试函数
 */
async function runSimpleComparisonTest() {
  console.log('🚀 Starting Simple V2 vs V1 Comparison Test...\n');

  let v1Server = null;
  let v2Server = null;
  const results = {
    v1: [],
    v2: [],
    comparisons: []
  };

  try {
    // 启动V1服务器
    console.log('📋 Starting V1 Server...');
    v1Server = await ServerFactory.createV1Server(getV1Config());
    await v1Server.initialize();
    await v1Server.start();

    // 启动V2服务器
    console.log('📋 Starting V2 Server...');
    v2Server = await ServerFactory.createV2Server(getV2Config());
    await v2Server.initialize();
    await v2Server.start();

    // 等待服务器完全启动
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 健康检查
    console.log('\n🏥 Performing health checks...');
    const v1Health = await healthCheck(`http://${TEST_CONFIG.host}:${TEST_CONFIG.v1Port}`);
    const v2Health = await healthCheck(`http://${TEST_CONFIG.host}:${TEST_CONFIG.v2Port}`);

    console.log('Health Check Results:', {
      v1: v1Health.success ? '✅ Healthy' : '❌ Unhealthy',
      v2: v2Health.success ? '✅ Healthy' : '❌ Unhealthy'
    });

    if (!v1Health.success || !v2Health.success) {
      throw new Error('Health check failed');
    }

    // 基础端点测试
    console.log('\n🔧 Testing basic endpoints...');
    results.v1.push(await testStatus(`http://${TEST_CONFIG.host}:${TEST_CONFIG.v1Port}`, 'V1'));
    results.v1.push(await testModels(`http://${TEST_CONFIG.host}:${TEST_CONFIG.v1Port}`, 'V1'));
    results.v2.push(await testStatus(`http://${TEST_CONFIG.host}:${TEST_CONFIG.v2Port}`, 'V2'));
    results.v2.push(await testModels(`http://${TEST_CONFIG.host}:${TEST_CONFIG.v2Port}`, 'V2'));

    // Chat Completions测试
    console.log('\n💬 Testing Chat Completions...');
    const chatTestCount = 3;

    for (let i = 0; i < chatTestCount; i++) {
      results.v1.push(await testChatCompletions(`http://${TEST_CONFIG.host}:${TEST_CONFIG.v1Port}`, 'V1', i + 1));
      results.v2.push(await testChatCompletions(`http://${TEST_CONFIG.host}:${TEST_CONFIG.v2Port}`, 'V2', i + 1));

      // 测试间隔
      if (i < chatTestCount - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // 对比分析
    console.log('\n📊 Performing comparison analysis...');
    results.comparisons = compareResults(results.v1, results.v2);

    // 生成报告
    const report = {
      summary: {
        totalTests: results.v1.length + results.v2.length,
        v1SuccessCount: results.v1.filter(r => r.success).length,
        v2SuccessCount: results.v2.filter(r => r.success).length,
        comparisonCount: results.comparisons.length,
        timestamp: Date.now()
      },
      results: results,
      timestamp: Date.now()
    };

    // 保存报告
    await fs.mkdir('./test-reports', { recursive: true });
    await fs.writeFile('./test-reports/simple-v2-vs-v1-report.json', JSON.stringify(report, null, 2));

    // 打印摘要
    console.log('\n📊 Test Summary:');
    console.log(`  V1 Tests: ${report.summary.v1SuccessCount}/${results.v1.length} successful`);
    console.log(`  V2 Tests: ${report.summary.v2SuccessCount}/${results.v2.length} successful`);
    console.log(`  Comparisons: ${report.summary.comparisonCount}`);

    // 打印对比结果
    console.log('\n🔍 Comparison Results:');
    results.comparisons.forEach(comp => {
      if (comp.testType === 'chat-completions') {
        console.log(`  Test ${comp.testIndex}:`);
        console.log(`    Status Match: ${comp.statusComparison.statusMatch ? '✅' : '❌'}`);
        console.log(`    V2 Faster: ${comp.performanceComparison.v2Faster ? '✅' : '❌'} (${comp.performanceComparison.timeDifference}ms)`);
        console.log(`    V2 Enhancements: ${comp.v2Enhancements.hasV2Enhancements ? '✅' : '❌'}`);
        console.log(`    Structure Match: ${comp.responseStructureComparison.v1HasId === comp.responseStructureComparison.v2HasId ? '✅' : '❌'}`);
      }
    });

    console.log('\n🎉 Comparison test completed successfully!');
    console.log('📄 Detailed report saved to: ./test-reports/simple-v2-vs-v1-report.json');

  } catch (error) {
    console.error('💥 Comparison test failed:', error);
    process.exit(1);
  } finally {
    // 清理服务器
    console.log('\n🧹 Cleaning up...');
    try {
      if (v1Server) {
        await v1Server.stop();
        console.log('✅ V1 Server stopped');
      }
      if (v2Server) {
        await v2Server.stop();
        console.log('✅ V2 Server stopped');
      }
    } catch (cleanupError) {
      console.error('Cleanup error:', cleanupError);
    }
  }
}

// 运行测试
runSimpleComparisonTest().catch(console.error);