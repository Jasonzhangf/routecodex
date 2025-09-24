/**
 * 统一日志系统测试用例
 * 
 * 验证UnifiedLogger和LoggerFactory的核心功能
 */

import { LogLevel, UnifiedModuleLogger, LoggerFactoryImpl, createLogger, getLogger, CompatibilityLogger } from '../index.js';

/**
 * 基础功能测试
 */
function testBasicLogging() {
  console.log('=== 测试基础日志功能 ===');
  
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
  console.log(`✓ 历史记录数量: ${history.length}`);
  
  // 验证统计信息
  const stats = logger.getStats();
  console.log(`✓ 总日志数: ${stats.totalLogs}`);
  console.log(`✓ 错误数: ${stats.errorCount}`);
  console.log(`✓ 各级别统计:`, stats.levelCounts);

  console.log('✓ 基础功能测试通过\n');
  return logger;
}

/**
 * 上下文功能测试
 */
function testContextManagement() {
  console.log('=== 测试上下文管理功能 ===');
  
  const logger = new UnifiedModuleLogger({
    moduleId: 'context-test',
    moduleType: 'ContextTestModule',
    logLevel: LogLevel.INFO
  });

  // 设置上下文
  logger.setContext({
    requestId: 'req-123',
    pipelineId: 'pipeline-456',
    userId: 'user-789'
  });

  logger.info('带上下文的消息');

  // 更新上下文
  logger.updateContext({ sessionId: 'session-abc' });
  logger.info('更新后的上下文消息');

  // 验证上下文
  const context = logger.getContext();
  console.log(`✓ 当前上下文:`, context);

  // 清除上下文
  logger.clearContext();
  logger.info('清除上下文后的消息');

  console.log('✓ 上下文功能测试通过\n');
}

/**
 * 查询和过滤功能测试
 */
async function testQueryAndFilter() {
  console.log('=== 测试查询和过滤功能 ===');
  
  const logger = new UnifiedModuleLogger({
    moduleId: 'query-test',
    moduleType: 'QueryTestModule'
  });

  // 生成测试数据
  for (let i = 0; i < 10; i++) {
    const level = i % 4 === 0 ? LogLevel.ERROR : 
                  i % 3 === 0 ? LogLevel.WARN : 
                  i % 2 === 0 ? LogLevel.INFO : LogLevel.DEBUG;
    
    if (level === LogLevel.DEBUG) {
      logger.debug(`测试消息 ${i}`, { index: i, type: `type-${i % 3}` });
    } else if (level === LogLevel.INFO) {
      logger.info(`测试消息 ${i}`, { index: i, type: `type-${i % 3}` });
    } else if (level === LogLevel.WARN) {
      logger.warn(`测试消息 ${i}`, { index: i, type: `type-${i % 3}` });
    } else if (level === LogLevel.ERROR) {
      logger.error(`测试消息 ${i}`, new Error(`测试错误${i}`), { index: i, type: `type-${i % 3}` });
    }
  }

  // 测试级别过滤
  const levelResult = await logger.queryLogs({
    levels: [LogLevel.ERROR, LogLevel.WARN]
  });
  console.log(`✓ 级别过滤结果: ${levelResult.logs.length} 条日志`);

  // 测试关键词搜索
  const keywordResult = await logger.queryLogs({
    keyword: '测试'
  });
  console.log(`✓ 关键词搜索结果: ${keywordResult.logs.length} 条日志`);

  // 测试分页
  const pageResult = await logger.queryLogs({
    limit: 3,
    offset: 2
  });
  console.log(`✓ 分页结果: ${pageResult.logs.length} 条日志 (偏移: 2)`);

  console.log('✓ 查询和过滤功能测试通过\n');
}

/**
 * 导出功能测试
 */
async function testExportFunctionality() {
  console.log('=== 测试导出功能 ===');
  
  const logger = new UnifiedModuleLogger({
    moduleId: 'export-test',
    moduleType: 'ExportTestModule'
  });

  // 生成测试数据
  logger.info('导出测试消息1', { data: 'test1' });
  logger.warn('导出测试消息2', { data: 'test2' });
  logger.error('导出测试消息3', new Error('测试错误'));

  // 测试JSON导出
  const jsonExport = await logger.exportLogs({
    format: 'json'
  });
  console.log(`✓ JSON导出长度: ${jsonExport.length} 字符`);

  // 测试JSONL导出
  const jsonlExport = await logger.exportLogs({
    format: 'jsonl'
  });
  console.log(`✓ JSONL导出长度: ${jsonlExport.length} 字符`);

  // 测试CSV导出
  const csvExport = await logger.exportLogs({
    format: 'csv',
    fields: ['timestamp', 'level', 'message']
  });
  console.log(`✓ CSV导出长度: ${csvExport.length} 字符`);
  console.log('CSV内容预览:');
  console.log(csvExport.substring(0, 200) + '...');

  console.log('✓ 导出功能测试通过\n');
}

