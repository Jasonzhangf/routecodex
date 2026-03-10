#!/usr/bin/env node

/**
 * 回环测试CLI执行器
 * 基于设计文档 docs/ROUNDTRIP_TEST_DESIGN.md:400-450
 */

import { program, Command } from 'commander';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, join, dirname } from 'path';
import { load } from 'js-yaml';
import chalk from 'chalk';
import ora from 'ora';

// 导入测试框架组件
import { SchemaValidator } from '../validation/schema-validator.js';
import { RealisticMockClient, RequestRecorder, SampleData } from '../mock/realistic-mock-client.js';
import { ReceiverFactory, Receiver } from '../receivers/pluggable-receiver.js';
import { ConfigDrivenRuleLoader, TestConfig } from '../config/rule-loader.js';

export interface TestResult {
  sampleId: string;
  testName: string;
  protocol: 'responses' | 'chat';
  category: string;
  status: 'passed' | 'failed' | 'skipped';
  errors: string[];
  warnings: string[];
  metrics: {
    requestTime: number;
    responseTime: number;
    processingTime: number;
    totalTime: number;
  };
  streaming?: {
    chunkCount: number;
    sequenceValid: boolean;
  };
}

export interface TestReport {
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    successRate: number;
    totalTime: number;
  };
  results: TestResult[];
  generatedAt: string;
  config: TestConfig;
}

/**
 * 回环测试执行器
 */
export class RoundtripTestExecutor {
  private validator: SchemaValidator;
  private ruleLoader: ConfigDrivenRuleLoader;
  private recorder: RequestRecorder;
  private config: TestConfig | null = null;
  private receiver: Receiver | null = null;
  private mockClient: RealisticMockClient | null = null;

  constructor(private configPath: string) {
    this.validator = new SchemaValidator();
    this.ruleLoader = new ConfigDrivenRuleLoader(configPath);
    this.recorder = new RequestRecorder();
  }

