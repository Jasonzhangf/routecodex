# Error Pipeline Contract Phase E1-E2 Plan

## 目标与验收标准

目标：把 provider/runtime/direct/executor 错误统一纳入唯一错误链，先完成 E1 契约红测与 E2 `router-direct` provider error 接入，解决 direct 502/524/5xx 不进入 Virtual Router policy、重复命中同一 provider 的问题。

验收标准：

1. 错误链命名与接口契约固定为：`ErrorErr01SourceRaised -> ErrorErr02HostCaptured -> ErrorErr03RuntimeClassified -> ErrorErr04RouterPolicyApplied -> ErrorErr05ExecutionDecision -> ErrorErr06ClientProjected`。
2. `router-direct` provider send/process 抛出的 recoverable provider error 必须进入 `ErrorErr02HostCaptured` 并报告给 Router policy。
3. direct 失败仍原样 fail-fast 返回原始错误，不吞错、不 fallback 成成功、不改 provider/request/response payload。
4. provider 5xx/429/524 等 recoverable 错误由唯一 policy 入口处理 health/cooldown/reroute 状态，不允许 direct/executor/provider runtime 自建第二套 policy。
5. 红测能锁住 direct 旁路、手写 provider error event、重复 classifier、health 直接写入、`ErrorHandlingCenter` 误入 provider policy。
6. 构建、定向测试、Rust policy 测试、全局安装、服务器重启与 live health 验证通过；本地 commit 完成，未 push。

## 范围与边界

In scope：

1. 梳理并固化错误链接口命名与 owner module。
2. 增加/修复 E1 static red tests 与 router-direct 行为测试。
3. 修复 `router-direct` provider error bypass：只接入统一错误捕获/报告，不改变 direct payload 语义。
4. 确保错误事件携带正确 runtime scope，使 Rust Virtual Router health/policy 写到正确 store/session。
5. 更新 `AGENTS.md`、`.agents/skills/rcc-dev-skills/SKILL.md`、`docs/design/error-pipeline-contract-and-routing-audit.md`。

Out of scope：

1. 不重写请求/响应 Hub Pipeline。
2. 不新增 fallback/default 兜底成功路径。
3. 不把 provider-specific 修补写入 Hub Pipeline 或 Virtual Router。
4. 不删除不理解的历史代码；重复/错误实现必须先证明依赖已迁走，再单独物理删除。
5. 不推送远端。

## 设计原则

1. 错误链是请求/响应链同级 contract，不是日志旁路。
2. `ErrorErr02HostCaptured` 是 Host 侧 provider error event 唯一 builder；调用点不得手拼 event。
3. `ErrorErr04RouterPolicyApplied` 的策略真源在 Virtual Router/Rust policy；TS 只做桥接和消费。
4. direct path 不是 provider error 例外；direct provider error 必须进入同一 Router policy 链。
5. `ErrorHandlingCenter` 只做 client projection，不参与 provider health/cooldown/reroute 决策。
6. 错误处理不允许修改正常 request/response payload，不允许把 metadata/error 混进 normal payload。

## 技术方案与文件清单

核心文档：

1. `docs/design/error-pipeline-contract-and-routing-audit.md`：错误链契约、owner、违规点、阶段计划。
2. `AGENTS.md`：追加错误链硬规则与 ASCII 定位入口。
3. `.agents/skills/rcc-dev-skills/SKILL.md`：追加错误症状到唯一 owner 的定位规则。

核心实现：

1. `src/providers/core/utils/provider-error-reporter.ts`：定义/导出 `ErrorErr01SourceRaised`、`ErrorErr02HostCaptured` 与唯一 capture/report wrapper。
2. `src/server/runtime/http-server/router-direct-pipeline.ts`：direct provider call try/catch 只调用 `onProviderError(ErrorErr01SourceRaised)` 并 rethrow 原始错误。
3. `src/server/runtime/http-server/index.ts`：把 direct provider error hook 接到 `report_error_err_02_host_to_router_policy_from_error_err_01_source`，并注入正确 runtime/session scope。
4. `sharedmodule/llmswitch-core/src/native/router-hotpath/native-provider-runtime-ingress.ts` + Rust `virtual_router_engine/provider_runtime_ingress.rs`：提供内部 Router policy bridge，禁止业务模块手写 raw policy event。
5. `sharedmodule/llmswitch-core/src/router/virtual-router/**` 与相关 compat action：把手写 `reportProviderErrorToRouterPolicy({ ... })` 收口到唯一 bridge。

