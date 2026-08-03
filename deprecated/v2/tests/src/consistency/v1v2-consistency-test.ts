/**
 * V1/V2一致性对比测试主类
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { SnapshotLoader } from '../utils/snapshot-loader.js';
import { ConsistencyValidator } from '../utils/consistency-validator.js';
import { 
  ConsistencyTestCase, 
  ConsistencyReport, 
  ConsistencyTestConfig,
  ConsistencySummary,
  ConsistencyTestResult,
  ConsistencyFailure
} from '../utils/consistency-types.js';

export class V1V2ConsistencyTest {
  private config: ConsistencyTestConfig;
  private loader: SnapshotLoader;
  private validator: ConsistencyValidator;
  private results: ConsistencyTestResult[] = [];
  private failures: ConsistencyFailure[] = [];

  constructor(config?: Partial<ConsistencyTestConfig>) {
    this.config = {
      samplesDir: path.join(process.env.HOME || '', '.routecodex/codex-samples'),
      outputDir: './test-results',
      maxTestCases: 20,
      ignoreFields: [
        'created', 'created_at', 'timestamp', 'request_id', 'id',
        'meta.buildTime', 'meta.version'
      ],
      tolerance: {
        timeDifference: 5000,
        numericPrecision: 6
      },
      ...config
    };

    this.loader = new SnapshotLoader(this.config.samplesDir);
    this.validator = new ConsistencyValidator();
  }

  /**
   * 运行所有一致性测试
   */
  async runAllTests(): Promise<ConsistencyReport> {
    console.log('🔄 开始V1/V2一致性测试');
    console.log('================================');

    // 1. 加载测试用例
    console.log('📋 加载测试用例...');
    const testCases = await this.loader.loadAllSnapshots();
    const limitedCases = testCases.slice(0, this.config.maxTestCases);
    console.log(`📋 找到 ${testCases.length} 个测试用例，将测试前 ${limitedCases.length} 个`);

    // 2. 运行每个测试用例
    for (let i = 0; i < limitedCases.length; i++) {
      const testCase = limitedCases[i];
      console.log(`\n🧪 测试用例 ${i + 1}/${limitedCases.length}: ${testCase.id} (${testCase.protocol})`);

      try {
        const result = await this.runSingleTest(testCase);
        this.results.push(result);

        if (result.passed) {
          console.log(`  ✅ 通过: ${result.executionTime}ms`);
        } else {
          console.log(`  ❌ 失败: ${result.checks.filter(c => !c.passed).length} 项检查失败`);
          
          // 记录失败详情
          const failedChecks = result.checks.filter(c => !c.passed);
          for (const check of failedChecks) {
            const failure: ConsistencyFailure = {
              testCaseId: testCase.id,
              category: check.category,
              severity: this.getMaxSeverity(check.differences),
              description: check.details,
              v1Result: testCase.v1Data,
              v2Result: testCase.v2Data,
              differences: check.differences
            };
            this.failures.push(failure);
          }
        }

        // 显示检查详情
        for (const check of result.checks) {
          const status = check.passed ? '✅' : '❌';
          console.log(`    ${status} ${check.category}: ${check.details}`);
        }

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.log(`  ❌ 测试异常: ${errorMsg}`);
        
        const failure: ConsistencyFailure = {
          testCaseId: testCase.id,
          category: 'test-execution',
          severity: 'critical',
          description: `Test execution failed: ${errorMsg}`,
          v1Result: testCase.v1Data,
          v2Result: testCase.v2Data,
          differences: []
        };
        this.failures.push(failure);
      }
    }

    // 3. 生成报告
    const report = await this.generateReport();
    
    // 4. 保存报告
    await this.saveReport(report);

    this.printSummary(report);
    return report;
  }

  /**
   * 运行单个测试用例
   */
  private async runSingleTest(testCase: ConsistencyTestCase): Promise<ConsistencyTestResult> {
    const startTime = Date.now();

    try {
      // 验证一致性
      const checks = await this.validator.validateConsistency(
        testCase.v1Data,
        testCase.v2Data
      );

      const executionTime = Date.now() - startTime;
      const passed = checks.every(check => check.passed);

      return {
        testCaseId: testCase.id,
        protocol: testCase.protocol,
        passed,
        checks,
        executionTime
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      throw error;
    }
  }

  /**
   * 生成测试报告
   */
  private async generateReport(): Promise<ConsistencyReport> {
    const summary = this.calculateSummary();
    const recommendations = this.generateRecommendations();

    return {
      summary,
      testResults: this.results,
      failures: this.failures,
      recommendations
    };
  }

  /**
   * 计算测试摘要
   */
  private calculateSummary(): ConsistencySummary {
    const totalTests = this.results.length;
    const passedTests = this.results.filter(r => r.passed).length;
    const failedTests = totalTests - passedTests;

    // 计算各类别一致性率
    const providerRequestChecks = this.extractChecksByCategory('provider-request');
    const providerResponseChecks = this.extractChecksByCategory('provider-response');
    const toolProcessingChecks = this.extractChecksByCategory('tool-processing');
    const finalResponseChecks = this.extractChecksByCategory('final-response');

    return {
      totalTests,
      passedTests,
      failedTests,
      consistencyRate: totalTests > 0 ? (passedTests / totalTests) * 100 : 0,
      providerRequestConsistency: this.calculateConsistencyRate(providerRequestChecks),
      providerResponseConsistency: this.calculateConsistencyRate(providerResponseChecks),
      toolProcessingConsistency: this.calculateConsistencyRate(toolProcessingChecks),
      finalResponseConsistency: this.calculateConsistencyRate(finalResponseChecks)
    };
  }

  /**
   * 提取指定类别的检查
   */
  private extractChecksByCategory(category: string) {
    const allChecks: any[] = [];
    for (const result of this.results) {
      const checks = result.checks.filter(c => c.category === category);
      allChecks.push(...checks);
    }
    return allChecks;
  }

  /**
   * 计算一致性率
   */
  private calculateConsistencyRate(checks: any[]): number {
    if (checks.length === 0) return 100;
    const passed = checks.filter(c => c.passed).length;
    return (passed / checks.length) * 100;
  }

  /**
   * 生成改进建议
   */
  private generateRecommendations(): string[] {
    const recommendations: string[] = [];

    // 分析失败模式
    const criticalFailures = this.failures.filter(f => f.severity === 'critical');
    const majorFailures = this.failures.filter(f => f.severity === 'major');

    if (criticalFailures.length > 0) {
      recommendations.push(`发现 ${criticalFailures.length} 个关键错误，需要立即修复`);
    }

    if (majorFailures.length > 0) {
      recommendations.push(`发现 ${majorFailures.length} 个重要错误，建议优先修复`);
    }

    // 按类别分析
    const categories = ['provider-request', 'provider-response', 'tool-processing', 'final-response'];
    for (const category of categories) {
      const categoryFailures = this.failures.filter(f => f.category === category);
      if (categoryFailures.length > 2) {
        recommendations.push(`${category} 类别有较多不一致，需要重点检查`);
      }
    }

    if (recommendations.length === 0) {
      recommendations.push('V1/V2一致性良好，继续保持');
    }

    return recommendations;
  }

  /**
   * 保存报告
   */
  private async saveReport(report: ConsistencyReport): Promise<void> {
    try {
      await fs.mkdir(this.config.outputDir, { recursive: true });
      const reportPath = path.join(this.config.outputDir, `consistency-report-${Date.now()}.json`);
      await this.loader.saveReport(report, reportPath);
      console.log(`\n📄 测试报告已保存到: ${reportPath}`);
    } catch (error) {
      console.warn('保存报告失败:', error);
    }
  }

  /**
   * 打印测试摘要
   */
  private printSummary(report: ConsistencyReport): void {
    console.log('\n📊 V1/V2一致性测试摘要');
    console.log('========================');
    console.log(`✅ 通过测试: ${report.summary.passedTests}/${report.summary.totalTests}`);
    console.log(`❌ 失败测试: ${report.summary.failedTests}/${report.summary.totalTests}`);
    console.log(`📈 总体一致性率: ${report.summary.consistencyRate.toFixed(2)}%`);

    console.log('\n📋 分类一致性率:');
    console.log(`  🌐 Provider请求: ${report.summary.providerRequestConsistency.toFixed(2)}%`);
    console.log(`  📡 Provider响应: ${report.summary.providerResponseConsistency.toFixed(2)}%`);
    console.log(`  🔧 工具处理: ${report.summary.toolProcessingConsistency.toFixed(2)}%`);
    console.log(`  📤 最终响应: ${report.summary.finalResponseConsistency.toFixed(2)}%`);

    if (report.failures.length > 0) {
      console.log('\n🚨 失败统计:');
      const critical = report.failures.filter(f => f.severity === 'critical').length;
      const major = report.failures.filter(f => f.severity === 'major').length;
      const minor = report.failures.filter(f => f.severity === 'minor').length;
      console.log(`  🔴 关键错误: ${critical}`);
      console.log(`  🟡 重要错误: ${major}`);
      console.log(`  🟢 轻微错误: ${minor}`);
    }

    console.log('\n💡 改进建议:');
    report.recommendations.forEach(rec => {
      console.log(`  • ${rec}`);
    });
  }

  /**
   * 获取差异的最大严重程度
   */
  private getMaxSeverity(differences: any[]): 'critical' | 'major' | 'minor' {
    if (differences.some(d => d.severity === 'critical')) return 'critical';
    if (differences.some(d => d.severity === 'major')) return 'major';
    return 'minor';
  }

  /**
   * 运行特定协议的测试
   */
  async runProtocolTests(protocol: 'openai-chat' | 'anthropic-messages' | 'openai-responses'): Promise<ConsistencyReport> {
    console.log(`🔄 开始 ${protocol} 协议一致性测试`);
    
    const testCases = await this.loader.loadAllSnapshots();
    const protocolCases = testCases.filter(tc => tc.protocol === protocol).slice(0, this.config.maxTestCases);
    
    console.log(`📋 找到 ${protocolCases.length} 个 ${protocol} 测试用例`);

    // 重置结果
    this.results = [];
    this.failures = [];

    // 运行测试
    for (const testCase of protocolCases) {
      const result = await this.runSingleTest(testCase);
      this.results.push(result);
      
      if (!result.passed) {
        const failedChecks = result.checks.filter(c => !c.passed);
        for (const check of failedChecks) {
          const failure: ConsistencyFailure = {
            testCaseId: testCase.id,
            category: check.category,
            severity: this.getMaxSeverity(check.differences),
            description: check.details,
            v1Result: testCase.v1Data,
            v2Result: testCase.v2Data,
            differences: check.differences
          };
          this.failures.push(failure);
        }
      }
    }

    return await this.generateReport();
  }
}
