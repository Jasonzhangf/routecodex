/**
 * 历史数据调试演示程序
 * 
 * 展示完整的基于历史记录的调试系统功能
 */

import { parseHistoricalLogs } from '../src/logging/parser/index.js';
import { LogLevel } from '../src/logging/types.js';

/**
 * 生成模拟历史数据
 */
function generateMockHistoricalData() {
  const now = Date.now();
  const entries = [];
  
  // 生成24小时的历史数据
  for (let hour = 0; hour < 24; hour++) {
    const timestamp = now - (24 - hour) * 60 * 60 * 1000;
    
    // 每个小时生成不同类型的日志
    
    // 1. Switch层日志
    entries.push({
      timestamp: timestamp,
      level: hour % 6 === 0 ? LogLevel.ERROR : (hour % 3 === 0 ? LogLevel.WARN : LogLevel.INFO),
      moduleId: 'llm-switch-main',
      moduleType: 'LLMSwitch',
      message: `Switch层处理完成，路由到${hour % 2 === 0 ? 'compatibility' : 'provider'}模块`,
      data: {
        routingDecision: hour % 2 === 0 ? 'compatibility' : 'provider',
        processingTime: 50 + Math.random() * 100,
        requestId: `req-${hour}-switch`
      },
      tags: ['switch', 'routing', `hour-${hour}`],
      version: '0.0.1'
    });
    
    // 2. Compatibility层日志
    entries.push({
      timestamp: timestamp + 1000,
      level: hour % 8 === 0 ? LogLevel.ERROR : (hour % 4 === 0 ? LogLevel.WARN : LogLevel.INFO),
      moduleId: 'compatibility-transformer',
      moduleType: 'CompatibilityModule',
      message: `协议转换完成，耗时${30 + Math.random() * 50}ms`,
      data: {
        sourceProtocol: 'openai',
        targetProtocol: 'lmstudio',
        transformationTime: 30 + Math.random() * 50,
        requestId: `req-${hour}-compat`
      },
      tags: ['compatibility', 'transformation', `hour-${hour}`],
      version: '0.0.1'
    });
    
    // 3. Provider层日志
    entries.push({
      timestamp: timestamp + 2000,
      level: hour % 12 === 0 ? LogLevel.ERROR : (hour % 6 === 0 ? LogLevel.WARN : LogLevel.INFO),
      moduleId: 'lmstudio-provider',
      moduleType: 'ProviderModule',
      message: `Provider请求处理完成，状态: ${hour % 3 === 0 ? 'success' : 'partial'}`,
      data: {
        provider: 'lmstudio',
        endpoint: 'http://localhost:1234/v1/chat/completions',
        responseTime: 200 + Math.random() * 300,
        statusCode: hour % 3 === 0 ? 200 : 206,
        requestId: `req-${hour}-provider`
      },
      tags: ['provider', 'lmstudio', `hour-${hour}`],
      version: '0.0.1'
    });
    
    // 4. AI Service层日志
    entries.push({
      timestamp: timestamp + 3000,
      level: hour % 10 === 0 ? LogLevel.ERROR : LogLevel.INFO,
      moduleId: 'ai-service-response',
      moduleType: 'AIService',
      message: `AI服务响应生成完成，token数量: ${100 + Math.random() * 500}`,
      data: {
        model: 'qwen3-4b-thinking-2507-mlx',
        tokens: 100 + Math.random() * 500,
        finishReason: 'stop',
        requestId: `req-${hour}-ai`
      },
      tags: ['ai-service', 'response', `hour-${hour}`],
      version: '0.0.1'
    });
    
    // 5. 工具调用相关日志（部分小时）
    if (hour % 3 === 0) {
      entries.push({
        timestamp: timestamp + 4000,
        level: hour % 9 === 0 ? LogLevel.ERROR : LogLevel.INFO,
        moduleId: 'tool-execution-engine',
        moduleType: 'ToolExecutionModule',
        message: `工具调用执行完成: ${['file_read', 'file_write', 'command_execute'][hour % 3]}`,
        data: {
          toolName: ['file_read', 'file_write', 'command_execute'][hour % 3],
          executionTime: 50 + Math.random() * 100,
          success: hour % 9 !== 0,
          requestId: `req-${hour}-tools`
        },
        tags: ['tools', 'execution', `hour-${hour}`],
        version: '0.0.1'
      });
    }
    
    // 6. 错误和异常日志（模拟问题场景）
    if (hour % 5 === 0) {
      entries.push({
        timestamp: timestamp + 5000,
        level: LogLevel.ERROR,
        moduleId: 'error-handler',
        moduleType: 'ErrorHandlerModule',
        message: `捕获到异常: ${['网络超时', '认证失败', '数据格式错误'][hour % 3]}`,
        error: {
          name: ['NetworkError', 'AuthError', 'FormatError'][hour % 3],
          message: ['网络连接超时', 'API密钥验证失败', '请求数据格式不正确'][hour % 3],
          code: ['NETWORK_TIMEOUT', 'AUTH_FAILED', 'INVALID_FORMAT'][hour % 3],
          stack: `Error: ${['网络连接超时', 'API密钥验证失败', '请求数据格式不正确'][hour % 3]}\n    at ${['connection.js', 'auth.js', 'parser.js'][hour % 3]}:123:45`
        },
        data: {
          recoveryAction: 'retry',
          retryCount: 1,
          fallbackEnabled: true
        },
        tags: ['error', 'exception', `hour-${hour}`],
        version: '0.0.1'
      });
    }
    
    // 7. 性能监控日志
    entries.push({
      timestamp: timestamp + 6000,
      level: LogLevel.INFO,
      moduleId: 'performance-monitor',
      moduleType: 'PerformanceMonitor',
      message: `系统性能监控: CPU使用率${20 + Math.random() * 30}%, 内存使用${100 + Math.random() * 200}MB`,
      data: {
        cpuUsage: 20 + Math.random() * 30,
        memoryUsage: (100 + Math.random() * 200) * 1024 * 1024, // 转换为bytes
        responseTime: 100 + Math.random() * 400,
        throughput: 50 + Math.random() * 100
      },
      tags: ['performance', 'monitoring', `hour-${hour}`],
      version: '0.0.1'
    });
  }
  
  return entries;
}

