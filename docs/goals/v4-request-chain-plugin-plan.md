# V4 请求链插件实现计划

## 目标与验收标准

完成 V4 请求链的三个大节点插件，按固定顺序：

```text
SSE In (Node 02) -> Responses Inbound (Node 03) -> ChatProcess (Node 04)
```

- **Node 02 SSE In**：`V4ServerSseIn02FrameBoundary` — 已完成
- **Node 03 Responses Inbound**：`V4HubReqInbound03Normalized` — 已完成
- **Node 04 ChatProcess**：`V4HubReqChatProcess04Governed` — 待实现

本 worker 只负责请求链，不做响应链。

完成标准：
- 三个节点插件均绑定准确 `node_id`、`role_id`、`position`
- 只做相邻请求节点转换
- control/error/debug/snapshot/metadata 不进入 request payload
- SSE In 只做 frame -> JSON，不检查 model
- Responses Inbound 只做协议 normalize，不检查 model
- ChatProcess 做请求侧工具治理（VR 负责 entry model routing 和 provider model replacement）
- malformed input、非 object payload、控制面泄漏均 fail-fast

## 范围与边界

### In scope

- `v4/crates/routecodex-v4-standard-plugins/src/protocol/` 中的请求链插件实现
- 对应 V4 contracts、插件 catalog/plan 测试和架构 gate 的最小同步
- plan_hash 一致性修复（阻塞项）
- Cordis plugin + CLI 测试
- Standard plugin + cargo tests

### Out of scope

- 响应链（全部节点）
- VR 路由插件
- provider runtime
- 真实运行时 kernel 重写
- 全局安装 / live 5520 / DSH review

## 实施步骤

### Step 1：修复 plan_hash（阻塞项）

问题：`contracts/skeleton-plan.contract.json` 的 `plan_hash` 与 Rust 真源不一致，导致 runtime tests 大量失败。

操作：
1. 在 `v4/crates/routecodex-v4-skeleton/` 内写临时 Rust test 输出真实 hash
2. 用 `apply_patch` 更新 contract 文件的 `plan_hash`
3. 重跑 `cargo test -p routecodex-v4-skeleton` 确认

### Step 2：修 unsupported item 错误文案

问题：`normalize_responses_request_rejects_invalid_input_without_fallback` 断言失败

操作：
1. 读取 `v4/crates/routecodex-v4-runtime/src/lib.rs` 中的 unsupported item 错误
2. 改 error 文案包含 `"Responses request"` 前缀
3. 用 `apply_patch` 更新
4. 重跑该测试确认通过

### Step 3：跑通全部 gated tests

```bash
cargo test -p routecodex-v4-skeleton --locked
cargo test -p routecodex-v4-runtime --test l2_runtime --locked
cargo test -p routecodex-v4-standard-plugins --locked
node --test cordis/routecodex-v4-cordis-plugins/tests/cli.test.mjs
node scripts/architecture/verify-v4-standard-plugins.mjs
git diff --check
```

### Step 4：实现 ChatProcess 节点（Node 04）

在 `v4/crates/routecodex-v4-standard-plugins/src/chat_process.rs` 实现：
- descriptor：`V4HubReqChatProcess04Governed`
- 角色：request-side tool governance
- 不做 model admission / routing（VR 负责）
- 不做 response 处理

### Step 5：更新架构 map

同步更新：
- `v4/docs/architecture/v4-resource-operation-map.yml`
- `.appsdk/maps/function-map.json`
- `.appsdk/maps/verification-map.json`
- `v4/contracts/skeleton-plan.contract.json`（如需新增节点）
- `contracts/active-link/frozen-consumer-registry.json`

### Step 6：全量验证

```bash
cargo test -p routecodex-v4-skeleton --locked
cargo test -p routecodex-v4-runtime --test l2_runtime --locked
cargo test -p routecodex-v4-standard-plugins --locked
node --test cordis/routecodex-v4-cordis-plugins/tests/cli.test.mjs
node scripts/architecture/verify-v4-standard-plugins.mjs
git diff --check
```

## 完成定义（DoD）

- plan_hash 一致，runtime tests 全绿
- unsupported item 错误文案已修，对应测试通过
- Node 02 / Node 03 / Node 04 三个请求链插件均通过
- 架构 gate / AppSDK / frozen-registry 无 missing edge
- Cordis CLI tests 12 passed
- git diff --check 通过
- 无未声明 fallback、旁路、payload 控制语义泄漏
