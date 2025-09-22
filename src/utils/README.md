# 工具模块

## 功能
- 日志记录
- 错误处理
- 负载均衡
- 故障转移

## 文件说明
- `logger.ts`: 日志工具，基于RCC DebugCenter实现，支持ESM模块导入
- `error-handler.ts`: 错误处理，基于RCC ErrorHandling实现，支持ESM错误传播
- `load-balancer.ts`: 负载均衡器，支持多种负载均衡策略（轮询、权重、最少连接）
- `failover.ts`: 故障转移器，处理Provider故障时的自动切换和健康检查

## 依赖关系
- 依赖 `rcc-debugcenter` 进行日志记录
- 依赖 `rcc-errorhandling` 进行错误处理
- 被 `core/provider-manager.ts` 调用
- 被 `core/request-handler.ts` 调用

## 使用示例
```typescript
import { Logger } from './logger';
import { LoadBalancer } from './load-balancer';
import { Failover } from './failover';

const logger = new Logger();
const loadBalancer = new LoadBalancer();
const failover = new Failover();

logger.info('System started');
const provider = await loadBalancer.selectProvider(providers);
await failover.handleFailure(provider, error);
```