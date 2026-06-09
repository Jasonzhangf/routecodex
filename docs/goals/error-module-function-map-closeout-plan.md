# Error Module Function Map Closeout Plan

## 目标与验收标准

目标：把 provider/runtime/direct/executor/server/client 错误处理统一纳入一个可查询、可 gate、可迁 Rust 的 `Error` 模块架构，不再让 provider runtime、RequestExecutor、direct path、HTTP projection 各自拥有一套错误处理语义。

验收标准：

1. `ErrorErr01SourceRaised -> ErrorErr02HostCaptured -> ErrorErr03RuntimeClassified -> ErrorErr04RouterPolicyApplied -> ErrorErr05ExecutionDecision -> ErrorErr06ClientProjected` 成为唯一错误链。
2. function-map / verification-map 新增或重组 Error 模块 feature，至少覆盖 ErrorErr01-06、provider failure policy、backoff action queue、client projection、静态禁止规则。
3. provider/runtime/direct/executor 错误入口必须通过 Error 模块 owning builder/parser；禁止调用点手拼 event、重复分类、fire-and-forget policy 上报、provider-local retry。
4. `RequestExecutor`、router-direct、provider-direct 只能消费 Error 模块输出的 execution decision；不得本地实现 retry/reroute/cooldown/health policy。
5. `ErrorHandlingCenter` / HTTP error mapper 只归属 `ErrorErr06ClientProjected`，不得进入 provider policy。
6. function-map gate 能发现：
   - Error feature 缺 source anchor；
   - Error feature owner 不唯一；
   - provider/direct/executor 绕过 Error 模块；
   - provider runtime 新增本地 retry/backoff/fallback；
   - client projection 反向影响 provider policy。
7. 所有改造通过定向 Jest、Rust policy tests、architecture gates、build/tsc、真实 runtime smoke；无未解释 blocker。

## 范围与边界

In scope：

1. Error 模块 feature 拆分、function-map / verification-map / source anchor / gate 设计。
2. `src/providers/core/utils/provider-error-reporter.ts` 的 ErrorErr01-02 owner 收口。
3. `src/providers/core/runtime/provider-error-catalog.ts`、`provider-failure-policy*` 的 ErrorErr03 owner 收口。
4. `sharedmodule/llmswitch-core/src/native/router-hotpath/native-provider-runtime-ingress.ts` 与 Rust `virtual_router_engine/provider_runtime_ingress.rs` / `engine/events.rs` 的 ErrorErr04 owner 收口。
5. `src/server/runtime/http-server/executor/*` 中 ErrorErr05 consumer 化。
6. HTTP/SSE client error projection 的 ErrorErr06 owner 明确化。
7. provider direct / router direct / Responses direct / startup init / SSE decode / servertool followup error 的统一入口检查。
8. 物理删除或 thin-shell 化已确认错误的重复实现。

Out of scope：

1. 不重写正常 request/response payload pipeline。
2. 不新增 fallback、降级、兜底成功路径。
3. 不把 provider-specific 分支写入 Hub Pipeline / Virtual Router 通用语义。
4. 不改 provider wire payload 形状来“修”错误处理。
5. 不批量回滚或删除未确认代码；删除必须有调用迁移证据和红测。

## 设计原则

1. Error 是与 Req/Resp/Meta 同级的 contract module，不是日志工具、catch helper 或 HTTP mapper 的集合。
2. 每个 ErrorErr 节点只能有一个 owning builder/parser；其它模块只允许相邻调用。
3. provider/runtime/direct/executor 错误源只产出 `ErrorErr01SourceRaised` 最小事实，不决定 retry/reroute/cooldown/health。
4. Router policy 只消费 `ErrorErr03RuntimeClassified` / `ErrorErr02HostCaptured` 投影，不接收调用点手拼 raw event。
5. Execution decision 只消费 Error 模块输出，不重新分类。
6. Client projection 只消费 `ErrorErr06ClientProjected`，不回写 provider policy。
7. 所有 gate 先红后绿；没有 gate 的架构规则只能算文档约束，不能算闭环。

