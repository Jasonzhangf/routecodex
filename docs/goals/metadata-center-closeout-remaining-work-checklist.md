# Metadata Center Closeout Remaining Work Checklist

## 1. 目的

这份 checklist 只回答一个问题：

- 在 `MetadataCenter` 收口目标下，当前还剩哪些工作没有完成，顺序是什么，哪些可以直接删，哪些必须先迁 reader/writer/gate 才能删。

它不是新的 contract 真源。contract 真源仍然是：

- [function-map.yml](/Users/fanzhang/Documents/github/routecodex/docs/architecture/function-map.yml)
- [verification-map.yml](/Users/fanzhang/Documents/github/routecodex/docs/architecture/verification-map.yml)
- [mainline-call-map.yml](/Users/fanzhang/Documents/github/routecodex/docs/architecture/mainline-call-map.yml)
- [metadata-center-mainline-source.md](/Users/fanzhang/Documents/github/routecodex/docs/architecture/wiki/metadata-center-mainline-source.md)

## 2. 当前状态总结

已经基本锁清的部分：

- 目标已经明确为“单 request-scoped `MetadataCenter`”。
- metadata family、写策略、禁止越权写入的方向已经写进 wiki/plan。
- `request_truth` inbound-only 的方向已经成为主 contract。
- `runtime_control.stopless` 已被明确为 stopless canonical control。

还没闭环的部分：

- request 主线仍有“旧 inbound context snapshot 在 outbound 被重新贴回”的风险，导致 chat process 后的新真相没有稳定进入最终 provider payload。
- top-level runtime-control mirror 已被标记为 stale residue，后续只允许按残留清理，不再把它描述成活兼容层。
- `serverToolLoopState` / `stopMessageState` 仍是 active runtime mirror，不是死代码。
- `stoplessGoalStatus` 已经是死残留，但文档/goal 引用还没清干净。
- metadata write-boundary gate 虽已起草，但还没证明成为最终硬门。

## 3. 剩余工作分组

### A. P0: 锁死“同一个 request 只有一个 MetadataCenter”

完成标准：

- request 入口创建唯一 center。
- 后续阶段只能补 family 字段，不能创建第二个 center 再 merge。
- outbound 构建必须消费 chat process 后的当前 request truth/context truth，不得重新贴回旧 inbound snapshot。

主要证据文件：

- [sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs)
- [sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_outbound_format_build.rs](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_outbound_format_build.rs)
- [sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/responses_openai_codec.rs](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/responses_openai_codec.rs)
- [tests/sharedmodule/hub-pipeline-rust-responses-provider-payload.regression.spec.ts](/Users/fanzhang/Documents/github/routecodex/tests/sharedmodule/hub-pipeline-rust-responses-provider-payload.regression.spec.ts)

当前状态：

- 未完成。
- 这不是文档 gap，而是当前实现闭环 gap。

### B. P0: 先恢复 Rust owner，再继续 release 级验证

完成标准：

- `servertool_core::stop_message_auto_handler` 作为真实 Rust owner 模块存在。
- release native build 可通过。
- 不能再依赖损坏文件、占位文件或假删除状态。

主要证据文件：

- [sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/lib.rs)
- [sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_message_auto_handler.rs](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_message_auto_handler.rs)
- [sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs)

当前状态：

- 未完成前，release 黑盒验证不可信。

### C. P1: 迁走 top-level runtime-control mirror reader

目标字段：

- `metadata.stopMessageEnabled`
- `metadata.stopMessageExcludeDirect`
- `routecodexPortStopMessageEnabled`

完成标准：

- Rust reader 只读 `MetadataCenter.runtime_control`。
- TS/host 不再把 top-level mirror 当真源。
- 删除 request-stage / handler-stage top-level projection 壳。

当前仍在读 top-level mirror 的关键实现：

- [sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs)
- [sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/stopless_decision_context_signals.rs](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/stopless_decision_context_signals.rs)
- [sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs)

当前仍在投影 top-level mirror 的关键实现：

- [src/server/runtime/http-server/executor-metadata.ts](/Users/fanzhang/Documents/github/routecodex/src/server/runtime/http-server/executor-metadata.ts)
- [src/server/handlers/handler-utils.ts](/Users/fanzhang/Documents/github/routecodex/src/server/handlers/handler-utils.ts)
- [sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts)

当前状态：

