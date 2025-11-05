#!/usr/bin/env node

/**
 * V2 干运行监控分析脚本
 *
 * 使用方法:
 * node scripts/v2-monitoring-analysis.mjs
 *
 * 功能:
 * - 分析V2模拟运行状态
 * - 检查日志文件中的对比结果
 * - 生成性能和准确性报告
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// 配置
const LOG_DIRS = [
  path.join(projectRoot, 'logs'),
  path.join(projectRoot, 'debug-logs'),
  path.join(projectRoot, '.v2-logs')
];

const MONITOR_FILES = [
  'v2-parallel-runner.log',
  'v2-dryrun-adapter.log',
  'debug.log'
];

/**
 * 分析日志文件
 */
function analyzeLogFiles() {
  console.log('🔍 分析V2日志文件...\n');

  const analysis = {
    totalLogs: 0,
    successMismatches: [],
    lowSimilarities: [],
    healthStatusChanges: [],
    metricsReports: [],
    errors: []
  };

  for (const logDir of LOG_DIRS) {
    if (!fs.existsSync(logDir)) continue;

    console.log(`📁 检查目录: ${logDir}`);

    const files = fs.readdirSync(logDir);
    for (const file of files) {
      if (!file.includes('v2') && !MONITOR_FILES.some(mf => file.includes(mf))) continue;

      const filePath = path.join(logDir, file);
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        analyzeLogFile(content, file, analysis);
        console.log(`  ✓ 已分析: ${file}`);
      } catch (error) {
        console.log(`  ❌ 读取失败: ${file} - ${error.message}`);
      }
    }
  }

  return analysis;
}

/**
 * 分析单个日志文件
 */
function analyzeLogFile(content, filename, analysis) {
  const lines = content.split('\n');
  let lineNumber = 0;

  for (const line of lines) {
    lineNumber++;

    try {
      // 尝试解析JSON格式的日志
      const jsonMatch = line.match(/\{.*\}$/);
      if (jsonMatch) {
        const logData = JSON.parse(jsonMatch[0]);
        analyzeLogEntry(logData, filename, analysis);
      }
    } catch (error) {
      // 跳过无法解析的行
      continue;
    }
  }

  analysis.totalLogs += lines.length;
}

/**
 * 分析单条日志记录
 */
function analyzeLogEntry(logData, filename, analysis) {
  // 成功率不匹配
  if (logData.event === 'success-mismatch') {
    analysis.successMismatches.push({
      timestamp: logData.timestamp || new Date().toISOString(),
      requestId: logData.requestId,
      v1Success: logData.v1Success,
      v2Success: logData.v2Success,
      errors: logData.errors,
      file: filename
    });
  }

  // 低相似度
  if (logData.event === 'low-similarity') {
    analysis.lowSimilarities.push({
      timestamp: logData.timestamp || new Date().toISOString(),
      requestId: logData.requestId,
      similarity: logData.similarity,
      differences: logData.differences,
      file: filename
    });
  }

  // 健康状态变化
  if (logData.event === 'health-status-changed') {
    analysis.healthStatusChanges.push({
      timestamp: logData.timestamp || new Date().toISOString(),
      from: logData.from,
      to: logData.to,
      failureRate: logData.failureRate,
      sampledRequests: logData.sampledRequests,
      file: filename
    });
  }

  // 指标报告
  if (logData.event === 'metrics-report') {
    analysis.metricsReports.push({
      timestamp: logData.timestamp || new Date().toISOString(),
      totalRequests: logData.totalRequests,
      sampledRequests: logData.sampledRequests,
      v1SuccessRate: logData.v1SuccessRate,
      v2SuccessRate: logData.v2SuccessRate,
      averageComparison: logData.averageComparison,
      healthStatus: logData.healthStatus,
      performance: logData.performance,
      file: filename
    });
  }

  // 错误记录
  if (logData.level === 'error' || logData.event?.includes('error')) {
    analysis.errors.push({
      timestamp: logData.timestamp || new Date().toISOString(),
      module: logData.module,
      event: logData.event,
      error: logData.error,
      file: filename
    });
  }
}

/**
 * 生成分析报告
 */
