# RouteCodex V3 DAGPipe REQ02 交付落地执行（迭代增量版）

更新：2026-10-06 02:25 UTC（2026-10-05 19:25 PDT）。第 3 次修订（R49b 门禁审计后）。
owner：本目标编排者（fresh 接手，2026-10-05）。
基线：`origin/main = ec8048b6a13bf18684906e650a61085389eb4054`（PR346，比 PR343 前进 8 提交）。
当前候选：`af8e6a9c0`（R49 组合 + R49b 文件尺寸门禁修复；R49 组合提交 `812f4de1a`，父 `ec8048b6a`）。
范围：REQ02 `normalize_request_losslessly` 完整交付 + 另一 worker 的 Node02/REQ06 成果接手审计。
本文件是本轮开发交付的唯一落地执行载体；阶段结论同时追加到
`docs/goals/req02-main341-r43-notes-20261005.md`。

## 0. 为什么再次调整节奏

第 1 次修订把交付拆成 R48–R53 六轮。R48 组合 PR343 时暴露出 **2 个 R43 自身引入的回归**，
两者在 R43 父树（A）、R48 树（B）均复现、在干净 PR343 基线（P）均绿。R49 把候选前推到最新
main（#346）后两者仍复现，确认不是组合产物，而是 R43 缺陷。因此：

- 在「组合最新 main」与「R47 SSE 闭环」之间**插入一轮 R50 缺陷修复轮**，两个缺陷互不重叠、
  并发派 fresh worker，Lead 保留集成与验收。
- 缺陷不修完不进入 R47 SSE 闭环：否则 SSE 闭环的回归基线里混着两个已知红，无法判定新红归属。
- 每轮仍是「唯一入口条件 → 唯一退出条件 → 明确验收证据 → 不满足即停轮」。
- 并发只用于互不重叠的写范围（R50 两个 worker 各自独占 worktree），集成/review/merge 串行。

## 1. 目标边界

### 交付终点（不变）

REQ02 完整生命周期：唯一真实 caller 消费 `normalize_request_losslessly` 输出；
Direct SSE 成功 attempt 发布 + inverse 闭合；`gpt-5.5` / `gpt-5.6` 三类工具
（exec、native apply_patch、MCP）实际执行与 follow-up 回执；安装/官方 restart/
live 样本；独立架构 review PASS；clean-main merge + push + 远端回执；自有资源收口。

### 本轮显式非目标

- 不推进 REQ03 及以后任何生产接线。
- 不整分支合并旧 Node02/REQ06 树。
- 不恢复 local continuation，不复活 retired-continuation 拒绝逻辑。
- 不把 sandbox `EPERM` 失败当作 HTTP/SSE 行为通过。
- 不在共享 dirty 主树开发、合并或提交。
- 不用 `RUST_MIN_STACK` / tokio `thread_stack_size` / 断言放宽当作缺陷修复。

### 节奏

| 项 | 值 |
| --- | --- |
| 轮次 | R49 已收口；R50/R51/R51c →R55 |
| 生产接线 | 严格串行（R50 → R51 → R51c → R52 → R53 → R54 → R55；格式化必须晚于 R47 冻结补丁落地） |
| 并行 | 仅 R50 两个缺陷 worker（各自独占 worktree）；R52 内三路只读审计 |
| 每轮退出 | 唯一退出条件 + 落盘证据 |
| 停止 | 冲突 / hook 失败 / push 拒绝 / CI 失败 / 无授权 red assertion / 根因无法唯一归因 |

## 2. 增量轮次计划

### R48｜PR343 组合（已收口，BLOCKED 转出）

- 结论：namespace 碰撞（PR343 allocator × R43 内联 hash）4 文件收敛修复；
  `executors.rs` staged 增量漏装修复；`multi_listener_server` 红数 4 → 2。
- 退出：暴露 2 个 R43 自身红，判定为缺陷而非组合产物，转入 R49/R50。
- 证据：节点笔记 2026-10-05T10:10Z 条目。

### R49｜最新 main 组合与冲突收敛（已收口，候选 `812f4de1a`）

