/**
 * 一致性测试执行脚本
 */

import { V1V2ConsistencyTest } from './v1v2-consistency-test.js';
import * as path from 'path';

async function main() {
  const args = process.argv.slice(2);
  const protocol = args[0] as any;
  const maxCases = args[1] ? parseInt(args[1]) : 20;

  console.log('🚀 启动V1/V2一致性测试');
  console.log('========================');
  console.log(`📋 最大测试用例数: ${maxCases}`);
  
  if (protocol) {
    console.log(`🎯 测试协议: ${protocol}`);
  }

  const test = new V1V2ConsistencyTest({
    maxTestCases: maxCases,
    outputDir: path.join(process.cwd(), 'test-results')
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
用法: npm run test:consistency [协议] [最大用例数]

协议选项:
  openai-chat         仅测试OpenAI Chat协议
  anthropic-messages  仅测试Anthropic Messages协议
  openai-responses    仅测试OpenAI Responses协议
  (无参数)             测试所有协议

示例:
  npm run test:consistency
  npm run test:consistency openai-chat 10
  npm run test:consistency anthropic-messages 5

退出码:
  0  - 所有测试通过
  1  - 发现关键错误
  2  - 发现重要错误  
  3  - 测试执行失败
`);
  process.exit(0);
}

main().catch(console.error);
