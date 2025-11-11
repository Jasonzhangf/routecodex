#!/usr/bin/env node

/**
 * 综合一致性测试脚本
 * 包含工具处理测试、协议转换测试和V1/V2对齐测试
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..', '..');

class ComprehensiveConsistencyTest {
  constructor() {
    this.testResults = {
      toolProcessing: null,
      protocolConversion: null,
      v1v2Alignment: null,
      summary: null
    };
  }

  /**
   * 运行所有一致性测试
   */
  async runAllTests(options = {}) {
    console.log('🚀 启动综合一致性测试');
    console.log('========================');
    
    const { 
      generateSnapshots = false, 
      maxTestCases = 20,
      skipToolProcessing = false,
      skipProtocolConversion = false,
      skipV1V2Alignment = false
    } = options;

    try {
      // 1. 生成快照数据（如果需要）
      if (generateSnapshots) {
        console.log('\n📸 生成快照数据...');
        const { SnapshotDataGenerator } = await import(path.join(projectRoot, 'scripts/generate-snapshot-data.mjs'));
        const generator = new SnapshotDataGenerator();
        await generator.generateAllSnapshots();
      }

      // 2. 工具处理测试
      if (!skipToolProcessing) {
        console.log('\n🔧 运行工具处理测试...');
        this.testResults.toolProcessing = await this.runToolProcessingTest();
      }

      // 3. 协议转换测试
      if (!skipProtocolConversion) {
        console.log('\n🔄 运行协议转换测试...');
        this.testResults.protocolConversion = await this.runProtocolConversionTest();
      }

      // 4. V1/V2对齐测试
      if (!skipV1V2Alignment) {
        console.log('\n⚖️ 运行V1/V2对齐测试...');
        this.testResults.v1v2Alignment = await this.runV1V2AlignmentTest(maxTestCases);
      }

      // 5. 生成综合报告
      console.log('\n📊 生成综合报告...');
      JSON.parse(JSON.stringify(this.testResults.summary || {})) = await this.generateSummary();
      
      // 6. 保存报告
      await this.saveComprehensiveReport();
      
      // 7. 显示摘要
      this.displaySummary();
      
      return this.testResults;

    } catch (error) {
      console.error('❌ 综合测试失败:', error);
      process.exit(1);
    }
  }

  /**
   * 运行工具处理测试
   */
  async runToolProcessingTest() {
    try {
      const { V2ToolProcessingTest } = await import(path.join(projectRoot, 'tests/v2/src/tool-processing-test.js'));
      const test = new V2ToolProcessingTest();
      
      return new Promise((resolve, reject) => {
        const originalConsoleLog = console.log;
        const logs = [];
        
        console.log = (...args) => {
          logs.push(args.join(' '));
          originalConsoleLog(...args);
        };
        
        test.runTests().then(() => {
          console.log = originalConsoleLog;
          resolve({
            status: 'completed',
            logs,
            summary: this.extractToolProcessingSummary(logs)
          });
        }).catch(reject);
      });
    } catch (error) {
      return {
        status: 'failed',
        error: error.message
      };
    }
  }

  /**
   * 运行协议转换测试
   */
  async runProtocolConversionTest() {
    try {
      const { V2ProtocolConversionTest } = await import(path.join(projectRoot, 'tests/v2/src/protocol-conversion-test.js'));
      const test = new V2ProtocolConversionTest();
      
      return new Promise((resolve, reject) => {
        const originalConsoleLog = console.log;
        const logs = [];
        
        console.log = (...args) => {
          logs.push(args.join(' '));
          originalConsoleLog(...args);
        };
        
        test.runTests().then(() => {
          console.log = originalConsoleLog;
          resolve({
            status: 'completed',
            logs,
            summary: this.extractProtocolConversionSummary(logs)
          });
        }).catch(reject);
      });
    } catch (error) {
      return {
        status: 'failed',
        error: error.message
      };
    }
  }

  /**
   * 运行V1/V2对齐测试
   */
  async runV1V2AlignmentTest(maxTestCases) {
    try {
      const { V1V2ConsistencyTest } = await import(path.join(projectRoot, 'tests/v2/src/consistency/v1v2-consistency-test.js'));
      const test = new V1V2ConsistencyTest({
        maxTestCases,
        outputDir: path.join(projectRoot, 'test-results')
      });
      
      const report = await test.runAllTests();
      return {
        status: 'completed',
        report
      };
    } catch (error) {
      return {
        status: 'failed',
        error: error.message
      };
    }
  }

  /**
   * 提取工具处理测试摘要
   */
  extractToolProcessingSummary(logs) {
    const summary = {
      totalSamples: 0,
      successfulSamples: 0,
      totalHarvested: 0,
      totalCanonicalized: 0,
      totalGoverned: 0,
      avgProcessingTime: 0
    };

    for (const log of logs) {
      const match = log.match(/找到 (\d+) 个工具调用样本/);
      if (match) summary.totalSamples = parseInt(match[1]);
      
      const successMatch = log.match(/成功: (\d+)/);
      if (successMatch) summary.successfulSamples = parseInt(successMatch[1]);
      
      const harvestedMatch = log.match(/总收割工具: (\d+)/);
      if (harvestedMatch) summary.totalHarvested = parseInt(harvestedMatch[1]);
      
      const canonicalizedMatch = log.match(/总规范化工具: (\d+)/);
      if (canonicalizedMatch) summary.totalCanonicalized = parseInt(canonicalizedMatch[1]);
      
      const governedMatch = log.match(/总治理工具: (\d+)/);
      if (governedMatch) summary.totalGoverned = parseInt(governedMatch[1]);
      
      const avgTimeMatch = log.match(/平均处理时间: (\d+)ms/);
      if (avgTimeMatch) summary.avgProcessingTime = parseInt(avgTimeMatch[1]);
    }

    return summary;
  }

  /**
   * 提取协议转换测试摘要
   */
  extractProtocolConversionSummary(logs) {
    const summary = {
      totalSamples: 0,
      successfulConversions: 0,
      failedConversions: 0,
      avgConversionTime: 0,
      pathStats: {}
    };

    for (const log of logs) {
      const match = log.match(/找到 (\d+) 个协议转换样本/);
      if (match) summary.totalSamples = parseInt(match[1]);
      
      const successMatch = log.match(/成功转换: (\d+)/);
      if (successMatch) summary.successfulConversions = parseInt(successMatch[1]);
      
      const failedMatch = log.match(/失败转换: (\d+)/);
      if (failedMatch) summary.failedConversions = parseInt(failedMatch[1]);
      
      const avgTimeMatch = log.match(/平均转换时间: (\d+)ms/);
      if (avgTimeMatch) summary.avgConversionTime = parseInt(avgTimeMatch[1]);
      
      const pathMatch = log.match(/(openai->anthropic|anthropic->openai|openai->responses): (\d+)/);
      if (pathMatch) {
        summary.pathStats[pathMatch[1]] = parseInt(pathMatch[2]);
      }
    }

    return summary;
  }

  /**
   * 生成综合摘要
   */
  async generateSummary() {
    const summary = {
      timestamp: new Date().toISOString(),
      overallStatus: 'unknown',
      testResults: this.testResults,
      recommendations: [],
      criticalIssues: [],
      majorIssues: []
    };

    // 分析测试结果
    const allTests = [
      { name: '工具处理', result: this.testResults.toolProcessing },
      { name: '协议转换', result: this.testResults.protocolConversion },
      { name: 'V1/V2对齐', result: this.testResults.v1v2Alignment }
    ];

    const failedTests = allTests.filter(t => t.result?.status === 'failed');
    
    if (failedTests.length === 0) {
      summary.overallStatus = 'passed';
    } else if (failedTests.length <= 1) {
      summary.overallStatus = 'partial';
    } else {
      summary.overallStatus = 'failed';
    }

    // 生成建议
    if (this.testResults.v1v2Alignment?.report?.failures) {
      const failures = this.testResults.v1v2Alignment.report.failures;
      const critical = failures.filter(f => f.severity === 'critical');
      const major = failures.filter(f => f.severity === 'major');
      
      if (critical.length > 0) {
        summary.criticalIssues.push(`发现 ${critical.length} 个关键V1/V2一致性问题`);
      }
      
      if (major.length > 0) {
        summary.majorIssues.push(`发现 ${major.length} 个重要V1/V2一致性问题`);
      }
    }

    // 工具处理建议
    if (this.testResults.toolProcessing?.summary) {
      const { successfulSamples, totalSamples } = this.testResults.toolProcessing.summary;
      if (successfulSamples < totalSamples * 0.8) {
        summary.majorIssues.push('工具处理成功率低于80%，需要检查工具收割逻辑');
      }
    }

    // 协议转换建议
    if (this.testResults.protocolConversion?.summary) {
      const { successfulConversions, totalSamples } = this.testResults.protocolConversion.summary;
      if (successfulConversions < totalSamples * 0.8) {
        summary.majorIssues.push('协议转换成功率低于80%，需要检查转换逻辑');
      }
    }

    return summary;
  }

  /**
   * 保存综合报告
   */
  async saveComprehensiveReport() {
    const outputDir = path.join(projectRoot, 'test-results');
    await fs.mkdir(outputDir, { recursive: true });
    
    const reportPath = path.join(outputDir, `comprehensive-consistency-report-${Date.now()}.json`);
    await fs.writeFile(reportPath, JSON.stringify(JSON.parse(JSON.stringify(JSON.parse(JSON.stringify(this.testResults.summary || {})) || {})) ? JSON.parse(JSON.stringify(JSON.parse(JSON.stringify(this.testResults.summary || {})))) : {}, null, 2));
    
    console.log(`📄 综合报告已保存到: ${reportPath}`);
  }

  /**
   * 显示摘要
   */
  displaySummary() {
    const summary = JSON.parse(JSON.stringify(JSON.parse(JSON.stringify(this.testResults.summary || {})) || {}));
    
    console.log('\n📊 综合一致性测试摘要');
    console.log('========================');
    console.log(`🕐 测试时间: ${summary.timestamp}`);
    console.log(`🎯 总体状态: ${summary.overallStatus}`);
    
    console.log('\n📋 测试结果:');
    console.log(`  🔧 工具处理: ${this.testResults.toolProcessing?.status || 'skipped'}`);
    console.log(`  🔄 协议转换: ${this.testResults.protocolConversion?.status || 'skipped'}`);
    console.log(`  ⚖️ V1/V2对齐: ${this.testResults.v1v2Alignment?.status || 'skipped'}`);
    
    if (summary.criticalIssues.length > 0) {
      console.log('\n🔴 关键问题:');
      summary.criticalIssues.forEach(issue => console.log(`  • ${issue}`));
    }
    
    if (summary.majorIssues.length > 0) {
      console.log('\n🟡 重要问题:');
      summary.majorIssues.forEach(issue => console.log(`  • ${issue}`));
    }
  }
}

