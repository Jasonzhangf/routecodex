# Servertool Skeleton Rust-Only Closeout Plan (2026-06-20)

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

- stopless 双端口全链黑盒已覆盖：
  - `no_schema`
  - `wrong_schema`
  - `valid_terminal_schema`

文件：`tests/server/handlers/responses-handler.servertool-stopless.dual-port.e2e.spec.ts`

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
2. gate 必须先红，再修

原因：

- 如果不先锁，后续还会继续出现“gate 绿，但其实没 Rust-only”的假绿

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
2. stopless dual-port full-chain blackbox 绿
3. servertool backend-route dual-port full-chain blackbox 绿
4. function-map / mainline-call-map 与运行时 owner 对齐
5. 能物理删除不再需要的 TS 活语义，而不是仅“不调用”

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
