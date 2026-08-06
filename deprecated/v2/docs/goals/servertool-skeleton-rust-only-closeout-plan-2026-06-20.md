# Servertool Skeleton Rust-Only Closeout Plan (2026-06-20)

> Status note (2026-06-22): this file remains as the earlier audit baseline. The current execution baseline has moved to `docs/goals/servertool-hook-skeleton-rust-only-closeout-plan-2026-06-22.md`.

## Scope

审计对象限定为 `servertool / stopless` 主链骨架，目标是判断：

1. 是否已经做到 Rust-only
2. 黑盒 / 白盒 / 全流程黑盒是否完整
3. 是否仍有死代码、重复 owner、或 TS 活语义残留
4. 接下来应该按什么顺序修

本计划只基于当前仓库证据，不宣称 closeout 完成。

## Current Verdict

当前 `servertool` 不是 Rust-only closeout，仍是：

- Rust semantics / contract / projection blocks
- + TS active orchestration shells

stopless 行为闭环层面已经有关键进展，但“骨架完整且全 Rust”这件事还没有完成。

## Target Correction (2026-06-21)

目标不是把业务执行流从 CLI 改成 server-side hook。业务执行流仍然是 client-visible CLI：

```text
servertool response decision
  -> client-visible exec_command
  -> client runs: routecodex hook run <toolName> --input-json <json>
  -> client returns ordinary tool result
  -> next request restores CLI stdout/tool result
```

hook 的职责是治理“如何修改流程”：

- 响应端标准骨架必须覆盖响应拦截、schema 校验、hook 注入响应；其中拦截/finalize 必选，schema-managed flow 的 schema 校验必选，hook response 注入按需要必选。
- 请求端标准骨架必须覆盖结果解析、必要文本替换、工具注入；其中有 tool result 时结果解析必选，servertool-managed turn 的工具注入必选，文本替换按条件可选。
- followup/reenter 只能由 Rust-owned hook 产出 effect plan，TS 只执行 IO。
- 多个处理点并存时，hook skeleton 必须支持 multi-hook stable scheduling。
- 每个 hook 必须声明 required/optional；required 缺失或输出非法必须 fail-fast，optional 跳过必须产出 no-op event，禁止 fallback 到另一条业务路径。

因此 closeout 标准应从“把 outcome/followup 分支逐个 Rust 化”升级为“CLI lifecycle 保持不变，但注入/恢复/拦截/followup/reenter/finalize 全部 hook-governed”。

## Evidence

### 1. TS active orchestration owners still exist

#### `engine.ts` 仍持有 stopless orchestration 主链

证据：

- `runServerToolOrchestration` 仍直接调用 `runServerSideToolEngine`
  文件：`sharedmodule/llmswitch-core/src/servertool/engine.ts:5`
- 仍负责 stop gateway / timeout / followup mainline / CLI projection 调度
  文件：`sharedmodule/llmswitch-core/src/servertool/engine.ts:7-28`
- 仍持有 stopless loop state / session truth / reasoning text 抽取
  文件：`sharedmodule/llmswitch-core/src/servertool/engine.ts:153-260`

结论：这不是纯 IO thin shell。

#### `server-side-tools.ts` 仍持有 response-stage orchestration

证据：

- side-effect import 真 handler：`./handlers/stop-message-auto.js`、`./handlers/vision.js`
  文件：`sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts:13-14`
- 仍负责 tool dispatch、CLI projection 分支、tool execution loop、auto hook queue
  文件：`sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts:143-240`

结论：仍是活主链 owner，不是纯 native result consumer。

#### `execution-shell.ts` 仍持有执行 loop 和 backend dispatch glue

证据：

- 仍持有 `runServertoolHandler` / `materializeServertoolPlannedResult` / `executeServertoolBackendPlan`
  文件：`sharedmodule/llmswitch-core/src/servertool/execution-shell.ts:97-151`
- 仍持有 `buildServertoolDispatchPlanInput` / `buildServertoolOutcomePlanInput` / `resolveToolCallExecutionOutcome`
  文件：`sharedmodule/llmswitch-core/src/servertool/execution-shell.ts:250-360`

结论：虽然 dispatch truth 已部分转到 Rust skeleton config，但执行编排主语义还在 TS。

#### `registry.ts` 仍持有 runtime handler binding truth

证据：

