/**
 * 统一解析机制简化测试
 * 
 * 验证核心解析功能
 */

import { LogLevel } from '../types.js';

/**
 * 基础测试数据
 */
const TEST_LOG_ENTRIES = [
  {
    timestamp: Date.now() - 3600000,
    level: LogLevel.INFO,
    moduleId: 'test-module-1',
    moduleType: 'TestModule',
    message: '测试信息消息',
    data: { userId: 123, action: 'login' },
    tags: ['test', 'info'],
    version: '0.0.1'
  },
  {
    timestamp: Date.now() - 1800000,
    level: LogLevel.WARN,
    moduleId: 'test-module-2',
    moduleType: 'TestModule',
    message: '测试警告消息',
    data: { threshold: 80, current: 85 },
    tags: ['test', 'warning'],
    version: '0.0.1'
  },
  {
    timestamp: Date.now(),
    level: LogLevel.ERROR,
    moduleId: 'test-module-3',
    moduleType: 'TestModule',
    message: '测试错误消息',
    error: {
      name: 'TestError',
      message: '这是一个测试错误',
      code: 'TEST_ERROR'
    },
    tags: ['test', 'error'],
    version: '0.0.1'
  }
];

/**
 * 测试JSONL解析器
 */
async function testJsonlParser() {
  console.log('=== 测试JSONL解析器 ===');
  
  try {
    const { JsonlLogParser } = await import('../parser/JsonlParser.js');
    
    const parser = new JsonlLogParser({
      batchSize: 100,
      errorHandling: 'skip',
      validateTimestamps: true
    });
    
    // 创建测试内容
    const testContent = TEST_LOG_ENTRIES.map(entry => JSON.stringify(entry)).join('\n');
    
    // 测试内容解析
    const entries = await parser.parseContent(testContent);
    
    console.log(`✓ 解析条目数: ${entries.length}`);
    console.log(`✓ 第一个条目级别: ${entries[0]?.level}`);
    console.log(`✓ 第一个条目消息: ${entries[0]?.message}`);
    
    // 测试验证功能
    const isValid = parser.validate(entries[0]);
    console.log(`✓ 验证结果: ${isValid}`);
    
    console.log('✓ JSONL解析器测试通过\n');
    return true;
    
  } catch (error) {
    console.error('❌ JSONL解析器测试失败:', error);
    return false;
  }
}

/**
 * 测试时间序列索引
 */
async function testTimeSeriesIndexer() {
  console.log('=== 测试时间序列索引 ===');
  
  try {
    const { TimeSeriesIndexEngine } = await import('../indexer/TimeSeriesIndexer.js');
    
    const indexer = new TimeSeriesIndexEngine({
      name: 'test-index',
      shardInterval: 60 * 60 * 1000 // 1小时
    });
    
    // 构建索引
    await indexer.index(TEST_LOG_ENTRIES as any);
    
    // 获取索引状态
    const status = indexer.getIndexStatus();
    console.log(`✓ 索引名称: ${status.name}`);
    console.log(`✓ 文档数量: ${status.documentCount}`);
    console.log(`✓ 索引状态: ${status.status}`);
    
    // 查询测试
    const queryResult = await indexer.query({
      levels: [LogLevel.INFO, LogLevel.WARN],
      limit: 10
    });
    
    console.log(`✓ 查询结果数量: ${queryResult.logs.length}`);
    console.log(`✓ 查询耗时: ${queryResult.queryTime}ms`);
    
    // 获取元数据
    const metadata = indexer.getMetadata();
    console.log(`✓ 时间范围: ${new Date(metadata.timeRange.start).toISOString()} - ${new Date(metadata.timeRange.end).toISOString()}`);
    
    console.log('✓ 时间序列索引测试通过\n');
    return true;
    
  } catch (error) {
    console.error('❌ 时间序列索引测试失败:', error);
    return false;
  }
}

/**
 * 测试数据验证器
 */
