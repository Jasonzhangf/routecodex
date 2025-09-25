#!/usr/bin/env node

// 429错误处理端到端测试脚本
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ES模块中的__dirname替代方案
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SERVER_URL = 'http://localhost:4005';
const OPENAI_ENDPOINT = `${SERVER_URL}/v1/openai/chat/completions`;

// 测试数据
const testRequests = [
  {
    id: 'test-1',
    model: 'modelscope_key1.Qwen/Qwen3-Coder-480B-A35B-Instruct',
    messages: [{ role: 'user', content: 'Hello, please respond quickly' }],
    temperature: 0.7
  },
  {
    id: 'test-2',
    model: 'modelscope_key2.Qwen/Qwen3-Coder-480B-A35B-Instruct',
    messages: [{ role: 'user', content: 'This is a test message' }],
    temperature: 0.7
  },
  {
    id: 'test-3',
    model: 'modelscope_key3.Qwen/Qwen3-Coder-480B-A35B-Instruct',
    messages: [{ role: 'user', content: 'Another test request' }],
    temperature: 0.7
  },
  {
    id: 'test-4',
    model: 'modelscope_key4.Qwen/Qwen3-Coder-480B-A35B-Instruct',
    messages: [{ role: 'user', content: 'Final test message' }],
    temperature: 0.7
  }
];

class Test429Handler {
  constructor() {
    this.results = [];
    this.errors = [];
    this.startTime = Date.now();
  }

  log(message, level = 'info') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
  }

  async sendRequest(requestData, retryCount = 0) {
    try {
      this.log(`Sending request ${requestData.id} (attempt ${retryCount + 1})`);

      const response = await axios.post(OPENAI_ENDPOINT, requestData, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': '429-Test-Client/1.0'
        },
        timeout: 30000
      });

      this.log(`Request ${requestData.id} successful (status: ${response.status})`);
      return {
        success: true,
        requestId: requestData.id,
        status: response.status,
        data: response.data,
        retryCount
      };
    } catch (error) {
      if (error.response) {
        this.log(`Request ${requestData.id} failed with status ${error.response.status}`, 'warn');

        // 检查是否是429错误
        if (error.response.status === 429) {
          this.log(`429 error detected for request ${requestData.id}`, 'error');

          // 检查重试头信息
          const retryAfter = error.response.headers['retry-after'] ||
                            error.response.headers['x-ratelimit-reset'] ||
                            5;

          this.log(`Retry-After header: ${retryAfter} seconds`, 'info');

          return {
            success: false,
            requestId: requestData.id,
            status: 429,
            error: 'Too Many Requests',
            retryAfter: parseInt(retryAfter),
            retryCount
          };
        }

        return {
          success: false,
          requestId: requestData.id,
          status: error.response.status,
          error: error.response.statusText,
          retryCount
        };
      } else if (error.code === 'ECONNABORTED') {
        this.log(`Request ${requestData.id} timed out`, 'warn');
        return {
          success: false,
          requestId: requestData.id,
          error: 'Timeout',
          retryCount
        };
      } else {
        this.log(`Request ${requestData.id} failed: ${error.message}`, 'error');
        return {
          success: false,
          requestId: requestData.id,
          error: error.message,
          retryCount
        };
      }
    }
  }

  async testRateLimiting() {
    this.log('Starting 429 error handling test...');

    // 并发发送请求以触发速率限制
    const concurrentRequests = testRequests.map(req => this.sendRequest(req));
    const results = await Promise.all(concurrentRequests);

    this.results.push(...results);

    // 分析结果
    this.analyzeResults(results);

    // 测试重试机制
    await this.testRetryMechanism();

    // 生成测试报告
    this.generateReport();
  }

  async testRetryMechanism() {
    this.log('Testing retry mechanism...');

    // 找出失败的请求并重试
    const failedRequests = this.results.filter(r => !r.success && r.status === 429);

    for (const failed of failedRequests) {
      this.log(`Retrying failed request ${failed.requestId} after ${failed.retryAfter} seconds...`);

      // 等待重试时间
      await new Promise(resolve => setTimeout(resolve, failed.retryAfter * 1000));

      const originalRequest = testRequests.find(req => req.id === failed.requestId);
      const retryResult = await this.sendRequest(originalRequest, failed.retryCount + 1);

      this.results.push(retryResult);

      if (retryResult.success) {
        this.log(`Retry successful for request ${failed.requestId}`);
      } else {
        this.log(`Retry failed for request ${failed.requestId}`, 'error');
      }
    }
  }

  analyzeResults(results) {
    this.log('Analyzing test results...');

    const successful = results.filter(r => r.success);
    const failed429 = results.filter(r => !r.success && r.status === 429);
    const otherErrors = results.filter(r => !r.success && r.status !== 429);

    this.log(`Total requests: ${results.length}`);
    this.log(`Successful: ${successful.length}`);
    this.log(`429 errors: ${failed429.length}`);
    this.log(`Other errors: ${otherErrors.length}`);

    // 检查429错误处理
    if (failed429.length > 0) {
      this.log('429 error handling detected:', 'info');
      failed429.forEach(error => {
        this.log(`  - Request ${error.requestId}: Retry-After ${error.retryAfter}s`, 'info');
      });
    }

    // 检查负载均衡
    const pipelineUsage = {};
    successful.forEach(result => {
      const pipeline = result.data?.pipeline || 'unknown';
      pipelineUsage[pipeline] = (pipelineUsage[pipeline] || 0) + 1;
    });

    this.log('Pipeline usage distribution:', 'info');
    Object.entries(pipelineUsage).forEach(([pipeline, count]) => {
      this.log(`  - ${pipeline}: ${count} requests`, 'info');
    });
  }

  generateReport() {
    const report = {
      testId: `429-test-${Date.now()}`,
      timestamp: new Date().toISOString(),
      duration: Date.now() - this.startTime,
      results: this.results,
      summary: {
        total: this.results.length,
        successful: this.results.filter(r => r.success).length,
        failed429: this.results.filter(r => !r.success && r.status === 429).length,
        otherErrors: this.results.filter(r => !r.success && r.status !== 429).length
      },
      errors: this.errors
    };

    // 保存报告
    const reportPath = path.join(__dirname, 'test-results', `429-test-${Date.now()}.json`);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    this.log(`Test report saved to: ${reportPath}`);

    // 输出摘要
    console.log('\n=== Test Summary ===');
    console.log(`Duration: ${report.duration}ms`);
    console.log(`Success Rate: ${((report.summary.successful / report.summary.total) * 100).toFixed(2)}%`);
    console.log(`429 Error Rate: ${((report.summary.failed429 / report.summary.total) * 100).toFixed(2)}%`);

    if (report.summary.failed429 > 0) {
      console.log('✅ 429 error handling is working');
    } else {
      console.log('⚠️  No 429 errors detected - rate limiting may not be triggered');
    }
  }
}

// 运行测试
async function runTest() {
  const tester = new Test429Handler();

  try {
    await tester.testRateLimiting();
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

runTest();