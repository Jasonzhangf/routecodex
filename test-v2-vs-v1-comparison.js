/**
 * V2 vs V1 服务器对比测试
 *
 * 使用现有的配置样本进行单元测试，检查输入输出和V1的差异
 */

import { ServerFactory } from './dist/server-factory.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * 测试配置类
 */
class ComparisonTestConfig {
  constructor() {
    this.v1Port = 5506;  // V1服务器端口
    this.v2Port = 5507;  // V2服务器端口
    this.v1Host = '127.0.0.1';
    this.v2Host = '127.0.0.1';
    this.timeout = 30000; // 30秒超时
    this.retries = 3;     // 重试次数
  }

  // V1服务器配置
  getV1ServerConfig() {
    return {
      server: {
        port: this.v1Port,
        host: this.v1Host,
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
            },
            'gpt-oss-20b-mlx': {
              maxTokens: 8192,
              temperature: 0.5
            }
          }
        }
      }
    };
  }

  // V2服务器配置
  getV2ServerConfig() {
    return {
      server: {
        port: this.v2Port,
        host: this.v2Host,
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
            },
            'gpt-oss-20b-mlx': {
              maxTokens: 8192,
              temperature: 0.5
            }
          }
        }
      },
      v2Config: {
        enableHooks: true,
        enableMiddleware: true
      }
    };
  }
}

/**
 * 测试结果收集器
 */
class TestResultCollector {
  constructor() {
    this.results = {
      v1: {},
      v2: {},
      comparison: {}
    };
    this.errors = [];
  }

  addResult(version, testId, result) {
    this.results[version][testId] = {
      ...result,
      timestamp: Date.now()
    };
  }

  addComparison(testId, comparison) {
    this.results.comparison[testId] = {
      ...comparison,
      timestamp: Date.now()
    };
  }

  addError(error) {
    this.errors.push({
      error: error.message,
      stack: error.stack,
      timestamp: Date.now()
    });
  }

  generateReport() {
    const report = {
      summary: {
        totalTests: Object.keys(this.results.comparison).length,
        v1SuccessCount: Object.keys(this.results.v1).length,
        v2SuccessCount: Object.keys(this.results.v2).length,
        errorCount: this.errors.length,
        timestamp: Date.now()
      },
      results: this.results,
      errors: this.errors
    };

    return report;
  }

  async saveReport(filePath) {
    const report = this.generateReport();
    await fs.writeFile(filePath, JSON.stringify(report, null, 2));
    console.log(`📊 Test report saved to: ${filePath}`);
  }
}

/**
 * HTTP请求工具
 */
class HttpClient {
  static async makeRequest(url, options = {}) {
    const defaultOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key'
      },
      timeout: 30000
    };

    const finalOptions = { ...defaultOptions, ...options };

    try {
      const response = await fetch(url, finalOptions);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        data,
        responseTime: Date.now()
      };
    } catch (error) {
      throw new Error(`Request failed: ${error.message}`);
    }
  }

  static async makeChatRequest(baseUrl, requestData) {
    const url = `${baseUrl}/v1/chat/completions`;

    // 适配测试数据格式到OpenAI格式
    const openaiRequest = {
      model: requestData.data.model,
      messages: requestData.data.messages,
      temperature: requestData.data.temperature,
      max_tokens: requestData.data.max_tokens,
      ...(requestData.data.tools && { tools: requestData.data.tools })
    };

    const result = await this.makeRequest(url, {
      body: JSON.stringify(openaiRequest)
    });

    return {
      ...result,
      originalRequest: requestData,
      processedRequest: openaiRequest
    };
  }

  static async makeV2ChatRequest(baseUrl, requestData) {
    const url = `${baseUrl}/v2/chat/completions`;

    // V2使用相同的格式，但会有不同的处理
    const v2Request = {
      model: requestData.data.model,
      messages: requestData.data.messages,
      temperature: requestData.data.temperature,
      max_tokens: requestData.data.max_tokens,
      ...(requestData.data.tools && { tools: requestData.data.tools })
    };

    const result = await this.makeRequest(url, {
      body: JSON.stringify(v2Request)
    });

    return {
      ...result,
      originalRequest: requestData,
      processedRequest: v2Request
    };
  }

  static async healthCheck(baseUrl) {
    const url = `${baseUrl}/health`;
    const result = await this.makeRequest(url, { method: 'GET' });
    return result;
  }
}