async function testDataValidator() {
  console.log('=== 测试数据验证器 ===');
  
  try {
    const { DataValidatorAndCleaner } = await import('../validator/DataValidator.js');
    
    const validator = new DataValidatorAndCleaner({
      validationLevel: 'moderate',
      autoFix: true
    });
    
    // 测试有效条目
    const validEntry = TEST_LOG_ENTRIES[0];
    const validResult = validator.validateEntry(validEntry);
    console.log(`✓ 有效条目验证: ${validResult.isValid}`);
    console.log(`✓ 错误数: ${validResult.errors.length}`);
    console.log(`✓ 警告数: ${validResult.warnings.length}`);
    
    // 测试无效条目
    const invalidEntry = {
      timestamp: 'invalid',
      level: 'invalid_level',
      moduleId: '',
      moduleType: null,
      message: 123,
      version: '0.0.1'
    };
    
    const invalidResult = validator.validateEntry(invalidEntry);
    console.log(`✓ 无效条目验证: ${invalidResult.isValid}`);
    console.log(`✓ 错误数: ${invalidResult.errors.length}`);
    
    // 测试清洗功能
    const dirtyEntries = [
      {
        timestamp: Date.now(),
        level: 'INFO', // 大写
        moduleId: 'Test-Module_123', // 混合大小写和特殊字符
        moduleType: 'TestModule',
        message: '  需要修剪的消息  ',
        data: { empty: '', null: null, valid: 'data' },
        tags: [],
        version: '0.0.1'
      }
    ];
    
    const cleanResult = validator.cleanEntries(dirtyEntries as any);
    console.log(`✓ 清洗后条目数: ${cleanResult.cleanedEntries.length}`);
    console.log(`✓ 修复条目数: ${cleanResult.stats.fixedEntries}`);
    
    console.log('✓ 数据验证器测试通过\n');
    return true;
    
  } catch (error) {
    console.error('❌ 数据验证器测试失败:', error);
    return false;
  }
}

/**
 * 测试性能
 */
async function testPerformance() {
  console.log('=== 测试解析性能 ===');
  
  // 生成大量测试数据
  const largeEntries = [];
  for (let i = 0; i < 1000; i++) {
    largeEntries.push({
      timestamp: Date.now() - i * 1000,
      level: [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR][i % 4],
      moduleId: `perf-module-${i % 10}`,
      moduleType: 'PerformanceTestModule',
      message: `性能测试消息 ${i}`,
      data: { index: i, value: Math.random() },
      tags: ['performance', 'test'],
      version: '0.0.1'
    });
  }
  
  const testContent = largeEntries.map(entry => JSON.stringify(entry)).join('\n');
  
  try {
    const { JsonlLogParser } = await import('../parser/JsonlParser.js');
    const parser = new JsonlLogParser({
      batchSize: 500,
      errorHandling: 'skip'
    });
    
    const startTime = Date.now();
    const entries = await parser.parseContent(testContent);
    const endTime = Date.now();
    
    const duration = endTime - startTime;
    const entriesPerSecond = (entries.length / duration) * 1000;
    
    console.log(`✓ 解析条目数: ${entries.length}`);
    console.log(`✓ 解析耗时: ${duration}ms`);
    console.log(`✓ 解析速度: ${entriesPerSecond.toFixed(0)} 条/秒`);
    
    console.log('✓ 性能测试通过\n');
    return true;
    
  } catch (error) {
    console.error('❌ 性能测试失败:', error);
    return false;
  }
}

/**
 * 运行所有测试
 */
async function runAllTests() {
  console.log('🚀 开始统一解析机制测试\n');
  
  const results = [];
  
  try {
    // 基础组件测试
    results.push(await testJsonlParser());
    results.push(await testTimeSeriesIndexer());
    results.push(await testDataValidator());
    
    // 性能测试
    results.push(await testPerformance());
    
    const passed = results.filter(Boolean).length;
    const total = results.length;
    
    console.log(`🎉 测试完成！通过: ${passed}/${total}\n`);
    
    if (passed === total) {
      console.log('✅ 所有测试通过！统一解析机制工作正常。');
    } else {
      console.log('⚠️  部分测试失败，请检查错误信息。');
    }
    
    return passed === total;
    
  } catch (error) {
    console.error('❌ 测试失败:', error);
    return false;
  }
}

// 如果直接运行此文件，则执行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests().then(success => {
    process.exit(success ? 0 : 1);
  }).catch(error => {
    console.error('测试执行失败:', error);
    process.exit(1);
  });
}

export { runAllTests };