function generateReport(analysis) {
  console.log('\n📊 V2干运行分析报告');
  console.log('='.repeat(50));

  // 基础统计
  console.log(`\n📈 基础统计:`);
  console.log(`  总日志行数: ${analysis.totalLogs.toLocaleString()}`);
  console.log(`  成功率不匹配: ${analysis.successMismatches.length} 次`);
  console.log(`  低相似度警告: ${analysis.lowSimilarities.length} 次`);
  console.log(`  健康状态变化: ${analysis.healthStatusChanges.length} 次`);
  console.log(`  指标报告: ${analysis.metricsReports.length} 份`);
  console.log(`  错误记录: ${analysis.errors.length} 条`);

  // 成功率分析
  if (analysis.successMismatches.length > 0) {
    console.log(`\n⚠️  成功率不匹配分析:`);
    const v1Fails = analysis.successMismatches.filter(m => !m.v1Success).length;
    const v2Fails = analysis.successMismatches.filter(m => !m.v2Success).length;

    console.log(`  V1失败但V2成功: ${v2Fails} 次`);
    console.log(`  V2失败但V1成功: ${v1Fails} 次`);

    // 显示最近的几次不匹配
    const recent = analysis.successMismatches.slice(-3);
    recent.forEach(m => {
      console.log(`    ${m.timestamp} - ${m.requestId}: V1=${m.v1Success}, V2=${m.v2Success}`);
      if (m.errors.v2Error) {
        console.log(`      V2错误: ${m.errors.v2Error}`);
      }
    });
  }

  // 相似度分析
  if (analysis.lowSimilarities.length > 0) {
    console.log(`\n📉 低相似度分析:`);

    const similarities = analysis.lowSimilarities.map(s => s.similarity);
    const avgSimilarity = similarities.reduce((a, b) => a + b, 0) / similarities.length;
    const minSimilarity = Math.min(...similarities);

    console.log(`  平均相似度: ${(avgSimilarity * 100).toFixed(1)}%`);
    console.log(`  最低相似度: ${(minSimilarity * 100).toFixed(1)}%`);

    // 显示最严重的几次低相似度
    const worst = analysis.lowSimilarities
      .sort((a, b) => a.similarity - b.similarity)
      .slice(0, 3);

    worst.forEach(w => {
      console.log(`    ${w.timestamp} - ${w.requestId}: ${(w.similarity * 100).toFixed(1)}%`);
      if (w.differences && w.differences.length > 0) {
        console.log(`      差异: ${w.differences.join(', ')}`);
      }
    });
  }

  // 性能分析
  if (analysis.metricsReports.length > 0) {
    console.log(`\n⚡ 性能分析:`);

    const latest = analysis.metricsReports[analysis.metricsReports.length - 1];
    const earliest = analysis.metricsReports[0];

    console.log(`  最新指标 (${latest.timestamp}):`);
    console.log(`    V1成功率: ${(latest.v1SuccessRate * 100).toFixed(1)}%`);
    console.log(`    V2成功率: ${(latest.v2SuccessRate * 100).toFixed(1)}%`);
    console.log(`    平均相似度: ${(latest.averageComparison * 100).toFixed(1)}%`);
    console.log(`    健康状态: ${latest.healthStatus}`);

    if (latest.performance) {
      console.log(`    V1平均延迟: ${latest.performance.averageV1Latency}ms`);
      console.log(`    V2平均延迟: ${latest.performance.averageV2Latency}ms`);

      const latencyImprovement = latest.performance.latencyImprovement;
      if (latencyImprovement !== undefined) {
        if (latencyImprovement > 0) {
          console.log(`    V2性能提升: ${(latencyImprovement * 100).toFixed(1)}%`);
        } else {
          console.log(`    V2性能下降: ${Math.abs(latencyImprovement * 100).toFixed(1)}%`);
        }
      }
    }

    // 趋势分析
    if (analysis.metricsReports.length >= 2) {
      console.log(`\n📈 趋势分析 (从 ${earliest.timestamp} 到 ${latest.timestamp}):`);

      const successRateChange = latest.v2SuccessRate - earliest.v2SuccessRate;
      const similarityChange = latest.averageComparison - earliest.averageComparison;

      console.log(`    V2成功率变化: ${successRateChange >= 0 ? '+' : ''}${(successRateChange * 100).toFixed(1)}%`);
      console.log(`    相似度变化: ${similarityChange >= 0 ? '+' : ''}${(similarityChange * 100).toFixed(1)}%`);
    }
  }

  // 健康状态分析
  if (analysis.healthStatusChanges.length > 0) {
    console.log(`\n💊 健康状态变化:`);

    analysis.healthStatusChanges.forEach(change => {
      const statusEmoji = {
        'healthy': '🟢',
        'degraded': '🟡',
        'disabled': '🔴'
      }[change.to] || '❓';

      console.log(`  ${change.timestamp} ${statusEmoji} ${change.from} → ${change.to}`);
      console.log(`    失败率: ${(change.failureRate * 100).toFixed(1)}%, 采样: ${change.sampledRequests}`);
    });
  }

  // 错误分析
  if (analysis.errors.length > 0) {
    console.log(`\n❌ 错误分析:`);

    const errorsByModule = {};
    analysis.errors.forEach(error => {
      if (!errorsByModule[error.module]) {
        errorsByModule[error.module] = [];
      }
      errorsByModule[error.module].push(error);
    });

    Object.entries(errorsByModule).forEach(([module, errors]) => {
      console.log(`  ${module}: ${errors.length} 个错误`);
      const recent = errors.slice(-2);
      recent.forEach(e => {
        console.log(`    ${e.timestamp}: ${e.error || e.event}`);
      });
    });
  }

  // 建议
  console.log(`\n💡 建议:`);

  if (analysis.successMismatches.length > 0) {
    const v2FailRate = analysis.successMismatches.filter(m => !m.v2Success).length / analysis.successMismatches.length;
    if (v2FailRate > 0.1) {
      console.log(`  ⚠️  V2失败率较高 (${(v2FailRate * 100).toFixed(1)}%)，建议检查V2配置`);
    }
  }

  if (analysis.lowSimilarities.length > 0) {
    const avgSimilarity = analysis.lowSimilarities.reduce((a, b) => a + b.similarity, 0) / analysis.lowSimilarities.length;
    if (avgSimilarity < 0.7) {
      console.log(`  ⚠️  平均相似度较低 (${(avgSimilarity * 100).toFixed(1)}%)，V2可能存在兼容性问题`);
    }
  }

  if (analysis.metricsReports.length > 0) {
    const latest = analysis.metricsReports[analysis.metricsReports.length - 1];
    if (latest.healthStatus !== 'healthy') {
      console.log(`  ⚠️  当前健康状态为 ${latest.healthStatus}，建议检查系统状态`);
    }

    if (latest.performance?.latencyImprovement < -0.2) {
      console.log(`  ⚠️  V2性能明显低于V1，建议优化V2实现`);
    }
  }

  if (analysis.errors.length > 5) {
    console.log(`  ⚠️  错误数量较多 (${analysis.errors.length})，建议检查日志详情`);
  }

  console.log(`\n✅ 分析完成!`);
}