## 目标功能图

建议把现有 error feature 重组为以下 function-map 结构。

### `error.pipeline_contract`

职责：ErrorErr01-06 拓扑、owner 唯一性、相邻转换、禁止旁路。

Owner：

- `docs/design/error-pipeline-contract-and-routing-audit.md`
- `src/providers/core/utils/provider-error-reporter.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-provider-runtime-ingress.ts`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/provider_runtime_ingress.rs`

必需 gate：

- `npm run verify:architecture-error-chain-bypass`
- 新增 `npm run verify:error-pipeline-contract`
- `npm run verify:function-map-compile-gate`

### `error.provider_failure_policy`

职责：provider error cataloging、classification、health impact、retry/reroute/backoff plan projection。

Owner：

- `src/providers/core/runtime/provider-error-catalog.ts`
- `src/providers/core/runtime/provider-failure-policy-impl.ts`
- `src/providers/core/runtime/provider-failure-policy-native.ts`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/failure_policy.rs`

必须修正：

- provider-local `autoRetry` 不属于这里，必须删除或迁入 policy decision。
- `provider-error-classifier.ts` 只能 thin adapter，不能成为第二分类中心。

### `error.backoff_action_queue`

职责：统一 blocking wait 队列，固定 `1s -> 2s -> 3s -> repeat`，执行 wait 但不定义 provider classification。

Owner：

- `src/server/runtime/http-server/executor/request-executor-error-action-queue.ts`
- `src/server/runtime/http-server/executor/request-executor-global-error-backoff.ts`
- `src/server/runtime/http-server/executor/request-executor-session-storm-backoff.ts`
- `src/providers/core/runtime/provider-failure-policy-backoff.ts`

必须修正：

- gate 禁止新增 env/exponential/jitter/Retry-After/local waiter queue。
- provider/runtime 不能直接 sleep retry。

### `error.execution_decision_consumer`

职责：RequestExecutor / router-direct / provider-direct 消费 ErrorErr05 并执行 retry/reroute/fail；只执行，不分类。

Owner：

- `src/server/runtime/http-server/executor/request-executor-provider-failure-plan.ts`
- `src/server/runtime/http-server/executor/request-executor-provider-failure.ts`
- `src/server/runtime/http-server/executor/request-executor-retry-execution-plan.ts`
- `src/server/runtime/http-server/router-direct-pipeline.ts`
- `src/server/runtime/http-server/provider-direct-pipeline.ts`
- `src/server/runtime/http-server/index.ts`

必须修正：

- provider-mode direct 要对齐 router-direct 的 ErrorErr hook。
- reporter failure 不得静默降级为“错误未进 policy 但请求继续”。

### `error.client_projection`

职责：HTTP/SSE/client-visible error body/status projection。

Owner：

- `src/server/utils/http-error-mapper.ts`
- `src/error-handling/quiet-error-handling-center.ts`
- `src/error-handling/route-error-hub.ts`
- HTTP response projection owner modules

必须锁定：

- ErrorHandlingCenter 不得参与 provider retry/reroute/cooldown/health。
- client error body 不得泄漏 runtime metadata / auth / provider internals。

## 当前审计输入

来自 `docs/reports/provider-system-architecture-audit-2026-06-09.md` 的关键改造输入：

1. 已修：`BaseProvider` 的 provider-local `autoRetry` 执行路径已删除，`auto-retry-error-codes.ts` 已物理删除。
2. 已修：provider-mode direct 已对齐 router-direct 的 `onProviderError -> resolveRequestExecutorProviderFailurePlan` hook，并保持 direct payload passthrough。
3. 已修：function-map / verification-map 已新增 `error.pipeline_contract`、`error.execution_decision_consumer`、`error.client_projection`。
4. 已修：新增 `npm run verify:error-pipeline-contract`，并接入 `verify:architecture-ci`。
5. 已完成：`BaseProvider` / `ResponsesProvider` / startup init 的 provider error report 均改为 awaited `emitProviderErrorAndWait`；production `src` 路径禁止 fire-and-forget `emitProviderError`。
6. metadata 边界 gate 当前通过，重点不是 metadata leak，而是错误控制面确定性。

