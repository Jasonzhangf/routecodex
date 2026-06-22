# Servertool Hook Skeleton Rust-Only Closeout Plan (2026-06-22)

## Scope
- 本计划只针对 `servertool / stopless` hook skeleton 主链收口，目标是按 wiki/manifest 已锁定的目标骨架，把 TS 活业务语义继续下沉到 Rust。
- 业务执行生命周期仍是 client-visible CLI：
  - `routecodex hook run <toolName> --input-json <json>`
- hook skeleton 不替代 CLI；hook 只治理请求/响应处理流程：
  - 响应端：拦截、schema 校验、hook 注入响应、followup 规划、reenter 派发、投影 finalize。
  - 请求端：CLI 结果解析、必要文本替换、工具注入、请求 finalize。
- 多 hook 同时存在时，调度固定为 `priority -> order -> id`；duplicate id 必须 fail-fast。
- 每个 hook 必须声明 `required` / `optional`；required 缺失/失败/输出非法必须 fail-fast；optional 跳过必须产出 no-op event，禁止 fallback。

## Current Verdict
- `execution-shell.ts` 已物理删除。
- `server-side-tools.ts` 已收口为 13 行 re-export surface；`server-side-tools-impl.ts` 已收口为 23 行 thin orchestration shell，当前只负责：
  - `runServerSideToolEngine -> orchestrateServertoolEngine`
  - `extractToolCalls -> extract-tool-calls-shell`
  - `extractTextFromChatLike -> native wrapper`
- `execution-dispatch-outcome-shell.ts` 已收口为 2 行 re-export；原 `runServertoolIoExecutionQueue` truth 已移到 `execution-queue-shell.ts`，materialization truth 已移到 `execution-handler-materialization-shell.ts`。
- `registry.ts` 已收口为 14 行 re-export surface；但 `registry-impl.ts` 仍持有 builtin/ad-hoc handler binding、auto-hook descriptor materialization、registration/lookup/projection glue。
- `engine.ts` 仍是当前最大的 TS 活业务语义 owner（425 行），还负责 stop gateway / timeout / stopless mainline 编排 / native plan fan-in。
- 因此当前 closeout 阶段已从“先拆 response/execution shell”推进到“map/wiki/gate 已锁 + engine.ts / registry-impl.ts 仍待继续收”。