/**
 * 创建历史日志文件
 */
async function createHistoricalLogFile() {
  console.log('📝 正在生成历史日志数据...');
  const historicalData = generateMockHistoricalData();
  
  // 将数据写入文件
  const fs = await import('fs/promises');
  const path = await import('path');
  
  const logDir = path.join(process.cwd(), 'demo-logs');
  await fs.mkdir(logDir, { recursive: true });
  
  const logFile = path.join(logDir, `historical-demo-${Date.now()}.jsonl`);
  const content = historicalData.map(entry => JSON.stringify(entry)).join('\n');
  
  await fs.writeFile(logFile, content, 'utf-8');
  
  console.log(`✅ 历史日志文件创建完成: ${logFile}`);
  console.log(`📊 共生成 ${historicalData.length} 条日志记录`);
  
  return logFile;
}

/**
 * 演示历史数据解析
 */
async function demonstrateHistoricalParsing() {
  console.log('\n🚀 开始历史数据解析演示...');
  
  try {
    // 创建历史日志文件
    const logFile = await createHistoricalLogFile();
    
    console.log('\n📖 开始解析历史日志...');
    
    // 使用统一的解析流程
    const result = await parseHistoricalLogs({
      scanDirectory: './demo-logs',
      validationOptions: {
        validationLevel: 'moderate',
        autoFix: true
      },
      cleaningOptions: {
        deduplicate: true,
        sortByTimestamp: true,
        normalizeTimestamps: true,
        normalizeLogLevels: true
      },
      indexOptions: {
        name: 'demo-historical-index',
        shardInterval: 60 * 60 * 1000, // 1小时
        enableCompression: true
      }
    });
    
    console.log(`✅ 解析完成！`);
    console.log(`📁 扫描到 ${result.stats.totalFiles} 个日志文件`);
    console.log(`📊 有效日志条目: ${result.entries.length}`);
    console.log(`⏱️  解析耗时: ${result.stats.parseTime}ms`);
    console.log(`🔧 数据清洗操作: ${result.stats.cleanStats?.normalizedOperations || 0}`);
    
    // 分析数据分布
    const levelCounts = {};
    const moduleCounts = {};
    
    result.entries.forEach(entry => {
      levelCounts[entry.level] = (levelCounts[entry.level] || 0) + 1;
      moduleCounts[entry.moduleId] = (moduleCounts[entry.moduleId] || 0) + 1;
    });
    
    console.log('\n📈 日志级别分布:');
    Object.entries(levelCounts).forEach(([level, count]) => {
      console.log(`   ${level}: ${count} 条`);
    });
    
    console.log('\n🔧 模块分布:');
    Object.entries(moduleCounts).slice(0, 10).forEach(([moduleId, count]) => {
      console.log(`   ${moduleId}: ${count} 条`);
    });
    
    // 时间范围分析
    const timestamps = result.entries.map(entry => entry.timestamp).sort();
    const timeRange = {
      start: new Date(timestamps[0]),
      end: new Date(timestamps[timestamps.length - 1])
    };
    
    console.log(`\n⏰ 时间范围: ${timeRange.start.toLocaleString()} - ${timeRange.end.toLocaleString()}`);
    console.log(`📅 数据跨度: ${((timeRange.end.getTime() - timeRange.start.getTime()) / (1000 * 60 * 60)).toFixed(1)} 小时`);
    
    return result;
    
  } catch (error) {
    console.error('❌ 历史数据解析失败:', error);
    throw error;
  }
}