- 仍维护 `SERVER_TOOL_HANDLERS`、`AUTO_SERVER_TOOL_HANDLERS` runtime registry
  文件：`sharedmodule/llmswitch-core/src/servertool/registry.ts:38-40`
- 仍负责 `registerServerToolHandler` / `getServerToolHandler` / `listAutoServerToolHooks`
  文件：`sharedmodule/llmswitch-core/src/servertool/registry.ts:117-237`

结论：当前 registry 只是“更弱化”，不是“已退出主链”。

### 2. 文档与运行时现实仍不一致

#### function map 仍允许 TS 主链存在

证据：

- `hub.servertool_stopless_cli_continuation` 标成 `owner_kind: rust_ssot`
- 但 `allowed_paths` 仍包含：
  - `sharedmodule/llmswitch-core/src/servertool/cli-projection.ts`
  - `sharedmodule/llmswitch-core/src/servertool/engine.ts`

文件：`docs/architecture/function-map.yml:208-272`

结论：文档已经承认 TS 仍在主链，不是纯 Rust closeout。

#### mainline call map 仍有 TS caller/callee

证据：

- `stl-01` `engine.ts -> handlers/stop-message-auto.ts`
- `stl-03` `cli-projection.ts -> cli_contract.rs`
- `stl-06` `responses-openai-bridge.ts -> bridge-message-utils.ts`

文件：`docs/architecture/mainline-call-map.yml:377-452`

结论：stopless mainline 仍是混合态，不是纯 Rust call chain。

### 3. 黑盒 / 白盒现状

#### 已有的强证据

- stopless 黑盒已覆盖：
  - `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`
  - `tests/servertool/stopless-cli-continuation.spec.ts`
  - live probe: `scripts/tests/stopless-5555-live-probe.mjs`

- Rust 白盒已存在：
  - `stop-message-core`
  - `servertool-core`
  - `router-hotpath-napi`

这说明 stopless 行为闭环不是空的。

#### 仍然缺的证据

- `servertool backend-route` 还缺一条“客户端入口 -> provider out -> provider in -> client out”的双端口全链黑盒
- 当前更多是 focused blackbox / orchestration blackbox / dispatch blackbox，不足以证明整个 servertool family 已 closeout

### 4. gate 缺口

#### `verify:servertool-rust-only` 现在还不够硬

证据：

- required verification 只要求：
  - CLI projection
  - backend route runtime focused tests
  - stopless dual-port blackbox

文件：`scripts/verify-servertool-rust-only.mjs:143-163`

问题：

- 它能证明“部分 Rust owner/export/gate 存在”
- 但还不能证明：
  - `engine.ts` 退出主链
  - `server-side-tools.ts` 退出主链
  - `execution-shell.ts` 退出主链
  - `registry.ts` 退出主链

也就是说，这个 gate 当前能绿，但“servertool 已 Rust-only”仍然是假命题。

## Dead Code Audit

这轮没有发现 `.bak` 类 archive 残留重新复活；当前问题不是 archive dead file，而是：

- TS 活语义仍在主链
- 文档与 gate 已部分升级，但还没把这些活 owner 打成 fail

所以“没有死文件”不等于“骨架完整”。

## Required Fix Order

### Phase 1: 先把审计结论变成红 gate

先补 gate，不先大改实现。

目标：

1. 新增 focused red gate，显式锁：
   - `engine.ts`
   - `server-side-tools.ts`
   - `execution-shell.ts`
   - `registry.ts`
   仍不得新增/保留某些编排语义
2. 新增 hook-governed skeleton gate，显式锁请求注入、结果恢复、响应拦截、followup/reenter/finalize 不得由 TS 本地分支 owning
3. gate 必须先红，再修

原因：

- 如果不先锁，后续还会继续出现“gate 绿，但其实没 Rust-only”的假绿
- 如果不先锁 hook contract，后续会继续把 CLI projection、followup、stopless 当成三条各自修补的分支，而不是同一套 hook-governed 注入/拦截机制

### Phase 2: 收 `execution-shell.ts`

下一刀优先级最高。

目标：

- 把以下语义继续上移到 Rust contract / plan：
  - tool call execution outcome planning
  - backend dispatch plan selection
  - auto-hook queue planning

TS 保留：

- handler actual execution
- backend IO call shell

### Phase 3: 收 `server-side-tools.ts`

目标：

