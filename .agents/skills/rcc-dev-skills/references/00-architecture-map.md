# 00 Architecture Map（PipeDebug 视角）

## 索引概要
- L1-L9 `single-path`：单一路径架构。
- L10-L43 `layer-map`：分层职责 + 关键文件。
- L44-L88 `pipeline-sequence`：请求编排顺序。
- L89-L123 `ssot`：真源边界与禁止跨层重写。

## 单一路径（SSOT）

`HTTP Server -> llmswitch-core Hub Pipeline -> Virtual Router -> Provider Runtime -> Upstream`

## 分层职责（主文件）

### A. HTTP Host 层（RouteCodex）
- 入口与路由：
  - `src/server/runtime/http-server/routes.ts`
  - `src/server/runtime/http-server/http-server-bootstrap.ts`
- 运行时装配：
  - `src/server/runtime/http-server/http-server-runtime-setup.ts`
  - `src/server/runtime/http-server/http-server-runtime-providers.ts`
- 执行器：
  - `src/server/runtime/http-server/request-executor.ts`
  - `src/server/runtime/http-server/executor-provider.ts`
  - `src/server/runtime/http-server/executor/retry-engine.ts`

### B. Hub Pipeline 编排层（llmswitch-core TS 壳）
- 主编排：
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.ts`
  - `.../hub-pipeline-execute-request-stage.ts`
  - `.../hub-pipeline-route-and-outbound.ts`
- chat-process 入口：
  - `.../hub-pipeline-execute-chat-process-entry.ts`

### C. Virtual Router 层（路由语义）
- 引擎入口：
  - `sharedmodule/llmswitch-core/src/router/virtual-router/engine.ts`
  - `.../engine-selection.ts`
- 路由配置 bootstrap：
  - `.../bootstrap.ts`
  - `.../bootstrap/routing-config.ts`

### D. Rust Hotpath 真源
- 关键 crate：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/`
- 核心文件（示例）：
  - `src/virtual_router_engine/engine/route.rs`
  - `src/virtual_router_engine/engine/selection.rs`
  - `src/req_process_stage2_route_select.rs`
  - `src/resp_process_stage1_tool_governance.rs`
  - `src/resp_process_stage2_finalize.rs`

## 请求编排顺序（简化）

1. HTTP handler 收到 `/v1/chat|responses|messages`。
2. request-executor 组装 metadata / adapter context。
3. Hub Pipeline 执行 req_inbound。
4. Chat-process 做工具治理、servertool、stopMessage/clock 语义。
5. Route select 选择 route + provider key。
6. Outbound stage 生成 provider payload。
7. Host 按 runtimeKey 调 Provider runtime 发送。
8. Inbound response 进入 finalize（tool/text/reasoning 归一）。
9. 输出为 chat/responses/sse 形状返回客户端。

## 真源边界（必须遵守）

1. 路由策略、sticky、priority/weighted 语义：Rust 真源。
2. Host 层不做 provider 选择重写。
3. 工具收割与标准化：走统一骨架（不可 provider 私有分叉）。
4. stopMessage/clock/continue_execution：走 client injection 责任链，不重建旁路。