/**
 * 演示历史数据可视化
 */
async function demonstrateHistoricalVisualization() {
  console.log('\n🎨 开始历史数据可视化演示...');
  
  try {
    // 首先解析历史数据
    const parseResult = await demonstrateHistoricalParsing();
    
    console.log('\n📊 历史数据可视化组件已准备就绪');
    console.log('💡 使用以下配置创建 HistoricalDashboard 组件:');
    
    const dashboardConfig = {
      logDirectory: './demo-logs',
      timeRange: {
        start: Math.min(...parseResult.entries.map(e => e.timestamp)),
        end: Math.max(...parseResult.entries.map(e => e.timestamp))
      },
      theme: 'dark',
      width: 1400,
      height: 900,
      showTimeline: true,
      showComparison: true,
      showDetails: true,
      enableAutoPlay: false,
      playSpeed: 2000
    };
    
    console.log('\n🎯 Dashboard 配置:');
    console.log(JSON.stringify(dashboardConfig, null, 2));
    
    console.log('\n✨ 可视化功能说明:');
    console.log('📈 时间轴导航 - 支持历史数据回放和时间点跳转');
    console.log('🔄 状态对比 - 对比不同时间点的系统状态变化');
    console.log('📊 流水线可视化 - 4层架构的节点状态展示');
    console.log('🔍 详细信息 - 点击节点查看详细日志信息');
    console.log('📄 报告导出 - 生成状态对比分析报告');
    
    // 模拟一些分析结果
    const analysis = {
      totalEntries: parseResult.entries.length,
      timeSpan: '24小时',
      errorRate: (parseResult.entries.filter(e => e.level === 'error').length / parseResult.entries.length * 100).toFixed(1),
      avgProcessingTime: '150ms',
      mostActiveModule: 'llm-switch-main',
      peakHour: '14:00-15:00',
      healthScore: 85
    };
    
    console.log('\n📋 系统健康分析:');
    console.log(`   总日志数: ${analysis.totalEntries}`);
    console.log(`   时间跨度: ${analysis.timeSpan}`);
    console.log(`   错误率: ${analysis.errorRate}%`);
    console.log(`   平均处理时间: ${analysis.avgProcessingTime}`);
    console.log(`   最活跃模块: ${analysis.mostActiveModule}`);
    console.log(`   峰值时段: ${analysis.peakHour}`);
    console.log(`   健康评分: ${analysis.healthScore}/100`);
    
    return { parseResult, dashboardConfig, analysis };
    
  } catch (error) {
    console.error('❌ 历史数据可视化演示失败:', error);
    throw error;
  }
}

/**
 * 主演示函数
 */
async function main() {
  console.log('🎯 RouteCodex 历史数据调试系统演示');
  console.log('=' .repeat(50));
  
  try {
    // 演示历史数据可视化
    const demoResult = await demonstrateHistoricalVisualization();
    
    console.log('\n🎉 演示完成！');
    console.log('\n💡 使用建议:');
    console.log('1. 在实际项目中配置日志目录路径');
    console.log('2. 根据需要调整时间范围和过滤条件');
    console.log('3. 使用状态对比功能分析系统变化趋势');
    console.log('4. 定期导出分析报告进行长期趋势分析');
    console.log('5. 结合实时监控和历史分析进行全面的系统调试');
    
    console.log('\n📚 下一步操作:');
    console.log('- 在React应用中集成 HistoricalDashboard 组件');
    console.log('- 配置实际的日志目录和文件路径');
    console.log('- 根据具体需求自定义可视化样式和功能');
    console.log('- 设置定时刷新和自动分析任务');
    
    return demoResult;
    
  } catch (error) {
    console.error('❌ 演示失败:', error);
    process.exit(1);
  }
}

// 如果直接运行此文件，则执行演示
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => {
    console.log('\n✅ 历史数据调试系统演示程序执行完成');
    process.exit(0);
  }).catch(error => {
    console.error('演示程序执行失败:', error);
    process.exit(1);
  });
}

export { demonstrateHistoricalParsing, demonstrateHistoricalVisualization, generateMockHistoricalData };