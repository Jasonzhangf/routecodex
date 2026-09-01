# V4 Response Data-Plane Plugin Plan

## 目标与验收标准

合并 Worker A 和 Worker B 的已有数据面插件（inbound/outbound + response_governance + tool_harvest），确保 21 个标准插件 descriptor 全部正确绑定 node_id / role_id / position，不越界写入 `v4.scope.session` 或 `routecodex-v4-runtime`。测试、数据面 L2 通过，架构 gate 全绿。

## 现状（合并起点）

Worker B 已实现：
- `v4.std.chat_process.response_governance` — typed handle，reject control-state keys in normal_payload
- `v4.std.chat_process.tool_harvest` — validates tool_calls/tool_outputs, rejects duplicates
- `v4.std.chat_process.continuation_commit` — validates scope/key facts, emits diagnostic facts ONLY
- 41/41 crate tests PASS, 9/9 L2 tests PASS

Worker A 已实现：
- `response_inbound.rs` — protocol_decode: provider_raw → normal_payload, reads v4.response.provider_raw
- `response_outbound.rs` — client_semantic_projection + frame_build: normal_payload → client_wire_payload

两者冲突文件：
- `lib.rs` — Worker B adds `pub mod chat_process`, Worker A adds `pub mod response_inbound/outbound`（非重叠）
- `verify-v4-standard-plugins.mjs` — NODE_PERMISSIONS 有冲突（见 handoff）

## 合同修复（阻塞）

### 合同不一致：`continuation_commit` 的 role_id

当前 `skeleton-plan.contract.json` 把 `continuation_commit` 放在 `V4HubRespChatProcess03Governed` 的 `response_chat_process` role 下，但 `node-graph.contract.json` 声明 continuation 的 role 为 `response_continuation`。

**决策**：保持 `continuation_commit` 在 `V4HubRespChatProcess03Governed` group 内作为私有 operator（group 内部子节点），不提升为独立 `V4ChatProcess03ContinuationCommit` 节点。理由：continuation save 只发生在 chat process 出口，且 node-graph contract 的 `response_continuation` role 子类已在 registered nodes 里有 `V4ChatProcess03ContinuationCommit` 和 `V4RespContinuationCommitted`，但这两个节点的 owner 是 `routecodex-v4-runtime::ContinuationCommit`，不是 `routecodex-v4-standard-plugins`。标准插件层的 `continuation_commit` 是"触发 signal"而非"真实 save"——真实 save 由 Worker B 在 control plane 层完成。

**操作**：标准插件 `continuation_commit` descriptor 保留在 `response_chat_process` role；role 不对齐在本次 Worker A 范围外，由 Worker B 处理。

## 合并步骤

1. **合并 lib.rs**：保留 Worker B 的 `pub mod chat_process` 和三个 chat_process plugin descriptors；追加 Worker A 的 `pub mod response_inbound` 和 `pub mod response_outbound`；追加 Worker A 的 `response_inbound_handles()`、`response_outbound_handles()` 到 handle 集合。合并后标准库 plugin 数量 = 21。

2. **合并 verify 脚本 NODE_PERMISSIONS**：采用 Worker A 的权限集作为权威（Worker B 错误地把 V4HubRespInbound02Parsed 的读写权限归零了）。最终权限：
   - `V4HubRespInbound02Parsed` reads=`v4.response.provider_raw`, writes=`v4.response.normal_payload`
   - `V4HubRespChatProcess03Governed` reads=`v4.response.normal_payload`, writes=`v4.response.normal_payload`
   - `V4HubRespOutbound04ClientSemantic` reads=`v4.response.normal_payload`, writes=`v4.response.normal_payload`
   - `V4ServerRespOutbound06ClientFrame` reads=`v4.response.normal_payload`, writes=`v4.response.client_wire_payload`

3. **合并文档**：标准插件库文档更新到 21 plugin ids。

4. **合并测试**：保留 Worker B 的 `l2_response_chat_process_plugins.rs` 和 Worker A 的 `l2_response_inbound_outbound.rs`，在合并后 worktree 跑 `cargo test -p routecodex-v4-standard-plugins --locked`。

5. **跑 gate**：
   - `cargo test -p routecodex-v4-standard-plugins --manifest-path v4/Cargo.toml --locked`
   - `cargo test -p routecodex-v4-standard-plugins --manifest-path v4/Cargo.toml --locked --test l2_response_chat_process_plugins`
   - `cargo test -p routecodex-v4-standard-plugins --manifest-path v4/Cargo.toml --locked --test l2_response_inbound_outbound`
   - `node v4/scripts/architecture/verify-v4-standard-plugins.mjs`
   - `node v4/scripts/architecture/verify-v4-standard-plugins.mjs --red-self-test`
   - `node v4/scripts/architecture/verify-v4-semantic-parity.mjs`
   - `node v4/scripts/architecture/verify-v4-plane-isolation.mjs`
   - `node v4/scripts/architecture/verify-v4-skeleton-topology.mjs`
   - `node v4/scripts/architecture/verify-v4-node-graph.mjs`
   - `node v4/scripts/architecture/verify-v4-resource-binding.mjs`
   - `node v4/scripts/architecture/verify-v4-relay-continuation.mjs`
   - `node v4/scripts/architecture/verify-v4-responses-direct-compat.mjs`
   - `git diff --check`

6. **更新 handoff**：记录 Worker A 合并完成，写入 `handoff/20260818T171800Z-v4-response-data-plane-closeout.json`。

## 范围与边界

### In scope
- 标准插件 lib.rs 合并（data-plane descriptors + handles）
- verify-v4-standard-plugins.mjs NODE_PERMISSIONS 合并
- 文档更新
- L2 测试合并运行
- 所有架构 gate

### Out of scope（由 Worker B 处理）
- `v4.scope.session` 的真实写入（ScopeRegistry::bind/release）
- cordis-bridge 的 typed continuation control slot
- continuation_commit / continuation_release 的真实 control-plane 接线
- runtime 的 declared writer 接入
- `response_continuation` role 节点图的合同修复

## 完成标准

- 21 个标准插件 descriptor 全部在 lib.rs 中注册
- 合并后 41+ crate tests PASS
- L2 response_chat_process_plugins 9/9 PASS
- L2 response_inbound_outbound 8/8 PASS
- 所有 12 个架构 gate PASS
- git diff --check 通过
- 无 forbidden path 越界
- 无 continuation truth 写入 normal_payload（合同锁定）
