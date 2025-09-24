# RouteCodex 离线日志捕获与可视化分析指南

## 概述

RouteCodex 提供了完整的离线日志捕获机制，无需运行可视化Web界面即可记录模块运行数据，后续可进行离线分析和可视化展示。

## 离线日志捕获机制

### 核心组件

1. **DebugFileLogger** - 文件日志记录器
2. **UnifiedModuleLogger** - 统一模块日志器
3. **LogFileScanner** - 日志文件扫描器
4. **TimeSeriesIndexer** - 时间序列索引器

### 日志文件格式

- **JSONL 格式** - 每行一个JSON对象，便于流式处理
- **自动轮转** - 按时间和大小自动分割日志文件
- **压缩支持** - 支持日志文件压缩存储

## 如何开始离线捕获日志

### 方法1：使用 DebugFileLogger（推荐）

```typescript
import { DebugFileLogger } from 'routecodex/debug';

// 初始化文件日志记录
DebugFileLogger.initialize({
  filePath: './logs/route-debug.jsonl',
  enabled: true
});

// 现在所有调试事件都会自动记录到文件
// 包括模块调用、错误、性能指标等
```

### 方法2：使用 UnifiedModuleLogger

```typescript
import { UnifiedModuleLogger } from 'routecodex/logging';

// 为特定模块创建日志器
const logger = new UnifiedModuleLogger({
  moduleId: 'my-processor',
  moduleType: 'processor',
  enableFile: true,
  logDirectory: './logs/modules',
  logLevel: 'detailed',
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxFiles: 5
});

// 记录各种级别日志
logger.debug('模块初始化完成', { config: moduleConfig });
logger.info('开始处理请求', { requestId, timestamp });
logger.warn('性能警告', { responseTime: 1500, threshold: 1000 });
logger.error('处理失败', error, { requestId, stack: error.stack });
```

### 方法3：在 AdvBaseModule 中启用文件日志

```typescript
import { AdvBaseModule } from 'routecodex/adv-base-module';

class MyModule extends AdvBaseModule {
  constructor() {
    super();
    
    // 配置离线日志
    this.setupOfflineLogging({
      enabled: true,
      logDirectory: './logs/modules/my-module',
      logLevel: 'detailed',
      includePerformance: true,
      includeStackTraces: true
    });
  }

  async processIncoming(request: any): Promise<any> {
    return this.runWithDryRun(
      { opName: 'processIncoming', phase: 'request', direction: 'incoming' },
      request,
      async () => {
        // 记录处理开始
        this.logInfo('开始处理请求', { 
          requestId: request.id,
          timestamp: Date.now() 
        });
        
        try {
          const result = await this.doProcessing(request);
          
          // 记录处理完成
          this.logInfo('请求处理完成', {
            requestId: request.id,
            processingTime: Date.now() - startTime,
            resultSize: JSON.stringify(result).length
          });
          
          return result;
        } catch (error) {
          // 记录错误
          this.logError('请求处理失败', error, {
            requestId: request.id,
            stack: error.stack
          });
          throw error;
        }
      },
      { nodeId: this.id, nodeType: this.type }
    );
  }
}
```

## 如何让模块开启离线日志

### 步骤1：配置日志目录

```typescript
// 在主程序中配置日志系统
import { UnifiedLoggingSystem } from 'routecodex/logging';

const loggingSystem = UnifiedLoggingSystem.getInstance({
  baseLogDirectory: './logs',
  enableFileLogging: true,
  enableCompression: true,
  maxLogAge: 7 * 24 * 60 * 60 * 1000, // 7天
  logLevel: 'detailed'
});
```

### 步骤2：为每个模块创建专用日志器

```typescript
// 模块基类中添加日志支持
abstract class LoggableModule extends BaseModule {
  protected logger: UnifiedModuleLogger;
  
  constructor(moduleId: string, moduleType: string) {
    super();
    
    this.logger = new UnifiedModuleLogger({
      moduleId,
      moduleType,
      enableFile: true,
      enableConsole: process.env.NODE_ENV === 'development',
      logDirectory: `./logs/modules/${moduleId}`,
      maxFileSize: 50 * 1024 * 1024, // 50MB
      maxFiles: 10,
      enableCompression: true
    });
  }
  
  protected logOperation(name: string, data?: any): void {
    this.logger.info(`操作: ${name}`, data);
  }
  
  protected logError(operation: string, error: Error, context?: any): void {
    this.logger.error(`操作失败: ${operation}`, error, context);
  }
  
  protected logPerformance(operation: string, duration: number, metadata?: any): void {
    this.logger.debug(`性能指标: ${operation}`, {
      duration,
      timestamp: Date.now(),
      ...metadata
    });
  }
}
```