- 把 response-stage 的 orchestration 继续压成 native plan consumer
- 清掉 TS 对以下语义的 owner：
  - cliProjectedToolCall 分支判定
  - auto hook queue orchestration
  - payload contract signal + stop eligible route branch

### Phase 4: 再收 `engine.ts`

不要先碰这条。

前提：

- `execution-shell.ts`
- `server-side-tools.ts`

先各收一轮之后，再动 `engine.ts`，否则风险太大且 diff 太散。

### Phase 5: 补 servertool backend-route 双端口黑盒

stopless 双端口黑盒已经有了，但 family 还不完整。

要补：

- client in
- provider out
- provider in
- client out

全链 servertool backend-route 黑盒，参考现有骨架：

- `tests/server/handlers/responses-handler.provider-outbound-reasoning.blackbox.spec.ts`
- `tests/server/handlers/handler-request-executor.unified-semantics.e2e.spec.ts`

### Phase 6: gate 升级为真正的 Rust-only closeout gate

完成条件不是“更多测试绿”，而是同时满足：

1. TS active orchestration gate 绿
2. stopless blackbox + live probe 绿
3. servertool backend-route dual-port full-chain blackbox 绿
4. function-map / mainline-call-map 与运行时 owner 对齐
5. 能物理删除不再需要的 TS 活语义，而不是仅“不调用”

## Routing Truth Checkpoint (2026-06-22)

当前 5520 的 thinking load balancing 真源已经是：

- `fwd.paid.gpt-5.4`
- `fwd.glm.glm-5.2`
- 权重 `1:1`
- `thinking = high`

因此这次不需要再新增一条 thinking 路由，只需要把相关测试断言、goal prompt 和后续执行计划写成“以现有真源为准”，禁止旧的“thinking only gpt”预期复活。

## /goal Prompt

```text
/goal
目标：完成 servertool / stopless 主链 skeleton 的 Rust-only closeout，保持业务流程仍通过 client-visible CLI 运行，但注入、响应拦截、schema 校验、请求结果解析、工具注入、followup/reenter/finalize 全部改为 hook-governed 的唯一真源；同时锁定 5520 thinking 的 1:1 load balancing 真源为 fwd.paid.gpt-5.4 + fwd.glm.glm-5.2。

实现文档：
docs/goals/servertool-skeleton-rust-only-closeout-plan-2026-06-20.md

执行规范：
- 先验证再改实现，先补红测/黑盒/白盒 gate，再做物理删除。
- 禁止 fallback / 降级 / 双路径补偿；hook required/optional 必须显式区分，缺失 required 必须 fail-fast。
- 只改唯一真源，不扩散到无关池；5520 thinking 以现有 1:1 配置为准，不复活“thinking only gpt”旧预期。

验证：
- 定向单测和 focused blackbox。
- Rust build / native hotpath build。
- 必要时 live replay / 真实样本验证。

完成标准：
- servertool 主链 TS 活语义全部收口到 Rust-only hook skeleton，旧 wrapper / alias / dead code 物理删除。
- 5520 thinking 负载均衡与测试断言稳定为 gpt-5.4 : glm-5.2 = 1 : 1，且验证通过。
- function map、mainline call map、wiki review surface、skills 记忆同步更新。
```

## Validation Stack

本轮审计后的最小必跑验证栈：

1. `tests/server/handlers/responses-handler.servertool-stopless.dual-port.e2e.spec.ts`
2. `tests/servertool/server-side-tools.dispatch-native.spec.ts`
3. `tests/servertool/server-side-tools.auto-hook-config.spec.ts`
4. `tests/servertool/servertool-auto-hook-trace.spec.ts`
5. `npm run verify:servertool-rust-only`

closeout 前新增必跑：

6. servertool backend-route dual-port full-chain blackbox
7. 对应新增 TS-active-orchestration gate

## Completion Signal

只有同时满足以下条件，才能宣称 servertool skeleton Rust-only closeout：

1. stopless 不只是闭环行为绿，而且 `engine/server-side-tools/execution-shell/registry` 不再持有活编排语义
2. 双端口 stopless 黑盒和 servertool backend-route 双端口黑盒都成为 required gate
3. function map / mainline call map 与真实 owner 一致
4. 旧 TS 语义被物理删除或收缩成明确 IO thin shell

在那之前，只能宣称：

- stopless 行为闭环已部分完成
- servertool Rust-only closeout 仍在进行中
