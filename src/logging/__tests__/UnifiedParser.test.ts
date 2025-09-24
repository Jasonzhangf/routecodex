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

describe('统一解析机制测试', () => {
  
  test('JSONL解析器测试', async () => {
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
    
    expect(entries.length).toBe(3);
    expect(entries[0].level).toBe(LogLevel.INFO);
    expect(entries[0].message).toBe('测试信息消息');
    
    // 测试验证功能
    const isValid = parser.validate(entries[0]);
    expect(isValid).toBe(true);
  });

  test('时间序列索引测试', async () => {
    const { TimeSeriesIndexEngine } = await import('../indexer/TimeSeriesIndexer.js');
    
    const indexer = new TimeSeriesIndexEngine({
      name: 'test-index',
      shardInterval: 60 * 60 * 1000 // 1小时
    });
    
    // 构建索引
    await indexer.index(TEST_LOG_ENTRIES as any);
    
    // 等待索引优化完成
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // 获取索引状态
    const status = indexer.getIndexStatus();
    expect(status.name).toBe('test-index');
    expect(status.documentCount).toBe(3);
    expect(['active', 'optimizing']).toContain(status.status);
    
    // 查询测试
    const queryResult = await indexer.query({
      levels: [LogLevel.INFO, LogLevel.WARN],
      limit: 10
    });
    
    expect(queryResult.logs.length).toBeGreaterThan(0);
    expect(queryResult.queryTime).toBeGreaterThanOrEqual(0);
    
    // 获取元数据
    const metadata = indexer.getMetadata();
    expect(metadata.timeRange.start).toBeDefined();
    expect(metadata.timeRange.end).toBeDefined();
  });

  test('数据验证器测试', async () => {
    const { DataValidatorAndCleaner } = await import('../validator/DataValidator.js');
    
    const validator = new DataValidatorAndCleaner({
      validationLevel: 'moderate',
      autoFix: true
    });
    
    // 测试有效条目
    const validEntry = TEST_LOG_ENTRIES[0];
    const validResult = validator.validateEntry(validEntry);
    expect(validResult.isValid).toBe(true);
    expect(validResult.errors.length).toBe(0);
    
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
    expect(invalidResult.isValid).toBe(false);
    expect(invalidResult.errors.length).toBeGreaterThan(0);
    
    // 测试清洗功能 - 使用需要修复的数据
    const dirtyEntries = [
      {
        timestamp: Date.now(),
        level: 'INFO', // 大写，需要标准化
        moduleId: 'Test-Module_123', // 混合大小写和特殊字符，需要标准化
        moduleType: 'TestModule',
        message: '  需要修剪的消息  ', // 前后空格，需要修剪
        data: { empty: '', null: null, valid: 'data' }, // 空值需要移除
        tags: ['Test', 'CLEANING'], // 大写标签
        version: '0.0.1'
      }
    ];
    
    const cleanResult = validator.cleanEntries(dirtyEntries as any);
    expect(cleanResult.cleanedEntries.length).toBe(1);
    expect(cleanResult.stats.normalizedOperations).toBeGreaterThan(0); // 检查标准化操作数量
    
    // 验证清洗效果
    const cleanedEntry = cleanResult.cleanedEntries[0];
    expect(cleanedEntry.level).toBe('info'); // 应该被标准化为小写
    expect(cleanedEntry.message).toBe('需要修剪的消息'); // 应该去除前后空格
    expect(cleanedEntry.moduleId).toBe('test-module_123'); // 应该标准化为小写
  });

  test('解析性能测试', async () => {
    const { JsonlLogParser } = await import('../parser/JsonlParser.js');
    
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
    
    const parser = new JsonlLogParser({
      batchSize: 500,
      errorHandling: 'skip'
    });
    
    const startTime = Date.now();
    const entries = await parser.parseContent(testContent);
    const endTime = Date.now();
    
    const duration = endTime - startTime;
    const entriesPerSecond = (entries.length / duration) * 1000;
    
    expect(entries.length).toBe(1000);
    expect(duration).toBeLessThan(5000); // 5秒内完成
    expect(entriesPerSecond).toBeGreaterThan(500); // 每秒至少500条
  });
});