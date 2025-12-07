# 工具模块 (Utils Module)

## 概述
工具模块提供 Host 层通用工具函数与错误处理，不涉及工具治理或协议转换。

## 核心工具
- `error-handler-registry.ts`：基于 `ErrorHandlingCenter` 的错误注册表。
- `load-balancer.ts`：Provider 层多 key 轮询负载均衡。
- `failover.ts`：Provider 故障转移与健康检查。
- `key-429-tracker.ts`：API Key 限流状态追踪。
- `snapshot-writer.ts`：快照写入工具（与 `src/debug/*` 共用）。

## 使用原则
- 工具函数不做任何 provider 特定逻辑或工具参数修复。
- 仅用于 Host 层辅助（认证、负载、错误、快照）。
- 新增工具需保持与 `llmswitch-core` 解耦。

## 调试
- 错误处理统一通过 `ErrorHandlingCenter`，日志结构化。
- 快照工具与 `src/debug/snapshot-store.ts` 共用目录与格式。