### 步骤3：在模块方法中添加日志点

```typescript
class ProcessorModule extends LoggableModule {
  async processRequest(request: any): Promise<any> {
    const startTime = Date.now();
    const requestId = request.id || generateId();
    
    this.logOperation('processRequest.start', {
      requestId,
      requestType: request.type,
      timestamp: startTime
    });
    
    try {
      // 实际处理逻辑
      const result = await this.doProcessing(request);
      
      const duration = Date.now() - startTime;
      this.logPerformance('processRequest', duration, {
        requestId,
        resultSize: JSON.stringify(result).length
      });
      
      this.logOperation('processRequest.complete', {
        requestId,
        duration,
        success: true
      });
      
      return result;
    } catch (error) {
      this.logError('processRequest', error, {
        requestId,
        duration: Date.now() - startTime
      });
      throw error;
    }
  }
}
```

## 离线可视化分析方法

### 方法1：使用日志解析器

```typescript
import { LogFileScanner, JsonlParser } from 'routecodex/logging';

// 扫描日志文件
async function analyzeLogs() {
  // 1. 扫描日志文件
  const scanResult = await LogFileScanner.scanLogFiles({
    scanDirectory: './logs',
    moduleIds: ['processor', 'transformer'],
    timeRange: {
      start: Date.now() - 24 * 60 * 60 * 1000, // 最近24小时
      end: Date.now()
    },
    includeCompressed: true
  });
  
  console.log('发现日志文件:', scanResult.totalFiles);
  
  // 2. 解析日志文件
  const parser = new JsonlParser();
  const allEntries = [];
  
  for (const fileInfo of scanResult.files) {
    console.log(`解析文件: ${fileInfo.filePath}`);
    const entries = await parser.parseFile(fileInfo.filePath);
    allEntries.push(...entries);
  }
  
  // 3. 分析数据
  const analysis = analyzeLogEntries(allEntries);
  console.log('分析结果:', analysis);
  
  return analysis;
}

function analyzeLogEntries(entries: any[]) {
  const moduleStats = {};
  const errorStats = { total: 0, byType: {} };
  const performanceStats = { totalTime: 0, count: 0 };
  
  entries.forEach(entry => {
    // 模块统计
    const moduleId = entry.moduleId || 'unknown';
    if (!moduleStats[moduleId]) {
      moduleStats[moduleId] = { count: 0, errors: 0 };
    }
    moduleStats[moduleId].count++;
    
    // 错误统计
    if (entry.level === 'error') {
      errorStats.total++;
      moduleStats[moduleId].errors++;
      const errorType = entry.data?.errorType || 'unknown';
      errorStats.byType[errorType] = (errorStats.byType[errorType] || 0) + 1;
    }
    
    // 性能统计
    if (entry.data?.duration) {
      performanceStats.totalTime += entry.data.duration;
      performanceStats.count++;
    }
  });
  
  return {
    totalEntries: entries.length,
    moduleStats,
    errorStats,
    avgProcessingTime: performanceStats.count > 0 ? 
      performanceStats.totalTime / performanceStats.count : 0,
    timeRange: {
      start: Math.min(...entries.map(e => e.timestamp)),
      end: Math.max(...entries.map(e => e.timestamp))
    }
  };
}
```

### 方法2：使用时间序列分析

```typescript
import { TimeSeriesIndexer } from 'routecodex/logging';

async function performTimeSeriesAnalysis() {
  // 创建时间序列索引
  const indexer = new TimeSeriesIndexer({
    indexDirectory: './logs/indexes',
    timeBucketSize: 60000, // 1分钟桶
    enableCompression: true
  });
  
  // 索引日志文件
  await indexer.indexLogFiles('./logs/modules');
  
  // 查询特定时间范围的数据
  const query = {
    timeRange: {
      start: Date.now() - 3600000, // 最近1小时
      end: Date.now()
    },
    filters: {
      moduleIds: ['processor', 'transformer'],
      logLevels: ['info', 'error'],
      keywords: ['performance', 'timeout']
    }
  };
  
  const results = await indexer.query(query);
  
  // 生成时间序列图表数据
  const timeSeriesData = generateTimeSeriesData(results);
  
  return {
    totalResults: results.length,
    timeSeriesData,
    summary: generateSummary(results)
  };
}

function generateTimeSeriesData(results: any[]) {
  const timeBuckets = {};
  
  results.forEach(result => {
    const minute = Math.floor(result.timestamp / 60000) * 60000;
    if (!timeBuckets[minute]) {
      timeBuckets[minute] = {
        timestamp: minute,
        count: 0,
        errors: 0,
        avgDuration: 0,
        durations: []
      };
    }
    
    timeBuckets[minute].count++;
    
    if (result.level === 'error') {
      timeBuckets[minute].errors++;
    }
    
    if (result.data?.duration) {
      timeBuckets[minute].durations.push(result.data.duration);
    }
  });
  
  // 计算平均持续时间
  Object.values(timeBuckets).forEach(bucket => {
    if (bucket.durations.length > 0) {
      bucket.avgDuration = bucket.durations.reduce((a, b) => a + b, 0) / bucket.durations.length;
      delete bucket.durations; // 清理临时数据
    }
  });
  
  return Object.values(timeBuckets).sort((a, b) => a.timestamp - b.timestamp);
}
```

