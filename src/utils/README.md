# 工具模块

## 功能
- 日志记录
- 错误处理
- 负载均衡
- 故障转移

## 文件说明
- `logger.ts`: 日志工具，基于RCC DebugCenter实现
- `error-handler.ts`: 错误处理，基于RCC ErrorHandling实现
- `load-balancer.ts`: 负载均衡器，支持多种负载均衡策略
- `failover.ts`: 故障转移器，处理Provider故障时的自动切换