/**
 * 对比分析器
 */
class ComparisonAnalyzer {
  static analyzeResponses(v1Result, v2Result, requestId) {
    const comparison = {
      requestId,
      statusComparison: {
        v1Status: v1Result?.status || 'failed',
        v2Status: v2Result?.status || 'failed',
        statusMatch: (v1Result?.status || 0) === (v2Result?.status || 0)
      },
      responseTimeComparison: {
        v1Time: v1Result?.responseTime || 0,
        v2Time: v2Result?.responseTime || 0,
        timeDifference: (v2Result?.responseTime || 0) - (v1Result?.responseTime || 0),
        v2Faster: (v2Result?.responseTime || 0) < (v1Result?.responseTime || 0)
      },
      responseDataComparison: {
        v1Data: v1Result?.data || null,
        v2Data: v2Result?.data || null,
        structureMatch: this.compareDataStructure(v1Result?.data, v2Result?.data),
        contentDifferences: this.findContentDifferences(v1Result?.data, v2Result?.data)
      },
      v2Enhancements: {
        hasV2Enhancements: this.checkV2Enhancements(v2Result?.data),
        hookStats: this.extractHookStats(v2Result?.data),
        processingTime: this.extractProcessingTime(v2Result?.data)
      }
    };

    return comparison;
  }

  static compareDataStructure(data1, data2) {
    if (!data1 || !data2) return { match: false, reason: 'Missing data' };

    const keys1 = Object.keys(data1).sort();
    const keys2 = Object.keys(data2).sort();

    const match = JSON.stringify(keys1) === JSON.stringify(keys2);
    const missingInV2 = keys1.filter(key => !keys2.includes(key));
    const additionalInV2 = keys2.filter(key => !keys1.includes(key));

    return {
      match,
      missingInV2,
      additionalInV2,
      v1Keys: keys1,
      v2Keys: keys2
    };
  }

  static findContentDifferences(data1, data2) {
    if (!data1 || !data2) return { differences: ['Missing data comparison'] };

    const differences = [];

    // 比较关键字段
    const keyFields = ['id', 'model', 'object'];
    for (const field of keyFields) {
      if (data1[field] !== data2[field]) {
        differences.push(`${field}: V1="${data1[field]}" vs V2="${data2[field]}"`);
      }
    }

    // 比较choices数组
    if (data1.choices && data2.choices) {
      if (data1.choices.length !== data2.choices.length) {
        differences.push(`choices length: V1=${data1.choices.length} vs V2=${data2.choices.length}`);
      }

      for (let i = 0; i < Math.min(data1.choices.length, data2.choices.length); i++) {
        const v1Choice = data1.choices[i];
        const v2Choice = data2.choices[i];

        if (v1Choice.message?.content !== v2Choice.message?.content) {
          differences.push(`choice[${i}].content differs`);
        }
      }
    }

    return { differences };
  }

  static checkV2Enhancements(data) {
    if (!data) return false;

    const enhancementFields = ['serverV2Enhanced', 'hookStats', 'processingTime'];
    return enhancementFields.some(field => data[field] !== undefined);
  }

  static extractHookStats(data) {
    return data?.hookStats || null;
  }

  static extractProcessingTime(data) {
    return data?.processingTime || null;
  }
}

/**
 * 主测试类
 */
class V2VsV1ComparisonTest {
  constructor() {
    this.config = new ComparisonTestConfig();
    this.collector = new TestResultCollector();
    this.v1Server = null;
    this.v2Server = null;
  }

  async setup() {
    console.log('🚀 Setting up V2 vs V1 Comparison Test...');

    try {
      // 启动V1服务器
      console.log('📋 Starting V1 Server...');
      this.v1Server = await ServerFactory.createV1Server(this.config.getV1ServerConfig());
      await this.v1Server.initialize();
      await this.v1Server.start();

      // 启动V2服务器
      console.log('📋 Starting V2 Server...');
      this.v2Server = await ServerFactory.createV2Server(this.config.getV2ServerConfig());
      await this.v2Server.initialize();
      await this.v2Server.start();

      // 等待服务器完全启动
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 健康检查
      const v1Health = await HttpClient.healthCheck(`http://${this.config.v1Host}:${this.config.v1Port}`);
      const v2Health = await HttpClient.healthCheck(`http://${this.config.v2Host}:${this.config.v2Port}`);

      console.log('✅ Health checks passed:', {
        v1: v1Health.data.status,
        v2: v2Health.data.status
      });

    } catch (error) {
      this.collector.addError(error);
      throw error;
    }
  }

