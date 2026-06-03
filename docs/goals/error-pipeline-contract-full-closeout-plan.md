# Error Pipeline Contract Full Closeout Plan

## 目标与验收标准

目标：完成全仓错误处理链收口，把 provider/runtime/direct/executor/server/client 错误全部纳入唯一 `ErrorErr*` 契约链，删除或降级历史重复实现，确保错误处理只有一个 owning module 和一条调用路径。

验收标准：

1. 全仓错误链固定为：`ErrorErr01SourceRaised -> ErrorErr02HostCaptured -> ErrorErr03RuntimeClassified -> ErrorErr04RouterPolicyApplied -> ErrorErr05ExecutionDecision -> ErrorErr06ClientProjected`。
2. 每个节点只有一个 owning module；其它模块只能调用 owning module，不得复制业务逻辑。
3. provider/runtime/direct/executor/followup/compat/server 错误不得手拼 provider error event，不得本地实现 retry/reroute/cooldown/health policy。
4. `ErrorHandlingCenter` 只负责 HTTP/server/client projection，不参与 provider policy。
5. 旧接口要么是明确 thin shell，要么物理删除；删除前必须有红测和依赖迁移证据。
6. metadata/debug/snapshot/error carrier 不进入 provider normal request payload 或 client normal response body。
7. 编译、Rust、Jest、build、全局安装、重启、runtime red 全部通过；本地 commit，禁止 push。

## 范围与边界

In scope：

1. 全仓错误入口审计：provider runtime、direct path、RequestExecutor、Virtual Router、compat actions、servertool followup、HTTP projection。
2. ErrorErr01-06 skeleton 从“存在”推进到“唯一使用路径”。
3. `handleProviderFailure` / legacy report APIs / duplicate classifiers / retry helpers 的 thin shell 化或物理删除。
4. 红测扩大到全仓扫描：禁止手写 event、禁止 direct retry fallback、禁止 health 直接写、禁止 message-only 分叉、禁止 ErrorHandlingCenter 进入 provider policy。
5. Runtime red 覆盖 502/503/524/429、池内切换、池空落后续/default、全空显式失败。

Out of scope：

1. 不重写 Hub request/response normal payload 流水线。
2. 不新增 fallback 成功路径。
3. 不写 provider-specific patch 到 Hub/VR。
4. 不批量删除不理解代码；物理删除必须先证明无调用、红测覆盖、构建通过。
5. 不 push。

## 设计原则

1. 错误链与请求/响应链同级；错误不是日志旁路，也不是正常 payload。
2. `ErrorErr02HostCaptured` 是 Host provider error event 唯一 builder。
3. `ErrorErr03RuntimeClassified` 是 code/status/classification 唯一分类入口。
4. `ErrorErr04RouterPolicyApplied` 的 policy truth 在 Virtual Router/Rust health/cooldown/selection。
5. `ErrorErr05ExecutionDecision` 只消费 Router policy decision 并执行，不再分类。
6. `ErrorErr06ClientProjected` 只投影 client-safe HTTP/SSE 错误。

## 技术方案与文件清单

权威文档：

1. `docs/design/error-pipeline-contract-and-routing-audit.md`
2. `docs/design/pipeline-type-topology-and-module-boundaries.md`
3. `AGENTS.md`
4. `.agents/skills/rcc-dev-skills/SKILL.md`

核心模块：

1. `src/providers/core/utils/provider-error-reporter.ts`：`ErrorErr01 -> ErrorErr02` owning module。
2. `src/providers/core/runtime/provider-error-catalog.ts` 与 `provider-failure-policy-impl.ts`：`ErrorErr03` owning module。
3. `sharedmodule/llmswitch-core/src/router/virtual-router/provider-runtime-ingress.ts` 与 Rust `virtual_router_engine`：`ErrorErr04` owning module。
4. `src/server/runtime/http-server/executor/request-executor-retry-execution-plan.ts`：`ErrorErr05` consumer owning module。
5. `src/server/utils/http-error-mapper.ts` / HTTP handler projection：`ErrorErr06` owning module。
6. `tests/server/runtime/http-server/error-pipeline-contract.spec.ts`：全仓错误链红测入口。

## Phase 计划

### Phase E3：Rust Router Policy 单入口

1. 审计 `handleProviderFailure` 与 `handleProviderError` 的实际调用链。
2. `handleProviderFailure` 降级为 thin shell 并标注删除计划，或在验证无依赖后物理删除。
3. Rust tests 只打唯一 `ErrorErr04RouterPolicyApplied` 入口。
4. 禁止 TS/Rust 任意模块直接写 health/cooldown，统一从 policy event 进入。

### Phase E4：Executor 降级为 Decision Consumer

1. `RequestExecutor` 不再扩展 provider classification 逻辑，只消费 `ErrorErr04` 结果形成 `ErrorErr05`。
2. 把 status/code/message 分类迁到 `provider-error-catalog.ts` / `provider-failure-policy-impl.ts`。
3. 删除或 thin shell 化 executor 内重复 retry/reroute 决策 helper。
4. 保留请求内执行语义，但禁止重新定义 recoverable/unrecoverable。

### Phase E5：全仓重复实现物理删除

1. 删除非唯一 provider error event builder。
2. 删除 legacy duplicate classifier / message-only 分叉。
3. 删除 direct/provider 特有 health mutation。
4. 删除已迁移且无调用的旧 shell；每个删除点必须有 `rg` 证据与红测保护。

### Phase E6：Runtime Matrix Closeout

1. 覆盖 direct 502 fail-fast + next request 不死打。
2. 覆盖 RequestExecutor 502/503/524/429 provider-switch。
3. 覆盖池内空 -> 下级 pool/default；全空 -> 显式 `PROVIDER_NOT_AVAILABLE` / 429/5xx。
4. 覆盖 servertool followup / compat action error 进入同一错误链。
5. 覆盖 metadata/error/snapshot 不进入 normal payload。

## 风险与规避

1. 风险：把 retry/reroute 全删导致请求内策略退化。规避：只删除“分类/policy 重复实现”，执行层保留 `ErrorErr05` consumer。
2. 风险：旧接口直接删除破坏外部调用。规避：先 thin shell + red test + `rg` 调用证据，再物理删除。
3. 风险：runtime red 依赖真实 provider 波动。规避：保留 unit/static red，同时用 live logs/diag/snapshot 做辅助证据。
4. 风险：错误 carrier 泄漏 payload。规避：沿用 metadata/payload 红测并扩展 error carrier 扫描。

## 验证矩阵

1. Jest：`error-pipeline-contract.spec.ts`、router-direct、request-executor provider failure、HTTP error projection。
2. Rust：Virtual Router events / health / selection / provider error policy tests。
3. TypeScript：`npx tsc --noEmit --pretty false --skipLibCheck`。
4. Build：`cargo build -p router-hotpath-napi`、`npm run build:min`。
5. Runtime：`npm install -g .`、显式重启 5520、`curl /health` ready。
6. Runtime red：direct 502、executor 502/524、429 quota/cooldown、pool fallback/default/all-empty。
7. Hygiene：`git diff --check`、`git status --short` clean after commit。

## 完成定义

1. 全仓没有未授权错误处理旁路。
2. ErrorErr01-06 的 owner、调用方向、禁止模式都被红测锁住。
3. 旧接口 thin shell / 删除计划完成，能删的已物理删除。
4. live/runtime red 证明 provider 错误不再死打同 provider。
5. 文档、AGENTS、skill、测试、构建、安装、重启、提交全部完成。
