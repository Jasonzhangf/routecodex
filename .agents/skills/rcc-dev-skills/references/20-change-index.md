# 20 Change Index（功能改动落点）

## 索引概要
- L1-L12 `purpose`：按功能找改动入口。
- L13-L93 `feature-map`：功能 -> 主修改文件。
- 若当前问题不是“改哪个功能域”，而是“先看什么、怎么锁唯一修改点、怎么避免改到旧函数”，先读 `references/21-change-workflow.md`。

## 功能 -> 改哪里

| 功能域 | 首改文件 | 次改文件 | 备注 |
|---|---|---|---|
| 路由权重/priority/sticky 语义 | `rust-core/.../virtual_router_engine/engine/selection.rs` | `.../load_balancer.rs` | 路由算法优先改 Rust 真源 |
| 路由配置解析（targets/weights 归一） | `sharedmodule/.../bootstrap/routing-config.ts` | `src/config/virtual-router-builder.ts` | 配置形状统一在 bootstrap |
| 路由指令 `<**...**>` | `sharedmodule/.../routing-instructions/parse.ts` | `.../routing-instructions/state.ts` | 不在 Host 重做解析 |
| 工具收割/标准文本 harvest | `rust-core/.../hub_reasoning_tool_normalizer.rs` | `src/providers/core/runtime/standard-tool-text-harvest.ts` | 骨架统一，避免 provider 私有分叉 |
| req outbound 兼容映射 | `rust-core/.../req_outbound_stage3_compat/*` | `src/server/runtime/http-server/executor/provider-request-context.ts` | 400/形状错优先看这里 |
| response finalize | `rust-core/.../resp_process_stage2_finalize.rs` | `shared_chat_output_normalizer.rs` | 空回复/finish_reason 异常 |
| Provider runtime 装配 | `src/server/runtime/http-server/http-server-runtime-providers.ts` | `executor/provider-runtime-resolver.ts` | runtime not found 常见入口 |
| Provider 调用重试/回退 | `src/server/runtime/http-server/executor/retry-engine.ts` | `executor-provider.ts` | 单 provider 不得风暴重试 |
| OAuth 刷新与 quota 联动 | `src/server/runtime/http-server/http-server-runtime-setup.ts` | `src/manager/quota/*` | 仅管理 routing 内 provider |
| stopMessage/clock/continue_execution 注入 | `src/server/runtime/http-server/executor/client-injection-flow.ts` | `sharedmodule/.../servertool/handlers/stop-message-auto.ts` | 注入链路单一路径 |
| vision/multimodal/video 自动路由 | `sharedmodule/.../router/virtual-router/features.ts` | `src/servertool/handlers/vision.ts` | 仅声明能力即命中 |
| daemon admin 配置热更新 | `src/server/runtime/http-server/daemon-admin/providers-handler.ts` | `.../providers-handler-routing-utils.ts` | API 改配置走这里 |
