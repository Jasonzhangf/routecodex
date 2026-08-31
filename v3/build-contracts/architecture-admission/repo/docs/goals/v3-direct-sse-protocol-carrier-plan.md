# V3 Direct SSE Protocol Carrier 修复计划

## 1. 目标与验收标准

修复 Direct SSE typed consumer 对 provider protocol 的硬编码和响应 JSON shape 猜协议问题。

验收标准：

- Direct SSE consumer 只消费已经由 `V3DirectResponseCompatPlan.provider_protocol` 确定的 provider protocol。
- Responses、OpenAI Chat、Anthropic、Gemini 不再通过响应 JSON shape 选择 semantic codec。
- Direct typed hook 的 Responses/Chat 分支由 typed protocol carrier 驱动；Anthropic/Gemini 在当前 hook catalog 未注册 semantic tree 时保持明确的协议分支，不猜测、不伪造。
- 没有 provider protocol 时，涉及 semantic object 的 Direct SSE consumer 明确报错，不默认成 Responses。
- provider raw SSE 不进入客户端旁路；错误仍由既有 Error01/Error05 链处理。
- 语法兼容范围不扩张，不新增 fallback、silent strip、请求侧 cleanup 或 server/outbound 补偿。

## 2. 范围与边界

### In scope

- `V3DirectSseContentConsumer` 的 provider protocol carrier。
- Direct SSE stream helper 到 consumer 的 protocol 传递。
- Direct typed projection 的 protocol-driven dispatch。
- Responses/Chat/Anthropic/非 object 的正反向单元测试。

### Out of scope

- Front SSE skeleton、keepalive、Direct/Relay execution plan 选择。
- provider health、retry、cooldown、Error05 policy。
- `routecodex-v3-sse` transport framing implementation。
- provider wire request 构造、客户端出口格式、continuation、Gemini semantic tree 新增。

## 3. 设计原则

1. 协议真源是请求阶段已完成的 `V3DirectResponseCompatPlan.provider_protocol`，不是响应对象的 `type`、`object` 或 `choices`。
2. Direct consumer 只做当前 provider protocol 对应的 semantic hook；不做跨协议 shape reclassification。
3. 传输层继续保持 opaque；provider SSE codec 继续拥有 provider semantic classification；Front/server 不接管业务解析。
4. 缺失 protocol 是内部响应阶段错误，必须显式失败，不能默认 Responses。
5. 保留已登记的语法恢复；不添加语义恢复或 fallback。

## 4. 技术方案与文件清单

### 唯一 owner

- `v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_consumers.rs`
  - 增加 typed provider protocol carrier。
  - 删除固定 `V3HubProviderWireProtocol::Responses`。
  - 将 shape-based Chat/Responses 分支改成 protocol match。
- `v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs`
  - 将 provider protocol 从调用侧传入 `V3DirectSseContentConsumer`。
- `v3/crates/routecodex-v3-runtime/src/kernel.rs`
  - 从 `response_projection.compat_plan.provider_protocol` 传递 protocol。

### 不修改

- `v3/crates/routecodex-v3-server/**`
- `v3/crates/routecodex-v3-sse/**`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/provider_sse_json_codec.rs`

## 5. 风险与规避

- 风险：测试直接构造 consumer 而未提供 protocol。规避：测试显式绑定对应 protocol；无 protocol 的 semantic object 增加反向测试，必须失败。
- 风险：Anthropic/Gemini 被误送入 Responses/Chat tree。规避：使用显式 `match provider_protocol`，未注册 semantic tree 的协议只保持原对象，不猜测转换。
- 风险：继续保留隐藏 shape 分支。规避：静态扫描 Direct consumer owner，禁止在 projection 函数内通过 `object`、`type`、`choices` 决定协议。
- 风险：误改 Direct/Relay 选择。规避：只从现有 `compat_plan.provider_protocol` 读取，不修改 execution plan 和 server handler。

## 6. 验证矩阵

### 正向

- Direct Responses event 进入 Responses typed hook。
- Direct OpenAI Chat chunk 进入 Chat typed hook。
- Direct Anthropic tool event 不进入 Responses/Chat classifier。
- 传入 selected protocol 后，普通 object 保持语义和 framing。

### 反向

- Direct consumer 缺失 protocol 的 semantic object 明确报错。
- Responses protocol 的 Chat shape 不被 shape 猜测为 Chat；进入 Responses codec 并显式失败。
- OpenAI Chat protocol 的 Responses shape 不被 shape 猜测为 Responses；进入 Chat codec 并显式失败。
- provider protocol 不匹配时不生成 client frame，不静默成功。

### 必跑命令

- `cargo fmt --manifest-path v3/Cargo.toml --all -- --check`
- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime --lib direct_sse_consumers -- --nocapture`
- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime --lib provider_sse -- --nocapture`
- `npm run verify:sse-architecture-boundary`
- `npm run verify:v3-resource-map`
- `git diff --check`

完整 workspace/build/install/restart/live replay 只有在当前 main 的既有 compile blocker 清除后才执行；不得用旧 binary 或普通 smoke 代替。

## 7. 实施步骤

1. 在 Direct consumer 加入 protocol carrier，并核对所有构造点。
2. 从 `response_projection.compat_plan.provider_protocol` 传入 stream helper。
3. 删除固定 Responses 和 JSON shape protocol dispatch。
4. 添加正反向 protocol routing 测试。
5. 运行 formatter、定向 tests、SSE/resource gates 和 diff check。
6. 在独立 worktree 生成 evidence/handoff；不在本任务中改 Front 或 provider health。

## 8. 完成定义（DoD）

- Direct SSE typed consumer 中不存在默认 Responses protocol。
- Direct typed projection 不再通过响应 JSON shape 决定协议。
- 正反向测试证明 protocol carrier 生效且错配显式失败。
- 影响范围只在登记的 runtime Direct SSE owner 内。
- 所有可运行 gate 有真实结果；受 dirty baseline 阻塞的 gate 明确列出，不得宣称在线完成。
