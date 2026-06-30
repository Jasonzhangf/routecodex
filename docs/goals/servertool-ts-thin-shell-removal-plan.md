# Servertool TS Thin-Shell Removal Plan

## 1. 目标与验收标准

目标：把 `sharedmodule/llmswitch-core/src/servertool/` 里仍然承担编排语义的 TS 文件继续收口到 Rust 真源或更薄的 native wrapper，只保留必要的 JSON IO、native bridge、日志/载体辅助层，最终消灭 servertool 目录里的“活 TS 业务壳”。

验收标准：
- 仍承担语义的 TS 文件被逐个收口或物理删除，不再保留第二套业务 owner。
- Rust 是 servertool 语义真源；TS 只允许做薄壳、IO、bridge、日志、载体传递。
- 每一批删除或收口都有定向测试和 gate 证据，且通过后独立提交。
- `verify:servertool-rust-only`、function map、mainline call map、verification map 与实际 owner 一致。
- 不引入 fallback、吞错、补丁式修补或新的 TS 业务逻辑。

## 2. 范围与边界

In scope:
- `sharedmodule/llmswitch-core/src/servertool/**`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.ts`
- `scripts/verify-servertool-rust-only.mjs`
- `tests/servertool/**`
- `docs/architecture/function-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/verification-map.yml`

Out of scope:
- SSE 收口任务
- Hub Pipeline 非 servertool 主线改造
- Virtual Router 选路语义
- provider runtime 语义改造
- 任何需要批量回滚/批量 checkout 的操作

## 3. 设计原则

- 真源优先：编排、判定、投影、策略、调度的唯一 owner 继续下沉 Rust。
- 薄壳最小化：TS 只保留 native 调用、JSON 读写、IO、日志、载体传递。
- 物理移除：已确认无业务语义的旧 helper、重复实现、死分支必须删，不留闲置。
- 单次收口：每次只收一个语义面，收完立即补 gate，再进入下一面。
- 证据先行：先有红测/门禁，再改实现，完成后做真实验证和提交。

## 4. 当前审计结论

高优先级继续收口的 TS 编排面：
- `sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts`
- `sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts`
- `sharedmodule/llmswitch-core/src/servertool/execution-stage-shell.ts`
- `sharedmodule/llmswitch-core/src/servertool/auto-hook-caller.ts`
- `sharedmodule/llmswitch-core/src/servertool/execution-handler-materialization-shell.ts`
- `sharedmodule/llmswitch-core/src/servertool/cli-projection-runtime-shell.ts`
- `sharedmodule/llmswitch-core/src/servertool/skeleton-config.ts`
- `sharedmodule/llmswitch-core/src/servertool/orchestration-policy-block.ts`

当前更偏 thin shell / carrier 的面，优先级较低：
- `entry-preflight-shell.ts`
- `entry-context-shell.ts`
- `registry-orchestration-shell.ts`
- `registry-registration-shell.ts`
- `registry-projection-shell.ts`
- `run-server-side-tool-engine-shell.ts`
- `engine-selection-block.ts`
- `timeout-error-block.ts`
- `metadata-center-carrier.ts`
- `progress-log-block.ts`
- `match-log-block.ts`
- `log/progress-file.ts`
- `types.ts`

## 5. 技术方案

### Phase 0: 锁红测与门禁
- 扩展 `scripts/verify-servertool-rust-only.mjs`，把高优先级 TS 编排面纳入“不得承载语义”的明确检查。
- 为计划删除或下沉的语义点补红测，覆盖：
  - engine 主链编排
  - response-stage orchestration
  - execution branch / outcome materialization
  - auto-hook 调度
  - CLI projection
  - orchestration policy
- 先把旧语义 marker 锁红，再动实现。

### Phase 1: 收 `execution-handler-materialization-shell.ts`
- 目标：把 handler plan / outcome materialization / runtime action 继续下沉到 Rust 真源或只保留最小执行壳。
- 只允许 TS 保留必要的 `finalize()` 调用和 IO 适配，不允许再承载第二套 handler contract 判定。

### Phase 2: 收 `execution-stage-shell.ts` 与 `auto-hook-caller.ts`
- 目标：把 execution branch、dispatch、auto-hook queue、CLI projection 分流继续压到 Rust plan。
- TS 只负责执行 Rust 计划，不允许继续决定流程分支。

### Phase 3: 收 `engine-orchestration-shell.ts` 与 `response-stage-orchestration-shell.ts`
- 目标：把顶层 engine / response stage orchestration 收缩为 thin coordinator。
- Rust 负责 stopless / followup / projection / runtime action 的语义判定；TS 只做输入组织、调用和结果透传。

### Phase 4: 收 `cli-projection-runtime-shell.ts` 与 `skeleton-config.ts`
- 目标：只保留 CLI projection 的 IO 载体与 skeleton config 的 native 读取壳。
- 所有 flow/policy/registry/registration/lookup 的语义继续由 Rust 产出。

### Phase 5: 收尾 registry / policy / carrier 类壳
- 目标：将 registry、policy、timeout、metadata carrier 类文件压到最薄。
- 对确认无语义的 helper 做物理删除，对必须存在的 wrapper 保持单一职责，不再扩增语义。

### Phase 6: 删除死壳并升级门禁
- 对已经被 Rust 彻底替代且没有 runtime consumer 的 TS 文件执行物理删除。
- `verify:servertool-rust-only`、function map、mainline call map、verification map 同步收口，禁止旧 owner marker 复活。

## 6. 风险与规避

- 风险：把仍在使用的壳误删。
  - 规避：先查 owner/map，再做红测，再删文件。
- 风险：TS 只薄化但没真正去语义。
  - 规避：门禁直接扫描旧语义 marker 和 owner 归属。
- 风险：与其他 worker 的未提交改动冲突。
  - 规避：每轮只提交本 slice，避免大范围混合改动。
- 风险：把日志/载体 helper 误判为业务语义。
  - 规避：区分 data/IO/carrier 与 policy/orchestration，不把观测面当 owner。

## 7. 测试计划

每个 slice 最少跑：
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --pretty false`
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- 对应的 `tests/servertool/**` 定向 Jest
- `git diff --check`

必要时补跑：
- Rust 定向 crate tests
- `npm run build:base`
- 相关 blackbox / replay / live probe

## 8. 实施步骤

1. 确认当前 servertool 残留文件和 owner/map 归属。
2. 先补红测与 gate，锁定不能再复活的旧语义 marker。
3. 优先收 `execution-handler-materialization-shell.ts`，再收 `execution-stage-shell.ts` / `auto-hook-caller.ts`。
4. 收顶层 `engine-orchestration-shell.ts` / `response-stage-orchestration-shell.ts`。
5. 收 `cli-projection-runtime-shell.ts` / `skeleton-config.ts`。
6. 收 registry / policy / carrier 薄壳。
7. 对确认已无消费者的 TS 文件执行物理删除。
8. 每个通过的 slice 独立提交，并同步 note / MEMORY / skills。

## 9. 完成定义

- `sharedmodule/llmswitch-core/src/servertool/` 中不再存在承担业务语义的 TS 活壳。
- 仅保留必要的 native wrapper、IO shell、日志与 carrier 文件。
- owner map / mainline map / verification map 与运行时代码对齐。
- 所有 slice 都有测试、门禁、提交和证据。
- 不再有可恢复的旧 TS 业务语义残留。