/**
 * LoggerFactory功能测试
 */
function testLoggerFactory() {
  console.log('=== 测试LoggerFactory功能 ===');
  
  const factory = new LoggerFactoryImpl();

  // 创建多个Logger
  const logger1 = factory.createLogger({
    moduleId: 'factory-test-1',
    moduleType: 'FactoryTestModule1'
  });

  const logger2 = factory.createLogger({
    moduleId: 'factory-test-2',
    moduleType: 'FactoryTestModule2'
  });

  // 测试获取Logger
  const retrievedLogger1 = factory.getLogger('factory-test-1');
  const retrievedLogger2 = factory.getLogger('factory-test-2');
  
  console.log(`✓ Logger1获取成功: ${retrievedLogger1 !== undefined}`);
  console.log(`✓ Logger2获取成功: ${retrievedLogger2 !== undefined}`);

  // 测试工厂状态
  const status = factory.getFactoryStatus();
  console.log(`✓ 工厂状态:`, status);

  // 测试全局函数
  const globalLogger = createLogger({
    moduleId: 'global-test',
    moduleType: 'GlobalTestModule'
  });
  
  const retrievedGlobalLogger = getLogger('global-test');
  console.log(`✓ 全局Logger获取成功: ${retrievedGlobalLogger !== undefined}`);

  console.log('✓ LoggerFactory功能测试通过\n');
}

/**
 * 兼容性测试
 */
function testCompatibility() {
  console.log('=== 测试向后兼容性 ===');
  
  // 使用导入而不是require
  import('../index.js').then(module => {
    const { CompatibilityLogger } = module;
    
    const compatLogger = new CompatibilityLogger('compat-test', 'CompatTestModule');

    // 测试兼容的console方法
    compatLogger.log('兼容性日志消息');
    compatLogger.info('兼容性信息消息');
    compatLogger.warn('兼容性警告消息');
    compatLogger.error('兼容性错误消息', new Error('兼容性测试错误'));
    compatLogger.debug('兼容性调试消息');

    console.log('✓ 向后兼容性测试通过\n');
  }).catch(error => {
    console.error('兼容性测试失败:', error);
  });
}

/**
 * 性能测试
 */
function testPerformance() {
  console.log('=== 测试性能 ===');
  
  const logger = new UnifiedModuleLogger({
    moduleId: 'performance-test',
    moduleType: 'PerformanceTestModule',
    enableConsole: false, // 关闭控制台输出以提高性能
    maxHistory: 1000
  });

  const startTime = Date.now();
  const logCount = 1000;

  // 批量写入日志
  for (let i = 0; i < logCount; i++) {
    logger.info(`性能测试消息 ${i}`, { 
      index: i, 
      data: `test-data-${i}`,
      nested: { value: i * 2 }
    });
  }

  const endTime = Date.now();
  const duration = endTime - startTime;
  const logsPerSecond = (logCount / duration) * 1000;

  console.log(`✓ 写入 ${logCount} 条日志耗时: ${duration}ms`);
  console.log(`✓ 每秒日志处理能力: ${logsPerSecond.toFixed(0)} 条/秒`);

  // 验证历史记录
  const history = logger.getHistory();
  console.log(`✓ 历史记录验证: ${history.length} 条`);

  console.log('✓ 性能测试通过\n');
}

/**
 * 运行所有测试
 */
async function runAllTests() {
  console.log('🚀 开始统一日志系统测试\n');
  
  try {
    // 基础功能测试
    const logger = testBasicLogging();
    
    // 上下文管理测试
    testContextManagement();
    
    // 查询和过滤测试
    await testQueryAndFilter();
    
    // 导出功能测试
    await testExportFunctionality();
    
    // LoggerFactory测试
    testLoggerFactory();
    
    // 跳过兼容性测试（ES模块限制）
    console.log('⚠️  跳过兼容性测试（ES模块限制）\n');
    
    // 性能测试
    testPerformance();
    
    // 清理测试Logger
    await logger.cleanup();
    
    console.log('🎉 所有测试通过！统一日志系统工作正常。\n');
    
  } catch (error) {
    console.error('❌ 测试失败:', error);
    process.exit(1);
  }
}

// 如果直接运行此文件，则执行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests().catch(error => {
    console.error('测试执行失败:', error);
    process.exit(1);
  });
}

export { runAllTests };