## 技术方案

### Phase 0：现状冻结与红测基线

1. 读取并对齐：
   - `AGENTS.md`
   - `.agents/skills/rcc-dev-skills/SKILL.md`
   - `docs/error-handling-v2.md`
   - `docs/design/error-pipeline-contract-and-routing-audit.md`
   - `docs/design/provider-failure-policy-ssot.md`
   - `docs/reports/provider-system-architecture-audit-2026-06-09.md`
2. 跑基线 gate：
   - `npm run verify:function-map-compile-gate`
   - `npm run verify:architecture-error-chain-bypass`
   - `npm run verify:architecture-provider-specific-leaks`
   - `npm run verify:architecture-metadata-leak-boundary`
   - `npm run verify:provider-failure-ban-blackbox`
3. 已完成：`verify:provider-failure-ban-blackbox` 的本地 module resolution blocker 通过 `npm run llmswitch:ensure` 修复，`node_modules/rcc-llmswitch-core` 指向仓库内 `sharedmodule/llmswitch-core`。

### Phase 1：function-map / verification-map 增加 Error 模块总入口

1. 已完成：在 `docs/architecture/function-map.yml` 增加或重组：
   - `error.pipeline_contract`
   - `error.provider_failure_policy`
   - `error.backoff_action_queue`
   - `error.execution_decision_consumer`
   - `error.client_projection`
2. 已完成：在 `docs/architecture/verification-map.yml` 增加对应验证矩阵。
3. 已完成：在 source 文件加入 `feature_id:` anchors，优先放在唯一 owner 文件，不在调用点泛滥添加。
4. 已验证：`npm run verify:function-map-compile-gate` PASS。

### Phase 2：ErrorErr01-02 capture/report 确定性收口

1. `provider-error-reporter.ts` 拆清职责：
   - source/capture builder；
   - awaited report；
   - observation-only report。
2. 已完成：请求路径错误必须使用 awaited report；production `src` 路径中 `emitProviderError` 只允许留在 ErrorErr02 owner wrapper 内。
3. 已完成：`BaseProvider` / `ResponsesProvider` / startup init / provider-direct / router-direct 错误入口全部显式进入 ErrorErr01-02。
4. 已完成：`BaseProvider` request catch 会等待 ErrorErr report 后再 rethrow 原始错误；provider-direct/router-direct 同样 await hook 后 rethrow。

### Phase 3：Provider runtime 去本地 retry/backoff/policy

1. 已完成：删除 `BaseProvider.autoRetry` 执行路径。
2. 已完成：`auto-retry-error-codes.ts` 无唯一 policy 消费，已物理删除。
3. `provider-error-classifier.ts` 降为 thin adapter 或迁入 `provider-failure-policy-impl.ts` / Rust `failure_policy.rs`。
4. provider runtime 只提供 transport/context/error raw facts。

### Phase 4：Direct / Executor consumer 化

1. 已完成：provider-mode direct 对齐 router-direct：
   - provider call catch；
   - ErrorErr report awaited；
   - consume ErrorErr05 decision；
   - 不改 direct payload。
2. RequestExecutor retry helpers 只消费 `resolveProviderFailureActionPlan` / Router policy decision。
3. 移除 message-only / status-only 本地分类分支。
4. 错误后的 blocking wait 全部通过 `error.backoff_action_queue`。

### Phase 5：Client projection 隔离

1. 把 HTTP/SSE error projection 显式归入 `error.client_projection`。
2. gate 禁止 `ErrorHandlingCenter`、HTTP mapper、handler response utils 调用 provider health/cooldown/reroute policy。
3. gate 禁止 client error body 泄漏 runtime metadata / provider auth / internal carrier。

### Phase 6：旧实现物理删除与 gate 固化

