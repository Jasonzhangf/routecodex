# 类型定义模块 (Types Module)

## 概述
类型定义模块提供 RouteCodex Host 与共享模块的 TypeScript 类型系统，重点包括：
- 与 `@jsonstudio/llms` 共享的 DTO/接口
- 配置加载相关类型
- 调试与会话类型

## 核心文件
- `common-types.ts`：基础 JSON/日志类型。
- `shared-dtos.ts`：请求/响应/错误等共享数据结构。
- `external-types.ts`：第三方模块的类型声明。
- `base-types.ts`：Host 与 `llmswitch-core` 的桥接类型。

## 维护原则
- 与 `sharedmodule/llmswitch-core/dist/types` 保持一致，避免重复定义。
- 新增 DTO 或接口应同步更新到共享模块，并重新构建。
- 调试相关类型应与 `src/debug/types.ts` 对齐。