- 入口：`origin/main` 刷新到 `ec8048b6a`(#346)；R48 增量 `/tmp/r48-tracked.patch`
  （6.1M / 97037 行，untracked=0）。
- 动作：从 `ec8048b6a` 新建独占 worktree；`git apply --3way` 导入 R48 增量；
  收敛 10 个 UU 冲突 + 2 个静默自动合并损坏文件。
- 唯一 owner 收敛结论（写入本文件第 3 节硬约束）：
  - 保留 R43 `V3RelayRuntimeEntry`（origin / selected_target / expanded /
    request_local_excluded_candidates / observability_accumulator）。
  - `V3ResponsesRelayRuntimeSeeds` 收窄为 route_policy 两字段
    （`route_policy_pending` / `route_policy_scope`），删除与 Entry / 显式参数重复的
    `observability_accumulator` 与 `request_execution_control`。
  - `route_policy_pending` 作为独立参数 additive 回穿
    `execute_v3_relay_runtime_core` → `execute_v3_relay_runtime_resident`（保住 #345 修复）。
  - 保留 R43 `V3RequestExecutionControl::new` + `take_request_finalizer`；删除
    `from_manifest` fallback（不建 request_context，保留必编译失败）。
- 退出条件：冲突清零 + 两 crate 编译通过 + 候选提交 + 2 红在最新 main 上复现。
- 验收证据：候选 SHA `812f4de1a`；`routecodex-v3-runtime --lib` 1308/0 failed；
  `routecodex-v3-server --lib` 181/0 failed；`openai_chat_namespace_names` 1/0；
  `openai_chat_relay_runtime_integration` 45/0；`req02_scope_pretransport` 2/0；
  `req02_shared_relay_scope` 4/0；`req02_scope_runtime_consumer` 6/1（唯一红为父候选已知红）。
- 停止条件：冲突无法唯一归因 → 停在组合，报告 hunk 与 owner，不强推。

### R49b｜组合产物门禁审计（已收口，候选 `af8e6a9c0`）

- 动作：跑完整门禁，建立组合产品的红项台账。
- 已修：`verify:v3-file-size` 因 R49 组合把 `kernel.rs` 推到 1502 行（限 1500）而 FAILED。
  修复仅做搬移与死代码删除（编译器已报 unused 的 `use` 绑定；
  provider transport `pub use` 移入 `kernel/direct_request_entrypoints.rs` 这个
  `include!` 同模块 owner）。结果 kernel.rs 1497 行、门禁 ok、语义零变更、
  `verify:v3-mainline-caller-flow` PASS、runtime lib 1307/0 failed。
- 暴露的 BLOCKER（R43 自身遗留，转入 R51c）：CI `verify:ci` 的 `rustfmt` BLOCK 门禁红
  （候选 271 处 diff，上游 0、R43 还原树 269）。
- 记账项（转入 R52）：根 `verify:v3-clippy`（`-D warnings`）红 7 处 / 3 crate；
  CI 实际使用的 v3 变体不带 `-D warnings`，故不阻断 CI，但需消融或记录授权差异。
- 验收证据：`verify:v3-file-size` ok；`verify:v3-mainline-caller-flow` PASS；
  对照 `ec8048b6a`=0 / R48=269 的 rustfmt diff 计数。

### R50｜R43 回归缺陷修复（已派单，唯一允许并发的生产轮）

两个缺陷互不重叠、owner 不同文件、各自独占 worktree，基线均为 `812f4de1a`。

- 50a `[]`→200 边界回归（task-1，worker `req02-r49-http-boundary`）
  - worktree：`/Volumes/Intel/playground/routecodex/req02-r49-defect-http-boundary-20261005`；
    分支 `codex/req02-r49-defect-http-boundary-20261005`。
  - 验收：`multi_listener_server capture_node_preconnection_matches_responses_http_success_and_failure`
    → 1 passed / 0 failed；同用例合法请求半边保持绿。
  - 写范围：`v3/crates/routecodex-v3-server/src`；runtime 根因须先报 Lead。
- 50b continuation 首请求栈溢出（task-2，worker `req02-r49-continuation`）
  - worktree：`/Volumes/Intel/playground/routecodex/req02-r49-defect-continuation-recursion-20261005`；
    分支 `codex/req02-r49-defect-continuation-recursion-20261005`。
  - 验收：`multi_listener_server responses_direct_previous_response_id_is_rejected_after_continuation_removal`
    → 1 passed / 0 failed，且不设任何栈大小环境变量；SSE 兄弟用例保持绿；
    `multi_listener_server` 全量 90 passed / 1 failed，唯一红只能是 50a 未合并前的边界红，
    且无 stack overflow。
  - 写范围：runtime `kernel`/`operation_runner` + continuation 拒绝点；server `websocket.rs` 拒绝点。
- 合同与证据：`.worker-runs/req02-r49/<worker>/{worker-task.md,notes.md,result.md,owner.patch}`。
- 两者共同禁项：测试文件、namespace 4 文件、`executors.rs`、
  `docs/architecture/v3-architecture-audit-locks.yml`、commit/merge/push、install/restart、
  `pkill`/`killall`、`--no-verify`、批量 git 清理、脚本化语义替换、他人 worktree。
- 退出条件：两条修复在各自 worktree 达标并提交；Lead 集成到 R49 → 重跑定向套件 +
  `multi_listener_server` 全量 → 只剩 `req02_attempt_buffer_boundary_direct` 一个已知父红。
- 停止条件：任一 worker 无法证明根因、或以栈大小/断言放宽过关 → 该子项判 BLOCKED，不合并。
- **状态：R50 已达标（2026-10-06T04:00Z）**。两条修复提交于各自分支
  （`b84c2d587`、`82f671c1d`），Lead 先做 R49d 组合（见下），再 cherry-pick 为
  `e1a86c6d7` + `c9eb63f93`；三条冻结 oracle 在候选 `c9eb63f93` 上单独运行全绿。
  全量套件的真实红集由隔离单跑裁定（见 R52d 记账），不阻塞 R51 入口。

### R49d｜与最新 main 组合（2026-10-06T04:00Z，已完成）

- `origin/main` 从 `ec8048b6a` 推进到 `934ebe939`（PR #347/#348/#349），必须重新组合。
- 动作：merge（保留 R49/R49b/R49c 已验证提交）→ merge commit `d8b575bf8`；
  4 处冲突按"保留 R43 的 SOP 记录式拆分 + 采纳 upstream 新语义"处置；
  把 `relay_runtime_core.rs` 中重复的超时实现收敛到 upstream 唯一 owner `relay_runtime_shared.rs`。
- 副作用与应对：`kernel.rs` 因组合回到 1500 上限 → 按 SOP 做一次记录式拆分
  （`kernel/direct_request_scope.rs` 新增 `canonical_body_from_captured`），kernel.rs → 1492，
  为 R51 的 hook（kernel.rs +6）留出余量。
- 组合后新增红项（进 R51d/R51c）：`verify:v3-file-size` 两文件组合溢出；
  `chain:v3.provider_action_gate.mainline` 指纹出现第三个状态，需 Jason 人工授权（不得自改锁）。
- 退出条件：候选可编译；`verify:v3-mainline-caller-flow`、`verify:v3-dagpipe-governance` PASS；
  R47 两个冻结补丁在新树上 `git apply --check` 仍 exit 0；三条冻结 oracle 全绿。**已满足**。

### R51｜R47 SSE 闭环（红→绿，红项不放宽）

- 入口：R50 退出条件满足。
- 顺序（固定）：
  1. 先接 R47 HTTP 测试单文件（只新增
     `v3/crates/routecodex-v3-server/tests/req02_direct_sse_successful_inverse_r47.rs`）。
     R49 已核对：该单文件补丁与 7 文件 hook 补丁在组合候选上 `git apply --check` 均 exit 0。
     格式化提交后需重新核对一次；若不适用，按同一语义在格式化后的树上重建补丁并保留
     冻结稿 SHA256 记录（`4bd644f444a266c9a4db7874b44b6f7f632305aba3ad041408ca3fae69d5657f`）。
  2. 在**未接 hook** 的输入上运行，保留真实红（含 `req02_attempt_buffer_boundary_direct`）。
  3. 窄审七文件 hook 冻结稿（SHA256 `4bd644f444a266c9a4db7874b44b6f7f632305aba3ad041408ca3fae69d5657f`），
     重点：unknown siblings、custom envelope 完整值、delta/done 一致、同 attempt scope、
     无新 mapper/decoder、PR343 实际 emission 名称记录不被回退。
  4. 接收 hook，重跑 SSE consumer、scope consumer、`execution_control`；
     补 custom envelope 值保真的 HTTP 断言；CRLF fixture 或明确记录 LF 归一化。
- 退出条件：原红全部转绿（含 `req02_attempt_buffer_boundary_direct`），且未放宽任何原断言；
  `execution_control` 全绿。
- 停止条件：红 → 保留原错误、样本与失败输入，定位首次偏离，在唯一 owner 修复；
  禁止改断言、改成拒绝、silent passthrough 或 fallback。

### R51c｜CI 门禁归零（纯格式化 + 窄消融）

- 入口：R51 退出条件满足，且 R47 冻结 hook 补丁已原样落地（未重建）。
- **排序理由（实测）**：`cargo fmt --all` 会重排补丁上下文。在 `647b02b73` 的格式化副本上，
  R47 七文件 hook 补丁对 `direct_response_hooks.rs`、`hooks.rs`、`responses_relay_runtime.rs`
  的 `git apply --check` 失败；单文件 SSE HTTP 测试补丁仍适用。
  故格式化必须在 hook 原样落地之后，避免为适配格式重建并重审已冻结补丁。
- 动作（顺序固定）：
  1. 用仓库固定工具链（1.96.1）做一次**纯格式化提交**：`cd v3 && cargo fmt --all`。
     只允许格式差异。证明方式（`git diff -w` 对 rustfmt 重排无效，不作为证据）：
     在入口提交的 scratch 副本上独立执行同一 `cargo fmt --all`，逐文件比对产物哈希；
     两次产物逐字节相同，即证明该提交的每个字节都来自 rustfmt，而非人工改动。
  2. 重跑受影响套件（runtime lib、server lib、`multi_listener_server` 全量、
     R50 两条验收用例、R51 SSE/scope/execution_control）。
  3. 窄 clippy 消融：只处理本次增量新增的 clippy 项
     （`provider-compat-core/src/namespace_tools.rs` 的 type_complexity 与 ptr_arg）；
     上游既有的 `route-classifier`/`agent-memory` 项记录为记账项，不在本轮扩大范围。
     禁止用 `#[allow]` 批量压制代替修复；确需保留的写清理由与 owner。
     注意 CI 实际跑的是 v3 变体（无 `-D warnings`），根脚本更严；差异须落盘。
- 退出条件：`cd v3 && cargo fmt --all -- --check` = 0 diff；`v3/scripts/verify.mjs` 的
  `rustfmt` 与 `clippy`（按 v3 变体）子门禁 PASS；scratch 副本产物哈希逐字节一致；
  受影响套件全绿；`verify:v3-file-size` 仍 PASS。
- 基线数据：格式化实测使 `kernel.rs` 1497 → 1495，`field_operator_library.rs` 1500 → 1500，
  `endpoint_handlers.rs` 1493 → 1493，`responses_relay_runtime_inner.rs` 1486 → 1486；
  格式化副本上 `verify:v3-file-size` 仍 ok。
- 停止条件：格式化提交出现无法归因于 rustfmt 的差异 → 停止，逐文件回退并归因，禁止整棵回滚。

### R51d｜组合溢出文件的拆解（file-size 归零）

- 入口：R51c 的格式化提交已完成（拆解不得与格式化混在同一提交，否则无法归因）。
- 背景（实测）：组合后 `verify:v3-file-size` 红于两文件 ——
  `hub_v1/anthropic_relay_runtime.rs` **1506**、`hub_v1/responses_relay_runtime_inner.rs` **1503**。
  两侧单独都不超（R43 侧 1489/1486，upstream 侧 1411/1456），属**组合**溢出；
  连带 `test:v3-file-size-red-fixtures` 红（其 green 用例跑真实策略）。
- 动作：按 `v3-module-decomposition-sop.md` 做 scoped split，并在该 SOP 头部登记 "Scoped split"；
  只移动语义完整的块，保留函数体与 crate 可见调用路径；同步更新
  `v3-mainline-call-map.yml` / `v3-function-map.yml` / `v3-verification-map.yml` 中对应 file 锚点
  （两文件在 call map 中有 39 处 file 锚点，逐个核对；禁止批量文本替换）。
- 退出条件：`verify:v3-file-size` PASS；`test:v3-file-size-red-fixtures` PASS；
  `verify:v3-mainline-caller-flow` PASS（锚点与源一致）；受影响套件重跑全绿。
- 停止条件：锚点漂移无法在不改锁的前提下同步 → 保留现状、记录缺口、上报，不删校验。

### R52｜依赖收敛 + 架构绑定（只读并行轮）

三路只读审计并行，互不写同一文件；结论由 Lead 收口后统一改文件。

- 52a REQ06 最小公共 helper 审计：`project_canonical_request(...) -> CanonicalRequestProjection`
  （已按 R52a 审计把合同里的 `ProjectedRequest` 更正为交付实现真名，见 `52e`）；
  核对唯一类型（`V3RequestContextHandle`、`ToolDeclarationReference`、`AttemptContext`、
  `ToolMappingReference`、`ResponseProjectionView::from_successful_attempt`）、数据/控制分离、
  registered Direct hook 仍是 Direct payload 改写唯一 owner。
- 52b 旧树合同差异审计：`reject_retired_responses_continuation` 与当前入口/profile 的
  remote continuation 契约；平行 request context store / field profile / public runner API 收敛。
- 52c map 与 gate 绑定：SSE caller/resource/verification 绑定补齐；canonical renderer →
  admission compile；受影响 gates → 完整 `architecture-ci`。
- 52d 完整 CI 红项清单：跑一次 `v3/scripts/verify.mjs`（CI `verify:ci` 的 BLOCK 门禁集：
  rustfmt / clippy / isolation / admission / distribution / install-cleanup / architecture-ci /
  artifact-budget），把红项逐个归因（R43 引入 / 上游既有 / 组合引入）并清零或记录授权差异；
  push 前该集合必须无 R43 引入项。
- 52e 审计裁决落地（R52a/R52b 已提前完成，审计 SHA `c534cd3bf`）：
  1. A0 命名漂移 → 更新 REQ06 交接文档签名段（以代码为真源），不改公开类型名。
  2. A4 协议锁重复（`direct_request_scope.rs:86` / `hooks.rs:403`）→ 收敛到唯一 owner，
     落地后重跑四协议无损恒等回归 + namespace 套件。
  3. B1.3 两个 continuation 守卫（`direct_protocol_plan.rs:20-31` / `kernel.rs:152-166`）→
     核实是否同条件同后果：是则收敛，否则记录为不同入口的不同可见错误。
  4. B3 legacy `tables/*.json` → 既有分工，manifest 已声明 `production_baseline_authority`，仅 advisory。
- 退出条件：三路结论落盘；绑定准确；admission compile exit0；完整 `architecture-ci` PASS
  （R49b 已实测 40/40 全绿，优于 R45 基线 39/40；R50/R51/R51c 改动后须重跑维持）；
  52d 清单落盘且无 R43 引入的未授权红项。
- 停止条件：固定锁漂移且无授权 → 保留锁，记录缺口，不修改锁规避。

### R53-R｜R43 引入的 5 项回归（并发 3 路，2026-10-06T04:35Z 新增）

- 触发：隔离单跑候选 `c9eb63f93` 的 `multi_listener_server` 全量（93 用例，各自独立进程，
  `--test-threads=1`，`timeout 150`）得 **88 ok / 4 FAILED / 1 HANG**；
  同 5 项在 R43 前基线 worktree `req02-baseline-ec8048b6a-20261005`（detached `ec8048b6a`）**全部 ok**。
  ⇒ 判定为 **R43/REQ02 引入的回归**，不得记为"既有红"。
- 聚类（**已修正为 2 个根因**；原 C 类经 task-6 证明并入 B 类）：
  - A｜custom-tool 身份：`responses_relay_apply_patch_feedback_preserves_client_output_two_turns`
    + R47 套件剩余 3 红（`expected custom_tool_call, got function_call`）→ `task-4`
    / worker `req02-r53-tool-identity`。
  - B｜**Relay→Direct** handoff 重归一（缺反向 typed origin 边）：
    `responses_relay_anthropic_dsml_failure_reselects_valid_provider`、
    `responses_relay_websocket_consumes_direct_handoff_instead_of_projecting_null`、
    `responses_relay_direct_handoff_commits_route_policy_history_for_next_request`（HANG）、
    `responses_inbound_websocket_rejects_second_previous_response_id_without_provider_send`
    （失败发生在第一回合，第二回合拒绝逻辑按构造即正确）
    → `task-5`（**只读**设计闭环 + 独立 review）+ `task-6`（实现，**设计 review PASS 前不落地**）。
    首次偏离：`build_v3_direct_request_canonical_from_captured` 硬编码
    `RequestOriginKind::ClientEntry`（`kernel/direct_request_scope.rs:46`），
    而 pair 已由 Relay 入口发布（`hub_v1/responses_relay_runtime_inner.rs:100-105`）
    并经 typed `protocol_direct_handoff`（同文件 `:260-318`）回灌 Direct kernel
    （`server/src/websocket.rs:424-452`）。
    依据：合同 `docs/design/v3-req02-cutover-consumer-contract.md:44-51`
    明确要求该节编码准入等待独立设计审查。
- 退出条件：A 类在各自 worktree 达标并提交，Lead 集成后对应用例转绿且原断言未放宽；
  B 类先出设计 review PASS，再由 task-6 落地实现并给出同等测试证据。
- 停止条件：任一红项无法定位唯一 owner，或需靠放宽断言/栈大小/绕过守卫过关 → 判 BLOCKED 并上报。
- 记账：本轮 5 红替代原先"只剩 `req02_attempt_buffer_boundary_direct` 一个父红"的假设；
  `req02_scope_runtime_consumer` 的父红仍需在同一基线上重新核对，避免同类误判。

### R53｜精确候选作者验证

- 入口：R50–R52 全部退出条件满足。
- 动作：形成可追溯候选 commit（不绕 hook）；从该精确候选构建产物；
  隔离真实入口验证 HTTP/WebSocket、JSON/SSE、Direct/Relay，覆盖成功/失败/取消/EOF/Drop/断连。
- GCM 两模型：`tests/blackbox/req02-tools/run-gcm-consumer.mjs`，`gpt-5.5` 与 `gpt-5.6`
  各一套完整回合；fresh worker，独立 `CODEX_HOME`；不使用父 session resume/fork。
- 通过条件：exec 完整多行命令 + 正确 cwd + exit0 + 尾输出 sentinel；
  native apply_patch Add→Update 与文件内容匹配；MCP server/tool/arguments 匹配、
  完整结果保存、follow-up 消费指定 pointer；call/item IDs 与配对正确；原命令、patch、结果无截断。
- 停止条件：任一工具类不通过 → R53 未完成，不进入 R54。

### R54｜安装、live 与独立架构 review

- 入口：R53 全部通过。
- 动作：安装候选到实际位置 → 官方 `rccv3 restart`（4444 单次，执行前说明短暂中断；
  禁止 stop+start、start --restart、broad kill）→ 核对 health / loaded binary 身份 /
  同入口回放 / 样本。
- 之后启动独立实现架构 review：milestone `oauth` + 明确 `gpt-6.1-sol`；作者与 reviewer 独立；
  绑定冻结候选 SHA。
- 退出条件：live 证据齐备 + review PASS。
- 停止条件：review 发现行为缺陷 → 退回作者修复，重跑受影响项，再审新候选。

### R55｜集成、推送与收口

- 入口：R54 PASS。
- 动作：merge 前复查 `origin/main`；有新提交则组合、重验受影响项、按需复审；
  合并 clean main → 核对本地 main 与已验候选等价 → push → 核对远端回执；
  合并版 runtime/live 确认；仅回收本目标创建且确认无用的资源。
- 退出条件：远端回执 + live 确认 + 自有资源清单为 0。
- 之后才进入 REQ03；每节点重复本执行结构，不复制全部旧日志。

## 3. 跨轮硬约束

1. 保护共享 dirty 主树与全部未验候选；不得删除或改写 Parent / Req06 / R47 树与 worker 树。
2. 只在最新 `origin/main` 的独立外置 worktree 开发；每次重构、构建、merge 前刷新。
3. 组合其他 worktree 已合并修复，不整批 merge 旧分支。
4. **单一 owner**：同一语义只能有一个承载者。R49 收敛结论：
   - Relay entry 承载 = `V3RelayRuntimeEntry`（origin / target / expanded / excluded / observability）。
   - route-policy 承载 = `V3ResponsesRelayRuntimeSeeds`（仅 `route_policy_pending` / `route_policy_scope`）
     + core/resident 的显式 `route_policy_pending` 参数。
   - 请求作用域 = `V3RequestExecutionControl::new` + `take_request_finalizer`；
     禁止再用 `from_manifest` 兜底（它不建 request_context）。
   - namespace wire alias 唯一 owner = allocator + 单一声明发射点；禁止第二处内联 hash。
5. 黑盒证据从真实入口断言外部可观察结果；单测、候选产物、health 不能替代。
6. 唯一 owner：Relay payload 改写只在 Chat Process；Direct payload 改写只在 registered
   Direct hook；Outbound 做标准投影；Compat 只做 provider-private 调整。
7. 工具逆映射只用原请求声明 + 本次成功 attempt 实际发出的工具列表；不按 model、name、
   schema 猜；不解析业务参数猜身份。
8. payload 与 typed control 物理隔离；不镜像到 MetadataCenter control slots。
9. 错误进 Error 链；不静默失败、不伪造成功、不直接投影 provider 错误到客户端。
10. 每阶段结论立即落盘节点笔记；有效证据复用，只在绑定输入变化时重跑。
11. 新 worktree 需软链共享 `node_modules`（本仓既有约定
    `req02-main340-combined-r27-20261005/node_modules`），否则 pre-commit `verify:fast`
    因缺 `typescript` 失败；`node_modules` 已被 git 忽略。
12. 禁止用栈大小、线程栈大小、断言放宽、`--no-verify` 或绕过 gate 让红项变绿。

## 4. 资源与停止规则

- 只回收本目标创建且确认不再需要的 worktree、child、`CODEX_HOME`、临时产物。
- dirty worktree remove 失败 → 保留并报告 owner / path / 原因，标未收口，不强删。
- 冲突、push 拒绝、CI 失败 → 停止受影响集成并报告，不强推、不绕 hook。
- 4444 仅官方 restart，执行前说明中断。

## 5. 关键输入索引

| 短名 | 路径 |
| --- | --- |
| Handoff | `/Volumes/Intel/playground/routecodex/.worker-runs/dagpipe-full-handoff-20261005/handoff.md` |
| R49 候选树 | `/Volumes/Intel/playground/routecodex/req02-main346-combined-r49-20261005`（`812f4de1a`） |
| Parent（R43，冻结输入） | `/Volumes/Intel/playground/routecodex/req02-main341-combined-r43-20261005` |
| P 基线（PR343 干净） | `/tmp/rc-pr343-base`（`eb77dc9b9`，有热 target） |
| Req06（旧 Node02） | `/Volumes/Intel/playground/routecodex/dagpipe-node02-runtime-gcm-20260930` |
| R50 worker 合同/证据 | `/Volumes/Intel/playground/routecodex/.worker-runs/req02-r49/{http-boundary,continuation-recursion}/` |
| R47 hook 冻结稿 | `/Volumes/Intel/playground/routecodex/.worker-runs/req02-r47/sse-hook/{owner.patch,result.md,notes.md}` |
| R47 HTTP 冻结稿 | `/Volumes/Intel/playground/routecodex/.worker-runs/req02-r47/sse-http/{owner.patch,result.md,notes.md}` |
| R46 runtime 收口 | `/Volumes/Intel/playground/routecodex/.worker-runs/main-refresh-runtime-20261005-r46/notes.md` |
| 节点笔记 | `docs/goals/req02-main341-r43-notes-20261005.md` |
| GCM 工具 harness | `tests/blackbox/req02-tools/run-gcm-consumer.mjs` |

已知红项台账（截至 R49 收口）：

| 红项 | 归属 | 处置 |
| --- | --- | --- |
| `multi_listener_server::capture_node_preconnection_matches_responses_http_success_and_failure` | R43 回归 | R50 50a 修复 |
| `multi_listener_server::responses_direct_previous_response_id_is_rejected_after_continuation_removal` | R43 回归 | R50 50b 修复 |
| 同上的 SSE 兄弟用例（原合同误判为绿） | R43 回归（同 owner） | R50 50b 一并修复 |
| `req02_scope_runtime_consumer::req02_attempt_buffer_boundary_direct` | 父候选（R47 已知红） | R51 随 R47 SSE 闭环修复 |
| `verify:v3-file-size`（`kernel.rs` 1502>1500） | R49 组合引入 | R49b 已修（`af8e6a9c0`，1497 行） |
| `rustfmt`（CI BLOCK 门禁，候选 271 处 diff） | R43 引入（上游 0 / R48 269） | R51c 纯格式化归零（须晚于 R47 冻结补丁落地） |
| 根 `verify:v3-clippy`（`-D warnings`，7 处 / 3 crate） | `namespace_tools.rs` 属 R43；其余上游既有 | R51c 窄消融增量项；上游项记账 |
| `verify:v3-mainline-caller-flow` audit lock 漂移 | R45 基线 | R49 复测已 PASS；R52 记录 |
| CI 其余 BLOCK 门禁（isolation/admission/distribution/install-cleanup/artifact-budget） | 待定 | R52 52d 全量归因 |

**已知红项台账（2026-10-06 R52d 全量重扫，候选 `d38a5d3cd`）** —— 上表"只剩 1 个父红"的假设已被推翻：

| 红项 | 归属（基线对照证据） | 处置 |
| --- | --- | --- |
| `multi_listener_server` 4 FAILED + 1 HANG | R43 回归（`ec8048b6a` 全绿） | **已修**：task-6（`bc7d1b8d8`）+ task-4（`0cdf41884`）⇒ 93/93 全绿 |
| `anthropic_relay_runtime_integration` 2 FAILED | R43 回归（`ec8048b6a` 18/0，`dbdf06181` 16/2） | task-7 |
| `anthropic_relay_anthropic_provider_wire_integration` 1 FAILED | R43 回归（同 crate 同区域） | task-7 |
| `cli h2_p6_controlled_replay` 1 FAILED（缺 `response.created` 帧） | R43/R47 hook 回归（`ec8048b6a` 与 `dbdf06181` 均 7/0） | **已修**：task-8（`9af5766a8`）⇒ 7/0 |
| `gemini_relay_runtime_integration` 4 FAILED | R43 回归（`ec8048b6a` 21/0） | task-10 |
| `hub_relay_runtime_closeout` 4 FAILED | R43 回归（`ec8048b6a` 28/0） | task-11 |
| `responses_relay_mode_b_web_search_integration` 1 FAILED + HANG | R43 回归（`ec8048b6a` 4/0） | task-12 |
| `responses_relay_anthropic_provider_wire_integration` 3 FAILED | R43 回归（`ec8048b6a` 17/0） | task-13 |
| `req02_direct_request_view` 1 FAILED | REQ02 自建红测（基线无此文件） | task-14 |
| `req02_scope_runtime_consumer::req02_attempt_buffer_boundary_direct` | ~~父候选已知红~~ **实测 7/7 全绿** | 已关闭，记账删除 |
| `verify:v3-file-size` `anthropic_relay_runtime.rs` 1506 | 组合引入 | R51d 已修（`d38a5d3cd`，1414 行） |
| `verify:v3-file-size` `responses_relay_runtime_inner.rs` 1504 | 组合引入 | **已修**：task-9（`579409616`，646 行）⇒ 门禁 EXIT 0 |
| `chain:v3.provider_action_gate.mainline` 指纹第三状态 | 组合引入 | **已授权刷新**（`3ebcc381b`，562460de…，auth-20261006-…）；caller-flow EXIT 0 |
| `v3-mainline-caller-flow.html` 陈旧（495 vs 499 边） | 组合引入 | **已重渲染**并 commit；caller-flow EXIT 0 |

扫描口径：逐 crate `npm --prefix v3 run test`（`--test-threads=1`，skip 已知挂起用例）；
**cargo 在首个失败 target 后停止**，故另跑逐 target 重扫补全（`/tmp/v3-target-sweep.txt`）。
15/18 crate 全绿；`routecodex-v3-runtime --lib` 1308 passed / 0 failed。

R47 作者结果仅在 sandbox（loopback bind EPERM）中运行，Lead 须在允许 loopback 的环境重跑。
