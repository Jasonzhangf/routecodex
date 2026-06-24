# Stopless reasoning.stop schema closure plan

## 目标与验收标准

目标：把 stopless schema 闭环收口到 Rust，确保客户端到模型端的 `reasoning.stop` 工具闭环可验证、可计数、可终止。

验收标准：
- 请求侧工具列表每次注入 `reasoning.stop`，包含 schema 要求、字段说明和可复制样本。
- `finish_reason=stop` 无条件转为 `reasoning.stop` 工具调用；有 schema 传 schema 参数，无 schema 传空参数。
- `reasoning.stop` 正确 schema 才拦截为最终 `finish_reason=stop`，提取 text/reasoning 并以 Markdown 返回客户端。
- `reasoning.stop` 空参数、缺 schema、错 schema 都返回结构化错误报告，包含缺失字段、错误字段、修复样本。
- 连续 3 次 `finish_reason=stop` 或 `reasoning.stop` 非法/空参数，终止循环，最终返回 `finish_reason=stop` 和结构化文本报告。

## 范围与边界

In scope：
- Rust 真源：`stop-message-core`、`servertool-core`、`servertool-cli`、`router-hotpath-napi` 相关 Rust 流程。
- 工具列表注入、schema 校验、非法参数反馈、三连终止、最终客户端投影。
- 黑盒测试：客户端请求、模型响应模拟、servertool 编排、最终客户端输出。

Out of scope：
- 新增 TS 语义实现。
- provider-specific 特例。
- fallback、降级、双路径兼容。
- 改无关 direct passthrough、provider runtime、Virtual Router 路由策略。

## 设计原则

- Rust-only：stopless 和 servertool 语义必须在 Rust；TS 只保留最薄调用壳层。
- metadata center only：全流程只读写 metadata center 暴露的运行时控制语义，不依赖散落内部字段。
- Pipeline 边界：请求、响应、错误链保持相邻节点转换，不跨阶段修 payload。
- 红测先行：先写能证明当前失败的黑盒测试，再改唯一真源。
- 无 fallback：错误必须显式返回 schema 报告或终止报告。

## 技术方案

关键文件：
- `sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/src/lib.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-cli/tests/cli_blackbox.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/tests/stop_schema_gate_closure.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/servertool_injection.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`

Implementation outline：
- 保留并修绿 `stop-message-core` schema gate：完整 schema allow-stop；缺 schema、错 schema followup；三连 fail-fast。
- `servertool-cli` 输出恢复 `modelGuidance`、`schemaFeedback`、`schemaGuidance`，三连非法返回 budget exhausted。
- 在 Rust 工具治理层注入 `reasoning.stop` 工具 schema；schema 描述中包含字段类型、枚举值和样本。
- 响应侧拦截 `reasoning.stop` tool call：正确参数转最终 stop；空/错参数返回错误报告；三连终止。
- 清理旧 TS stopless/servertool 语义，保留调用壳层。

## 风险与规避

风险：
- 旧 `cli_contract.rs` 存在未收口改动，可能破坏已有 CLI 契约。
- `finish_reason=stop -> tool_call` 若投影位置错误，可能造成客户端看到非法 tool_calls。
- 三连计数若只靠当前请求字段，跨轮不会增长。

规避：
- 先跑 `servertool-cli` 全量测试锁旧契约。
- 黑盒测试必须验证最终客户端 payload，而不只验证纯函数。
- 计数状态必须通过 Rust 输出和下一轮输入可追踪字段闭环；不能靠 TS 临时状态。

## 测试计划

正向测试：
- 完整 `reasoning.stop` schema：`stopreason=0/1` 返回最终 stop。
- `stopreason=2 + next_step` 返回继续执行。
- `needs_user_input=true + next_step` 返回最终 stop，等待用户输入。

反向测试：
- 空参数、无 schema、非数字 stopreason、缺 reason、缺 next_step 均返回 schema 错误报告。
- 连续 3 次无 schema 必须最终 stop。
- 连续 3 次错 schema 必须最终 stop。
- 正常工具调用和非 stop 响应不应误判 terminal。

验证命令：
- `cd sharedmodule/llmswitch-core/rust-core && cargo test --package stop-message-core`
- `cd sharedmodule/llmswitch-core/rust-core && cargo test --package servertool-cli`
- `cd sharedmodule/llmswitch-core/rust-core && cargo test --package router-hotpath-napi`
- 项目 TS 定向黑盒测试：`pnpm jest tests/servertool/stopless-cli-continuation.spec.ts tests/servertool/stop-schema-lifecycle-contract.spec.ts`
- 在线验证：重启 RouteCodex 后，用 5555 真实请求重放无 schema、错 schema、正确 schema 三类样本。