1. 删除已迁移的 duplicate classifier、event builder、local retry/backoff helper、dead auto retry config。
2. 新增或扩展静态 gates：
   - provider runtime 禁止 `autoRetry` / local retry；
   - provider/direct/executor 禁止 raw `reportProviderErrorToRouterPolicy({ ... })`；
   - ErrorHandlingCenter 禁止 provider policy dependency；
   - function-map 必须覆盖新增 Error owner；
   - error chain bypass 禁止新增 direct/provider path 旁路。
3. 更新 `docs/error-handling-v2.md` 和 `.agents/skills/rcc-dev-skills/SKILL.md` 的错误链定位规则。

## 风险与规避

1. 风险：把 Error 模块做成第二中心。规避：Error 模块只是 ErrorErr chain owner；Router policy 仍是 ErrorErr04 真源，RequestExecutor 只消费 ErrorErr05。
2. 风险：为了通过 gate 保留旧实现为 idle code。规避：已确认错误实现必须物理删除，不允许“不接入”。
3. 风险：provider direct 改造破坏 direct passthrough payload。规避：direct payload 相关测试必须证明 body object / semantic payload 不被改写。
4. 风险：reporter awaited 后造成循环或重复上报。规避：保留 reported marker，但 marker 只防重复，不允许跳过首次 ErrorErr02。
5. 风险：blackbox gate 先被 dist/module blocker 卡住。规避：先修 `rcc-llmswitch-core` resolution，再做语义改造；不能用跳过 gate 宣称完成。

## 测试计划

Architecture gates：

```bash
npm run verify:function-map-compile-gate
npm run verify:architecture-error-chain-bypass
npm run verify:architecture-provider-specific-leaks
npm run verify:architecture-metadata-leak-boundary
npm run verify:architecture-fallback-denylist
```

Error / provider gates：

```bash
npm run verify:provider-failure-ban-blackbox
npm run verify:architecture-ci
```

Focused Jest：

```bash
npm run jest:run -- --runInBand --runTestsByPath \
  tests/red-tests/error_chain_singleton_truth.test.ts \
  tests/server/runtime/http-server/router-direct-pipeline.spec.ts \
  tests/server/runtime/http-server/provider-direct-pipeline.spec.ts \
  tests/server/runtime/http-server/executor/request-executor-provider-failure-plan.spec.ts \
  tests/server/runtime/http-server/executor/request-executor-error-action-queue.spec.ts
```

Rust：

```bash
cargo test --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml -p router-hotpath-napi failure_policy --lib -- --nocapture
cargo test --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml -p router-hotpath-napi provider_runtime_ingress --lib -- --nocapture
cargo test --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml -p router-hotpath-napi virtual_router_engine::engine::events::tests --lib -- --nocapture
```

Build / typecheck：

```bash
npx tsc --noEmit --pretty false
npm run build:min
git diff --check
```

Runtime smoke：

1. Build/install current package after all gates pass.
2. Restart target RouteCodex port with approved scoped restart flow, no broad kill.
3. Probe `/health` and `/v1/models`.
4. Trigger controlled provider 5xx/429 or blackbox fixture.
5. Verify logs/snapshots show:
   - ErrorErr02 captured；
   - ErrorErr04 policy applied；
   - ErrorErr05 decision consumed；
   - no provider-local retry before ErrorErr；
   - no client payload metadata leak。

## 实施步骤

1. Fix blocker: make `npm run verify:provider-failure-ban-blackbox` runnable if it still fails on `rcc-llmswitch-core` resolution.
2. Add function-map / verification-map entries for Error module features and source anchors.
3. Add red gates for provider-local retry, raw provider policy report, direct/provider bypass, ErrorHandlingCenter policy dependency.
4. Convert provider runtime request-path reports to awaited ErrorErr reporting.
5. Remove provider-local `autoRetry` execution path.
6. Align provider-mode direct with router-direct ErrorErr hook.
7. Make RequestExecutor helpers consume Error module decisions only; remove duplicate classifications.
8. Lock client projection as ErrorErr06 only.
9. Physically delete confirmed duplicate/dead error handling implementations.
10. Run full verification matrix, update docs/skills/memory, commit only related changes.

