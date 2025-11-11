#!/usr/bin/env node

/**
 * V1/V2一致性测试执行脚本
 * 整合快照加载、一致性验证和报告生成
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..', '..');

// 导入测试类
const { SnapshotLoader } = await import(path.join(projectRoot, 'tests/v2/src/utils/snapshot-loader.js'));
const { ConsistencyValidator } = await import(path.join(projectRoot, 'tests/v2/src/utils/consistency-validator.js'));
const { V1V2ConsistencyTest } = await import(path.join(projectRoot, 'tests/v2/src/consistency/v1v2-consistency-test.js'));

async function main() {
  const args = process.argv.slice(2);
  const protocol = args[0];
  const maxCases = args[1] ? parseInt(args[1]) : 20;
  const generateSnapshots = args.includes('--generate-snapshots');

  console.log('🚀 启动V1/V2一致性测试');
  console.log('========================');
  console.log(`📋 最大测试用例数: ${maxCases}`);
  
  if (protocol) {
    console.log(`🎯 测试协议: ${protocol}`);
  }

  // 生成快照数据（如果需要）
  if (generateSnapshots) {
    console.log('\n📸 生成快照数据...');
    const { SnapshotDataGenerator } = await import(path.join(projectRoot, 'scripts/generate-snapshot-data.mjs'));
    const generator = new SnapshotDataGenerator();
    await generator.generateAllSnapshots();
  }

  // 创建测试实例
  const test = new V1V2ConsistencyTest({
    maxTestCases: maxCases,
    outputDir: path.join(projectRoot, 'test-results')
  });

  try {
    let report;
    
    if (protocol && ['openai-chat', 'anthropic-messages', 'openai-responses'].includes(protocol)) {
      report = await test.runProtocolTests(protocol);
    } else {
      report = await test.runAllTests();
    }

    // 设置退出码
    const hasCriticalFailures = report.failures.some(f => f.severity === 'critical');
    const hasMajorFailures = report.failures.some(f => f.severity === 'major');
    
    if (hasCriticalFailures) {
      console.log('\n❌ 测试失败：发现关键错误');
      process.exit(1);
    } else if (hasMajorFailures) {
      console.log('\n⚠️ 测试警告：发现重要错误');
      process.exit(2);
    } else {
      console.log('\n✅ 测试通过：V1/V2一致性良好');
      process.exit(0);
    }

  } catch (error) {
    console.error('❌ 测试执行失败:', error);
    process.exit(3);
  }
}

// 显示使用帮助
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
用法: npm run test:consistency [协议] [最大用例数] [选项]

协议选项:
  openai-chat         仅测试OpenAI Chat协议
  anthropic-messages  仅测试Anthropic Messages协议
  openai-responses    仅测试OpenAI Responses协议
  (无参数)             测试所有协议

选项:
  --generate-snapshots  先生成快照数据再测试

示例:
  npm run test:consistency
  npm run test:consistency openai-chat 10
  npm run test:consistency anthropic-messages 5 --generate-snapshots

退出码:
  0  - 所有测试通过
  1  - 发现关键错误
  2  - 发现重要错误  
  3  - 测试执行失败
`);
  process.exit(0);
}

main().catch(console.error);