## 实施步骤

1. 固化当前红测：Rust core schema gate、servertool CLI 黑盒、Hub Pipeline 工具注入黑盒、最终客户端输出黑盒。
2. 修绿 `stop-message-core`，保证 schema gate 基础语义正确。
3. 修绿 `servertool-core/servertool-cli`，恢复 model guidance、schema feedback、三连终止。
4. 实现 Rust 工具列表注入 `reasoning.stop`。
5. 实现 Rust 响应侧 `reasoning.stop` 拦截和最终 stop 投影。
6. 清理 TS 重复语义，只留 Rust 调用壳层。
7. 跑定向测试、全 Rust 相关测试、在线 5555 重放验证。
8. 记录验证证据到 `note.md`，必要时提炼到 `MEMORY.md`。

## 完成定义

- 红测先红后绿证据存在。
- Rust 定向测试和 servertool CLI 黑盒全绿。
- 在线 5555 能证明：正确 schema 闭环、无 schema 三连终止、错 schema 三连终止。
- 无 TS stopless/servertool 业务语义残留。
- 未验证项和剩余风险明确记录。

## 2026-06-20 servertool skeleton audit addendum

### 审计结论

- Rust 核心闭环已存在并已验证：
  - `stop-message-core` schema gate white-box 通过。
  - `servertool-cli` blackbox 通过。
  - `router-hotpath-napi` 的 stopless 工具注入 / Hub Pipeline focused Rust tests 通过。
  - `responses-handler.servertool-cli-projection.blackbox.spec.ts` 在 native `.node` 重编后通过，证明 stopless schemaFeedback / allow-stop Markdown 当前闭环可工作。
- 但 servertool 还不是全 Rust：
  - `sharedmodule/llmswitch-core/src/servertool/engine.ts`
  - `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts`
  - `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`
  以上仍是 active mainline orchestration，不是纯 IO shell。
- 全流程黑盒仍不完整：
  - 当前黑盒覆盖到 client projection / handler / submit restore。
  - 还缺 “client inbound -> provider outbound wire -> provider inbound -> client outbound” 双端口全链黑盒门禁。
- 死代码结论：
  - `servertool-core/src` 未见 `.bak` 残留。
  - 当前更大问题不是 archive 文件，而是 TS 活语义仍在主线。

### 验证补充

- 已通过：
  - `cargo test -p stop-message-core --test stop_schema_gate_closure -- --nocapture`
  - `cargo test -p servertool-cli --test cli_blackbox -- --nocapture`
  - `cargo test -p router-hotpath-napi req_process_stage1_tool_governance_tests --lib -- --nocapture`
  - `cargo test -p router-hotpath-napi hub_pipeline_lib::tests --lib -- --nocapture`
  - `cargo test -p router-hotpath-napi servertool_core_blocks --lib -- --nocapture`
  - `npm run build:min`
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts --runInBand --no-cache`
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/stopless-cli-continuation.spec.ts tests/servertool/servertool-cli-projection.spec.ts --runInBand --no-cache`

### 修复计划

1. Rust-only 主链收口
- 把 `engine.ts`、`server-side-tools.ts`、`handlers/stop-message-auto.ts` 的 active orchestration 继续下沉到 Rust。
- TS 只允许保留 native loader、JSON 编解码、外部 IO、日志桥。
- 每迁完一个 slice，物理删除对应 TS 语义分支，禁止闲置保留。

2. 双端口全链黑盒
- 新增 servertool e2e blackbox：
  - client inbound 入口：`/v1/responses` 或等价 client 端口。
  - provider outbound 入口/出口：mock provider 端口，抓实际 wire payload。
  - provider inbound 回包后，再断言 client final payload。
- 锁三类样本：
  - no schema -> 1/2/3 连续闭环
  - wrong schema -> 1/2/3 连续闭环
  - valid terminal schema -> 直接 allow-stop Markdown

3. owner/map/gate 同步
- 更新 `function-map.yml` / `verification-map.yml` / `mainline-call-map.yml`：
  - 把仍在 TS 的 active orchestration 明确标记为未完成 closeout。
  - 为新 e2e blackbox 增加 required tests / required gates。
- 强化 `verify:servertool-rust-only`：
  - 不只检查 native export。
  - 还要扫 active TS orchestration symbol / policy branch / handler business logic。

4. 死语义物理删除
- 等对应 Rust slice 完成后，删除：
  - TS 侧 stopless/servertool 业务判定
  - 历史 stop_message_auto 投影补偿
  - 不再需要的 local helper / transitional branch