## 本轮完成状态（2026-06-09）

已完成：

1. `npm run llmswitch:ensure` 修复 `verify:provider-failure-ban-blackbox` 的本地 `rcc-llmswitch-core` 解析阻塞。
2. 新增并验证 `npm run verify:error-pipeline-contract`。
3. `docs/architecture/function-map.yml` / `docs/architecture/verification-map.yml` 已新增 `error.pipeline_contract`、`error.execution_decision_consumer`、`error.client_projection`。
4. `BaseProvider.autoRetry` 执行路径与 `auto-retry-error-codes.ts` 已物理删除；runtime/profile `autoRetry` 不再传播。
5. provider-direct 已添加 awaited `onProviderError` hook，并由 HTTP server 接入 `resolveRequestExecutorProviderFailurePlan`，同时保留 direct payload passthrough。
6. 审计报告已落盘：`docs/reports/provider-system-architecture-audit-2026-06-09.md`。
7. `.agents/skills/rcc-dev-skills/SKILL.md`、`MEMORY.md`、`note.md` 已记录 autoRetry 禁止恢复与 Error module gate 基线。
8. `BaseProvider`、`ResponsesProvider`、startup init 已从 fire-and-forget `emitProviderError` 收口到 awaited `emitProviderErrorAndWait`；`verify:error-pipeline-contract` 和 `error-pipeline-contract.spec.ts` 均锁住生产路径禁止裸 `emitProviderError(`。

已验证：

```bash
npm run verify:error-pipeline-contract
npm run verify:architecture-error-chain-bypass
npm run verify:function-map-compile-gate
npm run verify:architecture-provider-specific-leaks
npm run verify:architecture-metadata-leak-boundary
npm run verify:architecture-fallback-denylist
npm run verify:provider-failure-ban-blackbox
npm run jest:run -- --runInBand --runTestsByPath \
  tests/server/runtime/http-server/provider-direct-pipeline.spec.ts \
  tests/server/runtime/http-server/router-direct-pipeline.spec.ts \
  tests/server/runtime/http-server/error-pipeline-contract.spec.ts \
  tests/providers/core/runtime/provider-auto-retry-business-error.spec.ts \
  tests/providers/core/runtime/provider-2056-classification.spec.ts \
  tests/providers/core/runtime/provider-error-catalog.spec.ts \
  tests/server/http-server/http-server-bootstrap.deepseekweb.spec.ts \
  tests/server/runtime/http-server/http-server-runtime-setup.provider-merge.spec.ts
npx tsc --noEmit --pretty false
npm run build:min
git diff --check
```

未完成 / 后续项：

1. 已补充 runtime smoke：临时 `dist` server 的 `/health` 与 `/v1/models` HTTP 入口可用；常驻 5520/5555 `/health` 均为 `status=ok ready=true pipelineReady=true`，`/v1/models` 均返回 292 models。
2. 尚未把新 build `0.90.3045` install/restart 到常驻端口；本轮不做发布/重启，只证明代码、build 与现有 live 入口健康。
3. 尚未提交；提交时必须只 stage 本轮 Error/provider/report/gate 相关文件，排除并行 config/SSE/servertool/release 改动。

## 完成定义

1. Error module has explicit feature-map entries, verification-map entries, source anchors, and passing function-map gate.
2. Provider/runtime/direct/executor/server/client error paths are all assignable to one ErrorErr node owner.
3. No request-path provider error uses fire-and-forget policy report.
4. No provider runtime local retry/backoff/fallback remains.
5. Direct paths preserve payload passthrough while entering ErrorErr chain on failure.
6. `verify:provider-failure-ban-blackbox` runs and passes, not skipped.
7. Live/runtime smoke proves provider errors enter policy and client projection remains isolated.
