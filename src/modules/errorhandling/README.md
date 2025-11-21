+# Error Handling Module

## 模块职责

该模块负责：
- [x] 统一的错误处理机制
- [x] 错误分类和归一化
- [x] 错误恢复策略
- [x] 错误日志记录

**边界定义**：
- ✅ 包含：错误分类、处理逻辑、恢复策略
- ❌ 不包含：业务逻辑、网络层错误、配置错误

## 依赖关系

### 外部依赖
- `@types/node`: Node.js类型定义
- 内部日志模块：错误记录和追踪

### 被依赖关系
- `pipeline`: 使用错误处理机制
- `provider`: 使用错误恢复策略
- `server`: 使用错误分类

### 循环依赖检查
- [x] 确认无循环依赖
- [x] 依赖关系图验证通过

## 接口定义

### 主要函数/类

#### `ErrorHandler`

**功能描述**：统一错误处理入口点

**使用示例**：
```typescript
import { ErrorHandler } from './index.js';

const errorHandler = new ErrorHandler();
const result = await errorHandler.handle(error, context);
```

### 类型定义

```typescript
export interface ErrorContext {
  requestId?: string;
  module?: string;
  operation?: string;
  metadata?: Record<string, unknown>;
}

export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface ErrorClassification {
  category: string;
  severity: ErrorSeverity;
  recoverable: boolean;
  suggestedAction?: string;
}
```

## 使用示例

### 基础用法

```typescript
import { ErrorHandler, ErrorContext } from './index.js';

const errorHandler = new ErrorHandler();
const context: ErrorContext = {
  requestId: 'req-123',
  module: 'provider',
  operation: 'api-call'
};

const result = await errorHandler.handleError(error, context);
```

## 测试指南

### 运行测试

```bash
# 单元测试
npm test -- --grep "errorhandling"

# 覆盖率测试
npm run test:coverage -- --grep "errorhandling"
```

### 测试覆盖率要求
- 函数覆盖率：100%
- 分支覆盖率：>90%
- 行覆盖率：>95%

## 功能清单

### 已实现功能
- [x] `ErrorHandler`: 统一错误处理器 (实现日期: 2024-11-21)
- [x] `ErrorClassifier`: 错误分类器 (实现日期: 2024-11-21)
- [x] `RecoveryStrategy`: 恢复策略 (实现日期: 2024-11-21)

### 规划中功能
- [ ] `CircuitBreaker`: 熔断器模式 (计划版本: v0.82.0)
- [ ] `RetryPolicy`: 重试策略增强 (计划版本: v0.82.0)

## 设计决策

### 架构选择
- **决策1**: 采用分类器模式而非直接判断 - 提高可扩展性
- **决策2**: 策略模式实现恢复逻辑 - 便于定制化

### 性能考虑
- 时间复杂度：O(1)
- 空间复杂度：O(n)
- 性能瓶颈点：错误分类查找

### 安全考虑
- 输入验证：错误对象类型检查
- 错误处理：敏感信息过滤

## 变更记录

### v0.81.62 - 2024-11-21
- **新增**: 模块README文档
- **文档**: 符合AGENTS.md开发方法论

---

*该README遵循AGENTS.md中定义的函数化、原子化、独立化开发方法论*
*最后更新: 2024-11-21*
*维护者: RouteCodex Team*