- 删除动作必须绑定红测和全链黑盒一起提交。

## 2026-06-20 servertool skeleton audit addendum 2

### 追加审计结论

- 当前 `servertool` 不能宣称“骨架完整”：
  - Rust 白盒和局部黑盒已经证明 stopless schema 闭环 slice 可工作；
  - 但主链运行时仍由 TS 编排驱动，文档 owner 与 runtime reality 不一致。
- 具体证据：
  - `sharedmodule/llmswitch-core/src/servertool/engine.ts` 仍是 stopless/servertool 的 orchestration caller。
  - `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts` 仍拥有 tool dispatch loop、auto hook queue、mixed-tools outcome。
  - `sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts` 仍拥有 runtime gating / followup bypass 判定。
  - `docs/architecture/mainline-call-map.yml` 的 `stopless.session.mainline` 前半段仍绑定 TS edge，而不是纯 Rust edge。
- 当前门禁也不能宣称充分：
  - `scripts/verify-servertool-rust-only.mjs` 尚未把“双端口 client->provider->client 全链黑盒”纳入 required verification。
  - 也未对 `engine.ts` / `server-side-tools.ts` / `execution-shell.ts` 中的活跃 orchestration 符号建立 fail gate。

### 骨架缺口分级

#### P0

1. TS active orchestration 仍在主链
- 位置：
  - `sharedmodule/llmswitch-core/src/servertool/engine.ts`
  - `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts`
  - `sharedmodule/llmswitch-core/src/servertool/execution-shell.ts`
  - `sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts`
- 影响：
  - 无法满足“servertool/stopless 必须 Rust-only”。
  - 现有 function map / mainline map 只能算迁移中，不是 closeout。

2. 缺少双端口全流程黑盒门禁
- 现有可复用骨架：
  - `tests/server/handlers/responses-handler.provider-outbound-reasoning.blackbox.spec.ts`
  - `tests/server/handlers/handler-request-executor.unified-semantics.e2e.spec.ts`
- 缺失内容：
  - stopless/servertool 还没有一条测试同时断言：
    - client inbound request
    - provider outbound wire payload
    - provider inbound result
    - client final payload

#### P1

3. verify gate 仍偏“局部审计”
- `verify:servertool-rust-only` 主要验证 native export / deleted files / shadow audit。
- 还需要加入：
  - active TS orchestration symbol scan
  - 双端口 e2e blackbox required gate
  - `function-map` / `verification-map` 与双端口黑盒映射一致性检查

4. 文档真源与代码真源未完全对齐
- `function-map.yml` / `verification-map.yml` / `mainline-call-map.yml` 目前已承认 Rust owner，但仍允许 TS 关键调用边存在。
- Closeout 前必须把 TS edge 物理替换为 Rust edge，或显式改回“迁移中”状态，不能继续混写。

### 修复顺序

1. 先补红测
- 在 `tests/server/handlers/handler-request-executor.unified-semantics.e2e.spec.ts` 增加 stopless/servertool 双端口全链黑盒。
- 在 `tests/server/handlers/responses-handler.provider-outbound-reasoning.blackbox.spec.ts` 增加 provider-out stopless contract 黑盒。
- 用例至少覆盖：
  - no schema -> 第 1/2 轮 corrective guidance，第 3 轮 terminal stop report
  - invalid schema -> 第 1/2 轮 corrective guidance，第 3 轮 terminal stop report
  - valid terminal schema -> final stop markdown / text 提取

2. 再迁 Rust owner
- 先把 `response-stage-orchestration-shell.ts` 的 runtime gating 迁入 Rust。
- 再迁 `engine.ts` 的 stopless orchestration / pending injection / timeout policy。
- 再迁 `server-side-tools.ts` 与 `execution-shell.ts` 的 dispatch/execution outcome。
- 每迁一个 slice，同步删掉对应 TS 分支。

3. 最后补 gate + 文档
- `verify:servertool-rust-only` 加 active orchestration fail gate。
- `verification-map.yml` 把双端口 e2e 列为 `hub.servertool_cli_projection` 与 `hub.servertool_stopless_cli_continuation` 的 required integration gate。
- `mainline-call-map.yml` 把 stopless 前半段 TS edge 换成 Rust edge；做不到就不能宣称 Rust-only closeout。

### 本轮可交付定义

- 这轮审计可交付的是“问题边界 + 修复计划 + 可复用测试骨架”。
- 不是 closeout；当前还不能宣称：
  - servertool 已全 Rust
  - servertool skeleton 已完整
  - stopless/servertool 已具备双端口全链黑盒门禁
