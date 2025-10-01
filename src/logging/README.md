# 日志系统 (Logging System)

## 概述

日志系统提供RouteCodex的完整日志记录和管理功能，支持多种日志级别、输出格式和存储方式。

## 核心功能

### 日志记录
- **多级别日志**: debug, info, warn, error
- **结构化日志**: JSON格式日志记录
- **上下文信息**: 请求ID、模块名称等
- **性能监控**: 执行时间统计

### 日志管理
- **文件轮转**: 自动日志文件轮转
- **存储管理**: 日志文件清理和归档
- **索引系统**: 高效的日志检索
- **压缩存储**: 日志文件压缩

## 目录结构

```
logging/
├── simple-log-integration.ts    # 简化日志集成
├── indexer/                    # 日志索引系统
│   ├── SimpleTimeSeriesIndexer.ts
│   └── TimeSeriesIndexer.ts
├── parser/                     # 日志解析器
│   ├── JsonlParser.ts
│   └── LogFileScanner.ts
├── logger.ts                   # 日志记录器
├── module-log-manager.ts       # 模块日志管理
└── index.ts                    # 日志模块入口
```

## 主要组件

### SimpleLogIntegration
简化日志集成模块，提供基础的日志记录功能：
- 一键式日志配置
- 环境变量集成
- 配置持久化
- 自动管理

### TimeSeriesIndexer
时间序列索引器，提供高效的日志检索功能：
- 时间范围查询
- 模块过滤
- 级别过滤
- 压缩存储

### JsonlParser
JSONL日志解析器：
- 结构化日志解析
- 错误恢复
- 批量处理
- 性能优化

## 使用示例

### 基本日志记录
```typescript
import { Logger } from './logger';

const logger = new Logger('my-module');

// 记录不同级别的日志
logger.debug('Debug information');
logger.info('Process started');
logger.warn('Warning message');
logger.error('Error occurred');

// 带上下文的日志
logger.info('Request processed', {
  requestId: 'req-123',
  duration: 150,
  status: 'success'
});
```

### 简化日志配置
```typescript
import { SimpleLogIntegration } from './simple-log-integration';

const logIntegration = new SimpleLogIntegration();

// 启用简化日志
await logIntegration.enableSimpleLog({
  level: 'debug',
  output: 'console',
  logDirectory: './logs'
});

// 禁用简化日志
await logIntegration.disableSimpleLog();
```

### 日志索引和搜索
```typescript
import { TimeSeriesIndexer } from './indexer/TimeSeriesIndexer';

const indexer = new TimeSeriesIndexer('./logs');

// 索引日志文件
await indexer.indexLogFile('app.log');

// 搜索日志
const results = await indexer.search({
  startTime: Date.now() - 3600000, // 1小时前
  endTime: Date.now(),
  level: 'error',
  module: 'my-module'
});

console.log('搜索结果:', results);
```

## 配置选项

### 日志级别
- **debug**: 调试信息
- **info**: 一般信息
- **warn**: 警告信息
- **error**: 错误信息

### 输出格式
- **console**: 控制台输出
- **file**: 文件输出
- **both**: 控制台和文件输出

### 存储配置
- **logDirectory**: 日志文件目录
- **maxFileSize**: 最大文件大小
- **maxFiles**: 最大文件数量
- **compress**: 压缩存储

## 性能特性

### 高性能
- **异步写入**: 非阻塞日志写入
- **批量处理**: 批量日志处理
- **内存优化**: 高效内存使用
- **并发安全**: 线程安全设计

### 可扩展性
- **模块化设计**: 可插拔组件
- **配置驱动**: 灵活配置
- **自定义输出**: 支持自定义输出格式
- **插件系统**: 支持第三方插件

## 最佳实践

### 日志级别使用
1. **debug**: 开发调试信息
2. **info**: 关键业务流程
3. **warn**: 可恢复的错误
4. **error**: 严重错误

### 性能优化
1. **避免过度日志**: 只记录必要信息
2. **使用结构化日志**: 便于后续分析
3. **定期清理**: 避免日志文件过大
4. **监控日志大小**: 防止磁盘空间不足

## 监控和诊断

### 日志监控
- **错误率监控**: 统计错误日志数量
- **性能监控**: 监控日志写入性能
- **磁盘使用**: 监控日志文件大小
- **实时告警**: 异常情况告警

### 诊断工具
- **日志分析**: 日志内容分析
- **性能分析**: 执行时间分析
- **错误追踪**: 错误链路追踪
- **资源使用**: 系统资源使用分析

## 相关依赖

- **winston**: 日志记录库
- **fs-extra**: 文件系统操作
- **chalk**: 终端颜色输出
- **moment**: 时间处理

## 文档

- [RouteCodex 主文档](../../README.md)
- [日志配置指南](../../docs/logging.md)
- [API 文档](../../docs/api/logging.md)
- [最佳实践](../../docs/best-practices.md)