### 方法3：生成HTML报告

```typescript
async function generateHTMLReport(analysis: any) {
  const html = `
<!DOCTYPE html>
<html>
<head>
    <title>RouteCodex 离线日志分析报告</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .chart-container { width: 800px; height: 400px; margin: 20px 0; }
        .stats { background: #f5f5f5; padding: 15px; border-radius: 5px; }
        .error { color: #d32f2f; }
        .success { color: #388e3c; }
    </style>
</head>
<body>
    <h1>RouteCodex 日志分析报告</h1>
    <div class="stats">
        <h2>统计摘要</h2>
        <p>总日志条目: ${analysis.totalEntries}</p>
        <p>平均处理时间: ${analysis.avgProcessingTime.toFixed(2)}ms</p>
        <p>错误总数: ${analysis.errorStats.total}</p>
        <p>分析时间范围: ${new Date(analysis.timeRange.start).toLocaleString()} - ${new Date(analysis.timeRange.end).toLocaleString()}</p>
    </div>
    
    <div class="chart-container">
        <canvas id="moduleChart"></canvas>
    </div>
    
    <div class="chart-container">
        <canvas id="errorChart"></canvas>
    </div>
    
    <script>
        // 模块活动图表
        const moduleCtx = document.getElementById('moduleChart').getContext('2d');
        new Chart(moduleCtx, {
            type: 'bar',
            data: {
                labels: ${JSON.stringify(Object.keys(analysis.moduleStats))},
                datasets: [{
                    label: '日志数量',
                    data: ${JSON.stringify(Object.values(analysis.moduleStats).map(s => s.count))},
                    backgroundColor: 'rgba(54, 162, 235, 0.2)',
                    borderColor: 'rgba(54, 162, 235, 1)',
                    borderWidth: 1
                }, {
                    label: '错误数量',
                    data: ${JSON.stringify(Object.values(analysis.moduleStats).map(s => s.errors))},
                    backgroundColor: 'rgba(255, 99, 132, 0.2)',
                    borderColor: 'rgba(255, 99, 132, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { beginAtZero: true }
                }
            }
        });
        
        // 错误类型图表
        const errorCtx = document.getElementById('errorChart').getContext('2d');
        new Chart(errorCtx, {
            type: 'pie',
            data: {
                labels: ${JSON.stringify(Object.keys(analysis.errorStats.byType))},
                datasets: [{
                    data: ${JSON.stringify(Object.values(analysis.errorStats.byType))},
                    backgroundColor: [
                        'rgba(255, 99, 132, 0.8)',
                        'rgba(54, 162, 235, 0.8)',
                        'rgba(255, 206, 86, 0.8)',
                        'rgba(75, 192, 192, 0.8)'
                    ]
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false
            }
        });
    </script>
</body>
</html>`;
  
  require('fs').writeFileSync('./logs/analysis-report.html', html);
  console.log('📊 HTML报告已生成: ./logs/analysis-report.html');
}
```

## 最佳实践

### 1. 日志配置优化

```typescript
// 生产环境配置
const offlineConfig = {
  enableFile: true,
  enableConsole: false, // 生产环境关闭控制台输出
  logLevel: 'info', // 只记录重要信息
  maxFileSize: 100 * 1024 * 1024, // 100MB
  maxFiles: 20,
  enableCompression: true, // 启用压缩节省空间
  sensitiveFields: ['password', 'token', 'apiKey'] // 敏感字段过滤
};

// 开发环境配置
const devConfig = {
  enableFile: true,
  enableConsole: true,
  logLevel: 'debug', // 记录详细信息
  maxFileSize: 10 * 1024 * 1024, // 10MB
  maxFiles: 5,
  enableCompression: false
};
```

### 2. 定期日志轮转

```typescript
// 设置定时轮转
setInterval(() => {
  logger.rotateLogs();
}, 24 * 60 * 60 * 1000); // 每天轮转

// 或者按大小轮转
logger.on('fileSizeLimit', () => {
  logger.rotateLogs();
});
```

### 3. 异步日志写入

```typescript
// 使用异步写入避免阻塞
async function asyncLogOperation(name: string, data: any) {
  // 先记录到内存缓冲区
  logBuffer.push({ name, data, timestamp: Date.now() });
  
  // 定期批量写入文件
  if (logBuffer.length >= 100) {
    await flushLogBuffer();
  }
}

async function flushLogBuffer() {
  const batch = logBuffer.splice(0, 100);
  for (const log of batch) {
    await logger.writeLog(log);
  }
}
```

### 4. 日志采样

```typescript
// 高频操作使用采样
class SampledLogger {
  private sampleRate: number;
  
  constructor(sampleRate: number = 0.1) { // 10%采样率
    this.sampleRate = sampleRate;
  }
  
  logHighFrequency(operation: string, data: any) {
    if (Math.random() < this.sampleRate) {
      logger.info(`[采样] ${operation}`, data);
    }
  }
}
```

## 命令行工具

### 快速分析脚本

```bash
#!/bin/bash
# analyze-logs.sh

LOG_DIR="./logs"
OUTPUT_DIR="./analysis"

# 创建输出目录
mkdir -p $OUTPUT_DIR

# 1. 扫描日志文件
echo "📁 扫描日志文件..."
node -e "
const { LogFileScanner } = require('routecodex/logging');
const scanner = new LogFileScanner({ scanDirectory: '$LOG_DIR' });
scanner.scan().then(result => {
  console.log('发现文件:', result.totalFiles);
  require('fs').writeFileSync('$OUTPUT_DIR/scan-result.json', JSON.stringify(result, null, 2));
});
"

# 2. 生成分析报告
echo "📊 生成分析报告..."
node -e "
const scanResult = JSON.parse(require('fs').readFileSync('$OUTPUT_DIR/scan-result.json'));
const { JsonlParser } = require('routecodex/logging');
const parser = new JsonlParser();

async function generateReport() {
  const allEntries = [];
  for (const file of scanResult.files) {
    const entries = await parser.parseFile(file.filePath);
    allEntries.push(...entries);
  }
  
  // 生成分析结果
  const report = analyzeEntries(allEntries);
  require('fs').writeFileSync('$OUTPUT_DIR/analysis-report.json', JSON.stringify(report, null, 2));
  
  console.log('分析完成:', report.totalEntries, '条日志');
}

generateReport();
"

# 3. 生成HTML报告
echo "🌐 生成HTML可视化报告..."
node generate-html-report.js $OUTPUT_DIR/analysis-report.json $OUTPUT_DIR/report.html

echo "✅ 分析完成！查看结果:"
echo "   扫描结果: $OUTPUT_DIR/scan-result.json"
echo "   分析报告: $OUTPUT_DIR/analysis-report.json"
echo "   HTML报告: $OUTPUT_DIR/report.html"
```

## 常见问题

### Q: 日志文件太大怎么办？

```typescript
// 使用日志轮转和压缩
const logger = new UnifiedModuleLogger({
  enableCompression: true,
  maxFileSize: 50 * 1024 * 1024, // 50MB
  maxFiles: 10,
  cleanupPolicy: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7天
    maxTotalSize: 500 * 1024 * 1024 // 500MB
  }
});
```

### Q: 如何只记录错误日志？

```typescript
const errorOnlyLogger = new UnifiedModuleLogger({
  logLevel: 'error', // 只记录错误
  filter: (entry) => entry.level === 'error'
});
```

### Q: 日志格式如何自定义？

```typescript
const customFormatLogger = new UnifiedModuleLogger({
  format: (entry) => ({
    time: new Date(entry.timestamp).toISOString(),
    level: entry.level.toUpperCase(),
    module: entry.moduleId,
    msg: entry.message,
    data: entry.data
  })
});
```

## 总结

RouteCodex 的离线日志捕获系统提供了：

1. **零依赖** - 无需运行Web服务即可记录
2. **高性能** - 异步写入，不影响主流程
3. **可扩展** - 支持自定义格式和处理
4. **易分析** - 提供完整的解析和分析工具
5. **可视化** - 可生成HTML报告和图表

这套系统既能满足生产环境的日志记录需求，又能提供开发调试的详细信息，是RouteCodex调试体系的重要组成部分。