/**
 * 检查V2干运行是否正在运行
 */
function checkV2Process() {
  console.log('🔍 检查V2进程状态...\n');

  try {
    // 检查是否有Node.js进程包含V2相关代码
    const result = execSync('ps aux | grep -i "v2\\|dryrun\\|parallel" | grep -v grep', { encoding: 'utf8' });

    if (result.trim()) {
      console.log('✅ 发现V2相关进程正在运行:');
      console.log(result);
    } else {
      console.log('⚠️  未发现V2相关进程，可能未启动或已停止');
    }
  } catch (error) {
    console.log('❌ 无法检查进程状态:', error.message);
  }
}

/**
 * 主函数
 */
function main() {
  console.log('🚀 V2干运行监控分析工具');
  console.log('='.repeat(50));

  // 检查进程状态
  checkV2Process();

  // 分析日志文件
  const analysis = analyzeLogFiles();

  if (analysis.totalLogs === 0) {
    console.log('\n❌ 未找到V2相关日志文件');
    console.log('请确保:');
    console.log('  1. V2干运行已启动');
    console.log('  2. 日志输出配置正确');
    console.log('  3. 检查日志目录权限');
    return;
  }

  // 生成报告
  generateReport(analysis);
}

// 运行分析
main().catch(error => {
  console.error('分析过程中出现错误:', error);
  process.exit(1);
});