  /**
   * 初始化测试环境
   */
  async initialize(): Promise<void> {
    const spinner = ora('Initializing test environment...').start();

    try {
      // 加载配置
      spinner.text = 'Loading configuration...';
      this.config = await this.ruleLoader.loadConfig();

      // 加载规则集
      spinner.text = 'Loading validation rules...';
      await this.ruleLoader.loadRuleSets();

      // 初始化接收器
      spinner.text = 'Initializing receiver...';
      const receiverConfig = this.config.receivers.default ||
                           Object.values(this.config.receivers)[0];
      this.receiver = ReceiverFactory.create(receiverConfig);
      await this.receiver.initialize();

      // 初始化Mock客户端
      spinner.text = 'Setting up mock client...';
      const mockConfig = {
        apiKey: 'test-api-key',
        baseUrl: this.getMockServerUrl(),
        timeoutMs: 30000,
        debugMode: true
      };
      this.mockClient = new RealisticMockClient(mockConfig, this.recorder);

      spinner.succeed('Test environment initialized successfully');
    } catch (error) {
      const message = getErrorMessage(error);
      spinner.fail(`Initialization failed: ${message}`);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  /**
   * 运行所有测试
   */
  async runAllTests(options: { parallel?: boolean; filter?: string } = {}): Promise<TestReport> {
    if (!this.config) {
      throw new Error('Test executor not initialized');
    }

    const spinner = ora('Discovering test samples...').start();

    try {
      // 加载测试样本
      spinner.text = 'Loading test samples...';
      const samples = await this.loadTestSamples();

      if (options.filter) {
        const filtered = samples.filter(sample =>
          sample.sampleId.includes(options.filter!) ||
          sample.category.includes(options.filter!) ||
          sample.name.includes(options.filter!)
        );
        spinner.info(`Filtered samples: ${filtered.length} of ${samples.length}`);
        samples.splice(0, samples.length, ...filtered);
      }

      spinner.succeed(`Found ${samples.length} test samples`);

      // 执行测试
      const reportSpinner = ora('Running tests...').start();
      const startTime = Date.now();

      let results: TestResult[];

      if (options.parallel && this.config.execution.parallel) {
        results = await this.runTestsParallel(samples);
      } else {
        results = await this.runTestsSequential(samples);
      }

      const totalTime = Date.now() - startTime;

      // 生成报告
      const report: TestReport = {
        summary: {
          total: results.length,
          passed: results.filter(r => r.status === 'passed').length,
          failed: results.filter(r => r.status === 'failed').length,
          skipped: results.filter(r => r.status === 'skipped').length,
          successRate: results.filter(r => r.status === 'passed').length / results.length * 100,
          totalTime
        },
        results,
        generatedAt: new Date().toISOString(),
        config: this.config
      };

      if (report.summary.failed > 0) {
        reportSpinner.fail(`${report.summary.failed} tests failed`);
      } else {
        reportSpinner.succeed(`All ${report.summary.passed} tests passed`);
      }

      return report;
    } catch (error) {
      const message = getErrorMessage(error);
      spinner.fail(`Test execution failed: ${message}`);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  /**
   * 运行单个测试
   */
  async runSingleTest(sampleId: string): Promise<TestResult> {
    if (!this.mockClient || !this.receiver) {
      throw new Error('Test executor not initialized');
    }

    const samples = await this.loadTestSamples();
    const sample = samples.find(s => s.sampleId === sampleId);

    if (!sample) {
      throw new Error(`Sample not found: ${sampleId}`);
    }

    return await this.executeSingleTest(sample);
  }

  /**
   * 生成测试报告
   */
  generateReport(report: TestReport, outputPath?: string): void {
    const reportPath = outputPath || this.config?.execution.reportPath || 'test-report.json';
    const reportDir = dirname(reportPath);

    if (!existsSync(reportDir)) {
      mkdirSync(reportDir, { recursive: true });
    }

    const reportData = {
      ...report,
      summary: {
        ...report.summary,
        successRate: Math.round(report.summary.successRate * 100) / 100
      }
    };

    writeFileSync(reportPath, JSON.stringify(reportData, null, 2));
    console.log(chalk.green(`\n📊 Report generated: ${reportPath}`));
  }

  /**
   * 清理资源
   */
  async cleanup(): Promise<void> {
    if (this.receiver) {
      await this.receiver.cleanup();
    }
  }

  async loadTestSamples(): Promise<SampleData[]> {
    if (!this.config) {
      throw new Error('Config not loaded');
    }

    const samples: SampleData[] = [];

    for (const directory of this.config.samples.directories) {
      const dirPath = resolve(dirname(this.configPath), directory);
      const dirSamples = await this.loadSamplesFromDirectory(dirPath);
      samples.push(...dirSamples);
    }

    return samples;
  }

  private async loadSamplesFromDirectory(directory: string): Promise<SampleData[]> {
    const samples: SampleData[] = [];

    // 简化实现：查找JSON文件
    // 在实际实现中，应该使用glob或类似工具
    try {
      const fs = await import('fs/promises');
      const files = await fs.readdir(directory);

      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const filePath = join(directory, file);
            const content = readFileSync(filePath, 'utf8');
            const sample = JSON.parse(content);

            // 验证样本格式
            if (this.isValidSample(sample)) {
              samples.push(sample);
            }
          } catch (error) {
            console.warn(chalk.yellow(`Warning: Failed to load sample ${file}: ${getErrorMessage(error)}`));
          }
        }
      }
    } catch (error) {
      console.warn(chalk.yellow(`Warning: Failed to read directory ${directory}: ${getErrorMessage(error)}`));
    }

    return samples;
  }

  private isValidSample(sample: any): sample is SampleData {
    return sample &&
           typeof sample === 'object' &&
           typeof sample.sampleId === 'string' &&
           typeof sample.name === 'string' &&
           ['responses', 'chat'].includes(sample.protocol) &&
           ['request', 'response'].includes(sample.type) &&
           typeof sample.payload === 'object';
  }

  private async runTestsSequential(samples: SampleData[]): Promise<TestResult[]> {
    const results: TestResult[] = [];

    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      console.log(chalk.blue(`\n[${i + 1}/${samples.length}] Testing: ${sample.name}`));

      try {
        const result = await this.executeSingleTest(sample);
        results.push(result);

        if (result.status === 'passed') {
          console.log(chalk.green(`✓ ${result.testName}`));
        } else {
          console.log(chalk.red(`✗ ${result.testName}`));
          result.errors.forEach(error => console.log(chalk.red(`  - ${error}`)));
        }

        if (result.warnings.length > 0) {
          result.warnings.forEach(warning => console.log(chalk.yellow(`  ⚠ ${warning}`)));
        }
      } catch (error) {
        const message = getErrorMessage(error);
        const failedResult: TestResult = {
          sampleId: sample.sampleId,
          testName: sample.name,
          protocol: sample.protocol,
          category: sample.category,
          status: 'failed',
          errors: [message],
          warnings: [],
          metrics: {
            requestTime: 0,
            responseTime: 0,
            processingTime: 0,
            totalTime: 0
          }
        };
        results.push(failedResult);
        console.log(chalk.red(`✗ ${sample.name}: ${message}`));
      }
    }

    return results;
  }