// 主函数
async function main() {
  const args = process.argv.slice(2);
  
  const options = {
    generateSnapshots: args.includes('--generate-snapshots'),
    maxTestCases: 20,
    skipToolProcessing: args.includes('--skip-tool-processing'),
    skipProtocolConversion: args.includes('--skip-protocol-conversion'),
    skipV1V2Alignment: args.includes('--skip-v1v2-alignment')
  };
  
  // 解析最大测试用例数
  const maxCasesArg = args.find(arg => arg.startsWith('--max-cases='));
  if (maxCasesArg) {
    options.maxTestCases = parseInt(maxCasesArg.split('=')[1]);
  }
  
  const test = new ComprehensiveConsistencyTest();
  await test.runAllTests(options);
}

// 显示使用帮助
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
用法: npm run test:comprehensive [选项]

选项:
  --generate-snapshots          先生成快照数据
  --max-cases=N               最大测试用例数 (默认: 20)
  --skip-tool-processing       跳过工具处理测试
  --skip-protocol-conversion   跳过协议转换测试
  --skip-v1v2-alignment       跳过V1/V2对齐测试
  --help, -h                  显示此帮助信息

示例:
  npm run test:comprehensive
  npm run test:comprehensive --generate-snapshots --max-cases=10
  npm run test:comprehensive --skip-tool-processing
`);
  process.exit(0);
}

main().catch(console.error);

export { ComprehensiveConsistencyTest };