- 当前代码面仍有少量读侧残留，但 top-level `metadata.stopMessageEnabled` / `metadata.stopMessageExcludeDirect` / `routecodexPortStopMessageEnabled` 已不再是 owner truth；文档不再把它们描述成“过渡兼容层”。

### D. P1: 区分 active runtime mirror 和 dead residue，避免误删

#### 可继续清理的死残留

- `stoplessGoalStatus`

当前判断：

- 代码运行面已死。
- 现存主要是旧文档/旧 goal 残留。

继续动作：

- 继续清旧 plan/goal/wiki 中把它当 active field 的表述。
- 最终 gate 中禁止其复活为 runtime field。

#### 不能直接删的 active runtime mirror

- `serverToolLoopState`
- `stopMessageState`

当前判断：

- 仍被 Rust servertool-core contract 直接消费。
- 当前不能宣称“已经迁进 MetadataCenter canonical slot”。
- 删除前必须先做 owner 迁移或 contract closeout。

主要证据文件：

- [sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/loop_state_contract.rs](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/loop_state_contract.rs)
- [sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/persisted_lookup.rs](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/persisted_lookup.rs)
- [sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_orchestration_contract.rs](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_orchestration_contract.rs)
- [tests/server/runtime/http-server/metadata-center/metadata-center-dualwrite.spec.ts](/Users/fanzhang/Documents/github/routecodex/tests/server/runtime/http-server/metadata-center/metadata-center-dualwrite.spec.ts)

### E. P1: 把 metadata write-boundary 变成硬 gate

完成标准：

- gate 直接拦住 family 越权写入。
- gate 直接拦住第二个 center merge。
- gate 直接拦住 top-level residue / `__rt` 重新成为真源。

关键脚本：

- [scripts/architecture/verify-architecture-metadata-center-write-boundaries.mjs](/Users/fanzhang/Documents/github/routecodex/scripts/architecture/verify-architecture-metadata-center-write-boundaries.mjs)
- [scripts/architecture/verify-architecture-metadata-center-manifest-code-sync.mjs](/Users/fanzhang/Documents/github/routecodex/scripts/architecture/verify-architecture-metadata-center-manifest-code-sync.mjs)
- [package.json](/Users/fanzhang/Documents/github/routecodex/package.json)

当前状态：

- 骨架已出现，但还没有形成“通过 gate 才能合入”的完成证据。

## 4. 执行顺序

1. 恢复 `stop_message_auto_handler` Rust owner，保证 release native build 可跑。
2. 修 request chatprocess -> outbound 的 context truth 传递，先让 provider payload 回归转绿。
3. 跑 focused regression，证明单 request center + 当前 context truth 已经真正到达 provider payload。
4. 迁 Rust reader，不再读 top-level `stopMessage*` / `routecodexPortStopMessageEnabled`。
5. 删除 TS/host/request-stage 的 top-level projection 壳。
6. 继续清 `stoplessGoalStatus` 残留文档。
7. 把 write-boundary gate 挂进验证面并跑绿。
8. 最后再决定 `serverToolLoopState` / `stopMessageState` 是迁入 center 还是作为 runtime mirror 保留到下一阶段 closeout。

## 5. 本清单不允许的错误动作

- 不能因为 `stoplessGoalStatus` 已死，就误删 `serverToolLoopState` / `stopMessageState`。
- 不能因为 center contract 已写文档，就宣称 request 主线已经闭环。
- 不能在 Rust reader 还读 top-level mirror 时先删 host projection。
- 不能用 SSE/handler/outbound 的补丁修复 request truth 丢失问题。
- 不能把 continuation context 重新升级成 request truth。

## 6. 验证面

contract / gate：

- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-metadata-center-manifest-code-sync`
- `npm run verify:architecture-metadata-center-write-boundaries`

focused runtime / regression：

- `cargo build -p router-hotpath-napi --release`
- `cargo test -p servertool-core stopless --lib -- --nocapture`
- `cargo test -p servertool-core cli_contract --lib -- --nocapture`
- `cargo test -p servertool-core persisted_lookup --lib -- --nocapture`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/hub-pipeline-rust-responses-provider-payload.regression.spec.ts --runInBand`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/server/http-server/executor-metadata.spec.ts tests/server/handlers/handler-utils.metadata.spec.ts tests/server/handlers/handler-metadata-boundary.spec.ts tests/sharedmodule/hub-pipeline-preselected-route.spec.ts tests/sharedmodule/hub-pipeline-rust-responses-provider-payload.regression.spec.ts --runInBand`
