/**
 * 统一日志系统测试用例
 * 
 * 验证UnifiedLogger和LoggerFactory的核心功能
 */

import { LogLevel, UnifiedModuleLogger } from '../index.js';

describe('统一日志系统测试', () => {
  
  test('基础日志功能', () => {
    // 创建Logger实例
    const logger = new UnifiedModuleLogger({
      moduleId: 'test-module',
      moduleType: 'TestModule',
      logLevel: LogLevel.DEBUG,
      enableConsole: true,
      enableFile: false, // 测试中不写入文件
      maxHistory: 100
    });

    // 测试各级别日志
    logger.debug('这是一个调试消息', { userId: 123, action: 'login' });
    logger.info('这是一个信息消息', { status: 'success', duration: 150 });
    logger.warn('这是一个警告消息', { threshold: 80, current: 85 });
    logger.error('这是一个错误消息', new Error('测试错误'), { code: 'TEST_ERROR' });

    // 验证历史记录
    const history = logger.getHistory();
    expect(history.length).toBeGreaterThan(0);
    
    // 验证统计信息
    const stats = logger.getStats();
    expect(stats.totalLogs).toBeGreaterThan(0);
    expect(stats.levelCounts[LogLevel.DEBUG]).toBeGreaterThan(0);
    expect(stats.levelCounts[LogLevel.INFO]).toBeGreaterThan(0);
    expect(stats.levelCounts[LogLevel.WARN]).toBeGreaterThan(0);
    expect(stats.levelCounts[LogLevel.ERROR]).toBeGreaterThan(0);
  });

  test('上下文管理功能', () => {
    const logger = new UnifiedModuleLogger({
      moduleId: 'context-test',
      moduleType: 'ContextTestModule',
      logLevel: LogLevel.INFO,
      enableConsole: false,
      enableFile: false,
      maxHistory: 50
    });

    // 设置初始上下文
    logger.setContext({
      pipelineId: 'pipeline-123',
      requestId: 'req-456',
      sessionId: 'session-789'
    });

    // 记录日志，应该包含上下文信息
    logger.info('带上下文的消息');

    // 更新上下文
    logger.updateContext({
      userId: 'user-001',
      action: 'test-action'
    });

    // 再次记录日志
    logger.info('更新上下文后的消息');

    // 验证上下文
    const context = logger.getContext();
    expect(context.pipelineId).toBe('pipeline-123');
    expect(context.requestId).toBe('req-456');
    expect(context.userId).toBe('user-001');

    // 清除上下文
    logger.clearContext();
    const emptyContext = logger.getContext();
    expect(Object.keys(emptyContext).length).toBe(0);
  });

  test('日志级别过滤', () => {
    const logger = new UnifiedModuleLogger({
      moduleId: 'level-test',
      moduleType: 'LevelTestModule',
      logLevel: LogLevel.WARN, // 只记录WARN及以上级别
      enableConsole: false,
      enableFile: false,
      maxHistory: 100
    });

    // 记录不同级别的日志
    logger.debug('调试消息 - 应该被过滤');
    logger.info('信息消息 - 应该被过滤');
    logger.warn('警告消息 - 应该被记录');
    logger.error('错误消息 - 应该被记录');

    // const history = logger.getHistory();
    const stats = logger.getStats();

    // 验证只有WARN和ERROR级别的日志被记录
    expect(stats.levelCounts[LogLevel.WARN]).toBeGreaterThan(0);
    expect(stats.levelCounts[LogLevel.ERROR]).toBeGreaterThan(0);
    expect(stats.totalLogs).toBe(stats.levelCounts[LogLevel.WARN] + stats.levelCounts[LogLevel.ERROR]);
  });

  test('历史记录管理', () => {
    const logger = new UnifiedModuleLogger({
      moduleId: 'history-test',
      moduleType: 'HistoryTestModule',
      logLevel: LogLevel.INFO,
      enableConsole: false,
      enableFile: false,
      maxHistory: 5 // 限制历史记录数量
    });

    // 记录超过限制的日志
    for (let i = 0; i < 10; i++) {
      logger.info(`测试消息 ${i}`);
    }

    const history = logger.getHistory();
    expect(history.length).toBe(5); // 应该只保留最新的5条

    // 验证历史记录的内容
    expect(history[0].message).toBe('测试消息 5');
    expect(history[4].message).toBe('测试消息 9');
  });

  test('错误处理', () => {
    const logger = new UnifiedModuleLogger({
      moduleId: 'error-test',
      moduleType: 'ErrorTestModule',
      logLevel: LogLevel.ERROR,
      enableConsole: false,
      enableFile: false,
      maxHistory: 50
    });

    // 创建不同类型的错误
    const networkError = new Error('网络连接失败');
    networkError.name = 'NetworkError';
    
    const validationError = new Error('参数验证失败');
    validationError.name = 'ValidationError';

    // 记录错误日志
    logger.error('网络错误', networkError, { url: 'https://api.example.com' });
    logger.error('验证错误', validationError, { field: 'username', value: '' });

    const history = logger.getHistory();
    const errorEntries = history.filter(entry => entry.level === LogLevel.ERROR);

    expect(errorEntries.length).toBe(2);
    
    // 验证错误信息
    expect(errorEntries[0].error).toBeDefined();
    expect(errorEntries[0].error?.name).toBe('NetworkError');
    expect(errorEntries[0].error?.message).toBe('网络连接失败');
    expect(errorEntries[0].data?.url).toBe('https://api.example.com');
  });

  test('性能测试', () => {
    const logger = new UnifiedModuleLogger({
      moduleId: 'performance-test',
      moduleType: 'PerformanceTestModule',
      logLevel: LogLevel.INFO,
      enableConsole: false,
      enableFile: false,
      maxHistory: 1000
    });

    const startTime = Date.now();
    
    // 记录大量日志
    for (let i = 0; i < 100; i++) {
      logger.info(`性能测试消息 ${i}`, {
        index: i,
        timestamp: Date.now(),
        randomValue: Math.random()
      });
    }
    
    const endTime = Date.now();
    const duration = endTime - startTime;
    
    console.log(`记录100条日志耗时: ${duration}ms`);
    
    // 验证性能 - 应该在合理时间内完成
    expect(duration).toBeLessThan(1000); // 1秒内完成
    
    const history = logger.getHistory();
    expect(history.length).toBe(100);
  });

  test('内存管理', () => {
    const logger = new UnifiedModuleLogger({
      moduleId: 'memory-test',
      moduleType: 'MemoryTestModule',
      logLevel: LogLevel.INFO,
      enableConsole: false,
      enableFile: false,
      maxHistory: 10
    });

    // 记录大量日志来测试内存管理
    for (let i = 0; i < 1000; i++) {
      logger.info(`内存测试消息 ${i}`, {
        largeData: new Array(100).fill(`数据${i}`).join(','),
        nested: {
          level1: {
            level2: {
              level3: `深层数据${i}`
            }
          }
        }
      });
    }

    const history = logger.getHistory();
    expect(history.length).toBe(10); // 应该只保留最新的10条
    
    // 验证内存使用的统计信息
    const stats = logger.getStats();
    expect(stats.totalLogs).toBe(1000); // 总记录数应该正确
  });

  test('日志查询功能', async () => {
    const logger = new UnifiedModuleLogger({
      moduleId: 'query-test',
      moduleType: 'QueryTestModule',
      logLevel: LogLevel.DEBUG,
      enableConsole: false,
      enableFile: false,
      maxHistory: 100
    });

    // 记录不同类型的日志
    logger.info('用户信息消息', { userId: 'user1', action: 'login' });
    logger.warn('用户警告消息', { userId: 'user1', action: 'timeout' });
    logger.error('用户错误消息', new Error('登录失败'), { userId: 'user1' });
    
    logger.info('系统信息消息', { system: 'auth', status: 'online' });
    logger.debug('系统调试消息', { system: 'auth', debug: true });

    // 查询特定用户的日志
    const userLogs = await logger.queryLogs({
      keyword: '用户',
      levels: [LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR]
    });
    
    expect(userLogs.logs.length).toBeGreaterThan(0);
    expect(userLogs.total).toBeGreaterThan(0);

    // 查询错误日志
    const errorLogs = await logger.queryLogs({
      levels: [LogLevel.ERROR]
    });
    
    expect(errorLogs.logs.length).toBe(1);
    expect(errorLogs.logs[0].level).toBe(LogLevel.ERROR);
  });

  test('日志导出功能', async () => {
    const logger = new UnifiedModuleLogger({
      moduleId: 'export-test',
      moduleType: 'ExportTestModule',
      logLevel: LogLevel.INFO,
      enableConsole: false,
      enableFile: false,
      maxHistory: 20
    });

    // 记录一些日志
    for (let i = 0; i < 10; i++) {
      logger.info(`导出测试消息 ${i}`, { index: i, timestamp: Date.now() });
    }

    // 导出为JSON格式
    const jsonExport = await logger.exportLogs({
      format: 'json',
      includeHeader: true
    });

    expect(jsonExport).toBeTruthy();
    expect(jsonExport.length).toBeGreaterThan(0);

    // 验证导出的内容是有效的JSON
    const parsed = JSON.parse(jsonExport);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(10);
  });

  test('日志分析功能', async () => {
    const logger = new UnifiedModuleLogger({
      moduleId: 'analysis-test',
      moduleType: 'AnalysisTestModule',
      logLevel: LogLevel.INFO,
      enableConsole: false,
      enableFile: false,
      maxHistory: 50
    });

    // 记录不同时间段的日志
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    
    // 一小时前的日志
    logger.info('历史信息消息', { timestamp: oneHourAgo });
    logger.warn('历史警告消息', { timestamp: oneHourAgo });
    
    // 当前的日志
    logger.info('当前信息消息');
    logger.error('当前错误消息', new Error('测试错误'));

    // 分析日志
    const analysis = await logger.analyzeLogs({
      start: oneHourAgo - 1000,
      end: now + 1000
    });

    expect(analysis.overallStats).toBeDefined();
    expect(analysis.overallStats.totalLogs).toBeGreaterThan(0);
    expect(analysis.overallStats.levelCounts).toBeDefined();
    expect(analysis.errorAnalysis).toBeDefined();
    // performanceAnalysis 可能是undefined，因为需要duration数据
  });
});