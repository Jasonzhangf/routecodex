# Pipeline Utilities

流水线模块的工具类，提供通用功能和辅助方法。

## 工具类清单

### 核心工具
- **transformation-engine.ts**: 转换引擎，处理JSON路径操作和数据转换
- **error-integration.ts**: 错误处理集成，连接ErrorHandlingCenter
- **debug-logger.ts**: 调试日志记录器，集成DebugCenter

## 功能特性

### TransformationEngine
- JSON路径解析和操作
- 多种转换类型支持
- 条件转换逻辑
- 批量转换优化

### PipelineErrorIntegration
- 统一错误处理接口
- 上下文信息收集
- 错误分类和路由
- 重试逻辑协调

### PipelineDebugLogger
- 分阶段日志记录
- 性能数据收集
- 结构化日志格式
- DebugCenter集成

## 使用示例

```typescript
// 使用转换引擎
const engine = new TransformationEngine();
const result = await engine.applyTransformation(data, rules, context);

// 使用错误处理集成
const errorIntegration = new PipelineErrorIntegration(errorHandlingCenter);
await errorIntegration.handleModuleError(error, context);

// 使用调试日志
const logger = new PipelineDebugLogger(debugCenter);
logger.logRequest('pipeline-stage', request, metadata);
```