## Owner / Map Targets
- 真源：`docs/architecture/wiki/servertool-hook-skeleton-mainline-source.md` + `docs/architecture/mainline-call-map.yml` 的 `servertool.hook_skeleton.mainline`。
- Rust owner：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/`（hook contract / scheduler / validator / merge）和 `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/`（Hub request/response orchestration）。
- TS 薄壳：`sharedmodule/llmswitch-core/src/servertool/`（只允许 native wrapper / JSON bridge / IO shell）。

## Required Test Matrix

### 单元测试（白盒）
- normal response
- abnormal/error response
- `finish_reason=stop` stop schema（`<rcc_stop_schema>` / standalone JSON code fence）
- `finish_reason=tool_calls` `reasoningStop`（永远 client 不可见）
- empty schema / no_schema
- invalid schema（含 reason / missing fields）
- malformed hook args（schema error event，fail-fast 或 feedback）
- valid terminal schema（直接 stop）
- non-terminal / still-running（hook response / guidance 继续）
- already-terminal（禁止重复 followup/reenter）
- CLI stdout success（结果解析 + 文本替换 + 工具注入）
- CLI stdout malformed（parse error event，禁止静默 fallback）
- required hook missing（fail-fast）
- optional hook skipped（no-op event）
- multi-hook same phase（确定顺序 + 效果合并）
- direct/provider-direct negative（hook skeleton 不激活）

### 黑盒（必经之路）
- client in -> provider out -> provider in -> 响应端 hook intercept/schema/inject -> client `exec_command` -> client tool result -> 请求端结果解析/文本替换/工具注入 -> provider out
- backend followup/reenter：client in -> provider out -> provider in -> 响应端 followup 规划 -> reenter/clientInject/providerInvoke effect 由 TS IO shell 执行 -> post-followup governed truth -> 正常 client projection
- negative：same-protocol direct/provider-direct 不激活 servertool hook；internal metadata/debug carrier 永不进入 provider body / client normal response body。

## Required Fix Order

### Phase A：补强红 gate，证明 TS 活业务语义仍存在
- 新增 focused red gate，禁止：
  - `engine.ts` 重写 stopless mainline / timeout / followup orchestration
  - `server-side-tools.ts` 持有 `cliProjectedToolCall` 分支判定 / `auto hook queue` 编排
  - `execution-dispatch-outcome-shell.ts` 持有 tool-call execution outcome 主语义（仅允许 final-pass 桥接）
- 新增 hook-governed skeleton gate，禁止 TS：
  - 排序 / 必选 / schema 判定 / terminal 判定 / followup payload 构造 / 工具输出拼装
- gate 必须先红，再补修复。

### Phase B：收 `execution-dispatch-outcome-shell.ts`
- 当前状态：已基本完成。
- `execution-dispatch-outcome-shell.ts` 已退化为 re-export surface。
- `runServertoolIoExecutionQueue` / `materializeNativeToolCallExecutionOutcome` 已分别收口到 `execution-queue-shell.ts` / `execution-handler-materialization-shell.ts`；下一步不再以 `execution-dispatch-outcome-shell.ts` 为主战场。

### Phase C：收 `server-side-tools.ts`
- 当前状态：已基本完成。
- `server-side-tools.ts` / `server-side-tools-impl.ts` 已退化为 thin export/orchestration shell。
- `cliProjectedToolCall` 分支判定 / `auto hook queue` 编排 / `response-stage orchestration` 已拆到独立 shell 与 native consumer；后续只允许继续收薄，不再恢复聚合 owner。

### Phase D：再收 `engine.ts`
- 前提：Phase B / C 已基本完成，当前应作为主战场。
- 目标：`engine.ts` 退出 stopless orchestration mainline，把 stop gateway / timeout / selection / stopless action 继续下沉到 Rust owner 或更薄的 IO shell。
- 风险高、diff 散，必须继续按 focused red gate -> slice 下沉 -> focused Jest / blackbox / replay 顺序推进。

### Phase E：收 `registry-impl.ts`
- 目标：继续压缩 builtin/ad-hoc binding、auto-hook descriptor materialization、registration/lookup/projection glue，让 `registry.ts`/`registry-impl.ts` 只剩 native-plan consumer + test-only ad-hoc wiring。
- 需要同步收紧：
  - `tests/servertool/servertool-active-orchestration-audit.spec.ts`
  - `scripts/verify-servertool-rust-only.mjs`
  - `function-map` / `verification-map` owner surface

### Phase F：补 servertool backend-route 双端口黑盒
- 现有 stopless 双端口黑盒已成立，本阶段补 family 完整黑盒：
  - client in -> provider out -> provider in -> client out（servertool backend-route 全链）
- 验证矩阵参考 `tests/server/handlers/responses-handler.provider-outbound-reasoning.blackbox.spec.ts` 与 `tests/server/handlers/handler-request-executor.unified-semantics.e2e.spec.ts`。

### Phase G：gate 升级为 Rust-only closeout gate
- `verify-servertool-rust-only` 必须能拦：
  - `engine.ts` 退出主链
  - `server-side-tools.ts` / `server-side-tools-impl.ts` 保持薄壳
  - `execution-dispatch-outcome-shell.ts` 保持 re-export
  - `registry.ts` 仅 re-export
  - `registry-impl.ts` 不再承载第二套业务 owner
- 同步：
  - `docs/architecture/function-map.yml` / `verification-map.yml` / `mainline-call-map.yml` 与运行时 owner 对齐
  - 只有在 `servertool.hook_skeleton.mainline` 从 `binding pending` 切到 anchored、单元/黑盒/旧样本 replay 都绿时，才允许物理删除活业务语义 TS 文件。

## Risks / Anti-patterns
- TS 再补一层排序 / requiredness / schema / terminal 判定。
- 只跑 unit 就宣称上线闭环。
- 没旧样本 / live replay 就宣称 closeout。
- `binding pending` 还在时把 mainline / function-map 写成已实现。
- 用 `git checkout -- .` 等批量恢复命令清扫别的 worker 的工作树。
- 只看 `verify-servertool-rust-only` 单一 gate，忽略单元 + 黑盒 + 旧样本 replay 三类证据。

## Verification Matrix
- Rust focused：`cargo test -p servertool-core`、`cargo test -p router-hotpath-napi servertool --lib`。
- Native build：`node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`。
- TS focused Jest：`tests/servertool/*` 串行 `--runInBand`，先 audit spec 再 verify gates。
- 架构 gate：
  - `node scripts/verify-servertool-rust-only.mjs`
  - `npm run verify:function-map-compile-gate`
  - `npm run verify:architecture-mainline-call-map`
  - `npm run verify:architecture-mainline-manifest-sync`
  - `npm run verify:architecture-wiki-sync`
- Live replay：5555 `node scripts/tests/stopless-5555-live-probe.mjs`，必要时加 servertool backend-route 全链 probe。

## Skills / Wiki 同步要求
- 稳定执行顺序、切段法、debug 判别口径必须回写 `.agents/skills/rcc-dev-skills/references/22-servertool-hook-skeleton-workflow.md` 与 `23-servertool-hook-dev-debug-flow.md`。
- 反模式 / 失败判别回写 `references/92-lessons-2026-06.md`。
- raw 证据（probe 输出、log 行号、失败堆栈）只留 `note.md`。
- wiki review surface 必须包含 ASCII 主流程图、节点编号与 case matrix；machine-readable manifest 必须同步更新。

## DoD
- 上述 Phase A-F 全部完成。
- `servertool.hook_skeleton.mainline` 不再 `binding pending`。
- 单元测试 + 黑盒测试 + 旧样本 / live replay 全部 PASS。
- `docs/architecture/function-map.yml` / `verification-map.yml` / `mainline-call-map.yml` 与运行时 owner 对齐；machine-readable manifest 与 wiki 共用同一批节点 ID。
- 不再有“死 TS 业务语义”残留；剩余 TS 文件均为 native wrapper / bridge / IO shell。
- `note.md -> MEMORY.md -> lessons` 闭环写完。