  async cleanup() {
    console.log('🧹 Cleaning up test environment...');

    try {
      if (this.v1Server) {
        await this.v1Server.stop();
      }
      if (this.v2Server) {
        await this.v2Server.stop();
      }
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }

  async loadTestConfigs() {
    console.log('📁 Loading test configurations...');

    const configFiles = [
      './config/dry-run/single-test-request.json',
      './config/dry-run/multi-provider-test-request.json',
      './config/dry-run/batch-test-requests.json'
    ];

    const configs = [];

    for (const file of configFiles) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        const data = JSON.parse(content);

        if (Array.isArray(data)) {
          configs.push(...data);
        } else {
          configs.push(data);
        }
      } catch (error) {
        console.warn(`⚠️  Failed to load ${file}:`, error.message);
      }
    }

    console.log(`✅ Loaded ${configs.length} test configurations`);
    return configs;
  }

  async runTest(testConfig, index) {
    const testId = testConfig.route?.requestId || `test-${index}`;
    console.log(`🧪 Running test ${index + 1}: ${testId}`);

    try {
      // V1请求
      const v1BaseUrl = `http://${this.config.v1Host}:${this.config.v1Port}`;
      const v1Result = await HttpClient.makeChatRequest(v1BaseUrl, testConfig);
      this.collector.addResult('v1', testId, v1Result);

      // V2请求
      const v2BaseUrl = `http://${this.config.v2Host}:${this.config.v2Port}`;
      const v2Result = await HttpClient.makeV2ChatRequest(v2BaseUrl, testConfig);
      this.collector.addResult('v2', testId, v2Result);

      // 对比分析
      const comparison = ComparisonAnalyzer.analyzeResponses(v1Result, v2Result, testId);
      this.collector.addComparison(testId, comparison);

      console.log(`✅ Test ${testId} completed:`, {
        statusMatch: comparison.statusComparison.statusMatch,
        v2Faster: comparison.responseTimeComparison.v2Faster,
        hasEnhancements: comparison.v2Enhancements.hasV2Enhancements,
        structureMatch: comparison.responseDataComparison.structureMatch.match
      });

    } catch (error) {
      this.collector.addError(error);
      console.error(`❌ Test ${testId} failed:`, error.message);
    }
  }

  async runAllTests() {
    const testConfigs = await this.loadTestConfigs();

    if (testConfigs.length === 0) {
      throw new Error('No test configurations loaded');
    }

    console.log(`🎯 Running ${testConfigs.length} comparison tests...`);

    for (let i = 0; i < testConfigs.length; i++) {
      await this.runTest(testConfigs[i], i);

      // 测试间隔，避免过载
      if (i < testConfigs.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  async generateAndSaveReport() {
    const reportPath = './test-reports/v2-vs-v1-comparison-report.json';

    // 确保目录存在
    await fs.mkdir(path.dirname(reportPath), { recursive: true });

    await this.collector.saveReport(reportPath);

    // 打印摘要
    const summary = this.collector.generateReport().summary;
    console.log('\n📊 Test Summary:');
    console.log(`  Total Tests: ${summary.totalTests}`);
    console.log(`  V1 Success: ${summary.v1SuccessCount}`);
    console.log(`  V2 Success: ${summary.v2SuccessCount}`);
    console.log(`  Errors: ${summary.errorCount}`);

    return reportPath;
  }
}

/**
 * 主执行函数
 */
async function runComparisonTest() {
  const test = new V2VsV1ComparisonTest();

  try {
    await test.setup();
    await test.runAllTests();
    const reportPath = await test.generateAndSaveReport();

    console.log('\n🎉 Comparison test completed successfully!');
    console.log(`📄 Detailed report available at: ${reportPath}`);

  } catch (error) {
    console.error('💥 Comparison test failed:', error);
    process.exit(1);
  } finally {
    await test.cleanup();
  }
}

// 运行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  runComparisonTest().catch(console.error);
}

export { V2VsV1ComparisonTest, ComparisonAnalyzer, TestResultCollector };