  private async runTestsParallel(samples: SampleData[]): Promise<TestResult[]> {
    const maxConcurrency = this.config?.execution.maxConcurrency || 4;
    const results: TestResult[] = [];

    // 分批并行执行
    for (let i = 0; i < samples.length; i += maxConcurrency) {
      const batch = samples.slice(i, i + maxConcurrency);
      const batchPromises = batch.map(sample =>
        this.executeSingleTest(sample).catch((error) => {
          const message = getErrorMessage(error);
          return {
            sampleId: sample.sampleId,
            testName: sample.name,
            protocol: sample.protocol,
            category: sample.category,
            status: 'failed' as const,
            errors: [message],
            warnings: [],
            metrics: {
              requestTime: 0,
              responseTime: 0,
              processingTime: 0,
              totalTime: 0
            }
          };
        })
      );

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // 显示进度
      console.log(chalk.blue(`Progress: ${Math.min(i + maxConcurrency, samples.length)}/${samples.length}`));
    }

    return results;
  }

  private async executeSingleTest(sample: SampleData): Promise<TestResult> {
    if (!this.mockClient || !this.receiver || !this.config) {
      throw new Error('Test executor not initialized');
    }

    const startTime = Date.now();
    const result: TestResult = {
      sampleId: sample.sampleId,
      testName: sample.name,
      protocol: sample.protocol,
      category: sample.category,
      status: 'passed',
      errors: [],
      warnings: [],
      metrics: {
        requestTime: 0,
        responseTime: 0,
        processingTime: 0,
        totalTime: 0
      }
    };

    try {
      // 1. 验证输入样本
      const requestTime = Date.now();
      if (sample.type === 'request') {
        const requestValidation = this.validator.validateRequest(sample.payload);
        if (!requestValidation.valid) {
          result.errors.push(...requestValidation.errors);
          result.status = 'failed';
        }
        result.warnings.push(...requestValidation.warnings);
      }
      result.metrics.requestTime = Date.now() - requestTime;

      if (result.status === 'failed') {
        result.metrics.totalTime = Date.now() - startTime;
        return result;
      }

      // 2. 发送请求到接收器
      const responseData = await this.sendRequestToReceiver(sample);
      const responseTime = Date.now();
      result.metrics.responseTime = responseTime - startTime;

      // 3. 验证响应
      const validationStartTime = Date.now();
      if (responseData.chunks) {
        // 流式验证
        const streamValidation = this.validator.validateStream(responseData.chunks, {
          protocol: sample.protocol
        });
        if (!streamValidation.valid) {
          result.errors.push(...streamValidation.errors);
          result.status = 'failed';
        }
        result.warnings.push(...streamValidation.warnings);
        result.streaming = {
          chunkCount: responseData.chunks.length,
          sequenceValid: streamValidation.valid
        };
      } else {
        // 常规验证
        if (sample.protocol === 'responses') {
          const responseValidation = this.validator.validateResponse(responseData.payload);
          if (!responseValidation.valid) {
            result.errors.push(...responseValidation.errors);
            result.status = 'failed';
          }
          result.warnings.push(...responseValidation.warnings);
        }
      }
      result.metrics.processingTime = Date.now() - validationStartTime;

      // 4. 执行配置的验证规则
      const ruleValidation = this.ruleLoader.executeRules(responseData);
      result.errors.push(...ruleValidation.errors);
      result.warnings.push(...ruleValidation.warnings);
      if (ruleValidation.errors.length > 0) {
        result.status = 'failed';
      }

      result.metrics.totalTime = Date.now() - startTime;
      return result;
    } catch (error) {
      result.errors.push(`Test execution failed: ${getErrorMessage(error)}`);
      result.status = 'failed';
      result.metrics.totalTime = Date.now() - startTime;
      return result;
    }
  }