测试：

1. `tests/server/runtime/http-server/error-pipeline-contract.spec.ts`：static red tests 锁定错误链唯一入口与禁止模式。
2. `tests/server/runtime/http-server/router-direct-pipeline.spec.ts`：direct provider error capture + rethrow 行为测试。

## 风险与规避

1. 风险：只改 executor，漏掉 `router-direct` live stack。规避：用 diag stack 与 red test 锁定 direct path。
2. 风险：direct hook 报错吞掉原始 provider error。规避：hook failure 只能作为附加日志/诊断，direct call 必须 rethrow original error。
3. 风险：runtime scope 缺失导致 health 写错 store。规避：事件必须携带 sessionDir/rccUserDir/server scope，验证 health/cooldown 状态变化。
4. 风险：新增 fallback 让请求假成功。规避：所有 recoverable decision 只能来自 Router policy；当前请求失败仍按策略显式 retry/reroute/fail，不得伪造 success。
5. 风险：误删未理解代码。规避：本阶段只做 E1/E2；物理删除进入后续 E5，必须有依赖迁移证据。

## 测试计划

定向测试：

1. `npx jest tests/server/runtime/http-server/error-pipeline-contract.spec.ts --runInBand`
2. `npx jest tests/server/runtime/http-server/router-direct-pipeline.spec.ts --runInBand --testNamePattern='reports direct provider errors|openai-responses same-protocol'`

TypeScript / Rust 验证：

1. `npx tsc --noEmit --pretty false --skipLibCheck`
2. `cargo test --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml -p router-hotpath-napi virtual_router_engine::engine::events::tests --lib -- --nocapture`
3. `cargo test --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml -p router-hotpath-napi virtual_router_engine::health::tests --lib -- --nocapture`
4. `cargo test --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml -p router-hotpath-napi virtual_router_engine::engine::selection::tests --lib -- --nocapture`
5. `cargo build --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml -p router-hotpath-napi`

Runtime 验证：

1. `npm run build:min`
2. `npm install -g .`
3. 使用项目标准 server restart 流程重启指定端口，禁止 broad kill。
4. `curl -sS --max-time 5 http://127.0.0.1:5520/health`
5. 用 live/diag/snapshot 证明 direct provider 5xx 进入 Router policy，重复请求不再无限命中同一个冷却 provider。
6. `git diff --check`

## 实施步骤

1. 先修复当前未提交代码的语法/类型错误，禁止回滚或批量 checkout 未确认文件。
2. 对照 `docs/design/error-pipeline-contract-and-routing-audit.md` 确认 ErrorErr 节点 owner 与调用方向。
3. 完成 `ErrorErr01SourceRaised` / `ErrorErr02HostCaptured` wrapper 与 direct hook 接线。
4. 收口现有手写 Router policy event 到唯一 bridge。
5. 补齐 static red tests 与 router-direct 行为测试。
6. 更新 `AGENTS.md` 与 `.agents/skills/rcc-dev-skills/SKILL.md` 的错误链定位规则。
7. 跑定向测试、TS/Rust 构建、全局安装、重启服务器、live 验证。
8. Review 全部未提交 diff，只 stage 本目标相关文件，本地 commit，未 push。

## 完成定义

1. 错误链契约文档、AGENTS、skill 均已落盘。
2. direct provider error 不再绕过 ErrorErr02/Router policy。
3. 红测能防止未来新增 direct/executor/provider runtime 旁路。
4. 构建安装重启与 live health 验证有命令证据。
5. repo 目标相关改动已本地 commit，工作区不包含本目标未提交残留。