  private async sendRequestToReceiver(sample: SampleData): Promise<any> {
    if (!this.receiver) {
      throw new Error('Receiver not initialized');
    }

    const requestData = {
      id: `test_${sample.sampleId}`,
      protocol: sample.protocol,
      payload: sample.payload,
      headers: sample.metadata.headers || {},
      timestamp: Date.now()
    };

    if (sample.metadata.expectedStreaming) {
      return await this.receiver.processStreaming(requestData);
    } else {
      return await this.receiver.process(requestData);
    }
  }

  private getMockServerUrl(): string {
    // 返回llmswitch-core的本地地址
    return 'http://localhost:3000';
  }
}

/**
 * CLI程序入口
 */
async function main() {
  program
    .name('roundtrip-test')
    .description('LLMSwitch Core Roundtrip Test CLI')
    .version('1.0.0');

  program
    .command('run')
    .description('Run all roundtrip tests')
    .option('-c, --config <path>', 'Configuration file path', 'test/config/roundtrip-test-config.yaml')
    .option('-p, --parallel', 'Run tests in parallel')
    .option('-f, --filter <pattern>', 'Filter tests by pattern')
    .option('-o, --output <path>', 'Output report path')
    .option('--verbose', 'Verbose output')
    .action(async (options) => {
      try {
        const executor = new RoundtripTestExecutor(options.config);
        await executor.initialize();

        const report = await executor.runAllTests({
          parallel: options.parallel,
          filter: options.filter
        });

        if (options.verbose) {
          console.log(chalk.cyan('\n📋 Test Results:'));
          report.results.forEach(result => {
            const statusColor = result.status === 'passed' ? chalk.green :
                              result.status === 'failed' ? chalk.red : chalk.yellow;
            console.log(statusColor(`${result.status.toUpperCase()}: ${result.testName}`));

            if (result.errors.length > 0) {
              result.errors.forEach(error => console.log(chalk.red(`  ✗ ${error}`)));
            }

            if (result.warnings.length > 0) {
              result.warnings.forEach(warning => console.log(chalk.yellow(`  ⚠ ${warning}`)));
            }

            console.log(chalk.gray(`  ⏱  Total: ${result.metrics.totalTime}ms`));
            if (result.streaming) {
              console.log(chalk.gray(`  📦 Chunks: ${result.streaming.chunkCount}`));
            }
          });
        }

        console.log(chalk.cyan('\n📊 Summary:'));
        console.log(`Total: ${report.summary.total}`);
        console.log(chalk.green(`Passed: ${report.summary.passed}`));
        console.log(chalk.red(`Failed: ${report.summary.failed}`));
        console.log(chalk.yellow(`Skipped: ${report.summary.skipped}`));
        console.log(`Success Rate: ${report.summary.successRate.toFixed(1)}%`);
        console.log(`Total Time: ${report.summary.totalTime}ms`);

        if (options.output || report.config.execution.reportPath) {
          executor.generateReport(report, options.output);
        }

        await executor.cleanup();

        // 退出码
        process.exit(report.summary.failed > 0 ? 1 : 0);
      } catch (error) {
        console.error(chalk.red(`Error: ${getErrorMessage(error)}`));
        process.exit(1);
      }
    });

  program
    .command('test <sampleId>')
    .description('Run a single test')
    .option('-c, --config <path>', 'Configuration file path', 'test/config/roundtrip-test-config.yaml')
    .action(async (sampleId, options) => {
      try {
        const executor = new RoundtripTestExecutor(options.config);
        await executor.initialize();

        const result = await executor.runSingleTest(sampleId);

        console.log(chalk.cyan(`\n📋 Test Result: ${result.testName}`));
        const statusColor = result.status === 'passed' ? chalk.green :
                          result.status === 'failed' ? chalk.red : chalk.yellow;
        console.log(statusColor(`${result.status.toUpperCase()}`));

        if (result.errors.length > 0) {
          console.log(chalk.red('\nErrors:'));
          result.errors.forEach(error => console.log(chalk.red(`  ✗ ${error}`)));
        }

        if (result.warnings.length > 0) {
          console.log(chalk.yellow('\nWarnings:'));
          result.warnings.forEach(warning => console.log(chalk.yellow(`  ⚠ ${warning}`)));
        }

        console.log(chalk.gray(`\nMetrics:`));
        console.log(`Request Time: ${result.metrics.requestTime}ms`);
        console.log(`Response Time: ${result.metrics.responseTime}ms`);
        console.log(`Processing Time: ${result.metrics.processingTime}ms`);
        console.log(`Total Time: ${result.metrics.totalTime}ms`);

        if (result.streaming) {
          console.log(`Streaming: ${result.streaming.chunkCount} chunks, sequence ${result.streaming.sequenceValid ? 'valid' : 'invalid'}`);
        }

        await executor.cleanup();
        process.exit(result.status === 'passed' ? 0 : 1);
      } catch (error) {
        console.error(chalk.red(`Error: ${getErrorMessage(error)}`));
        process.exit(1);
      }
    });

  program
    .command('list')
    .description('List available test samples')
    .option('-c, --config <path>', 'Configuration file path', 'test/config/roundtrip-test-config.yaml')
    .action(async (options) => {
      try {
        const executor = new RoundtripTestExecutor(options.config);
        await executor.initialize();

        const samples = await executor.loadTestSamples();

        console.log(chalk.cyan(`\n📋 Available Test Samples (${samples.length}):`));

        const grouped = samples.reduce((acc, sample) => {
          if (!acc[sample.protocol]) {
            acc[sample.protocol] = {};
          }
          if (!acc[sample.protocol][sample.category]) {
            acc[sample.protocol][sample.category] = [];
          }
          acc[sample.protocol][sample.category].push(sample);
          return acc;
        }, {} as Record<string, Record<string, SampleData[]>>);

        Object.entries(grouped).forEach(([protocol, categories]) => {
          console.log(chalk.blue(`\n${protocol.toUpperCase()}:`));
          Object.entries(categories).forEach(([category, categorySamples]) => {
            console.log(chalk.yellow(`  ${category}:`));
            categorySamples.forEach(sample => {
              console.log(`    - ${sample.sampleId}: ${sample.name}`);
            });
          });
        });

        await executor.cleanup();
      } catch (error) {
        console.error(chalk.red(`Error: ${getErrorMessage(error)}`));
        process.exit(1);
      }
    });

  await program.parseAsync();
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
