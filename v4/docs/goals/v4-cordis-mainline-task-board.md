# V4 Cordis 主线并发任务表

状态：`active`

每个 milestone 的独立 claim 表见 `v4/docs/goals/v4-cordis-mainline-milestone-task-tables.md`；本文件保留详细任务内容、门禁和合并记录。

## 主树合同

- V4 重构集成主树：branch `codex/v4-cordis-refactor-main`。
- 主树 worktree：`/Users/fanzhang/Documents/github/routecodex/playground/v4-cordis-refactor-main-20260826T043500Z`。
- 基线：`5b7116574cc08e9d581a20f52bf72e446e1b3dfa`。
- 所有独立任务必须从当前主树 HEAD 创建自己的 `./playground/<task-id>-<run-id>/` worktree。
- worker 不得直接写主树；任务完成后提交 task branch，写 evidence/handoff，checker 只把声明 change set 合并到本主树。
- 本主树每次合并后必须跑受影响 gate；主树验证通过后才允许下一个依赖任务 claim。
- milestone 完成时，主树整体精确合并到仓库 `main`，在仓库 `main` 复验；之后主树同步新的 `main` 再开下一 milestone。
- task board 是 claim 入口；状态只允许 `available → claimed → in_progress → ready_for_merge → merged`，失败走 `blocked`，不静默跳状态。

## Claim 协议

1. worker 先读本表、当前主树 HEAD、`.agent-collab/PROTOCOL.md`、maps 和 required gates。
2. 按 `claim_id` 原子创建 `.agent-collab/claims/<claim_id>/`；已存在则不得抢占，先读 owner/handoff。
3. owner.json 必须记录 task、semantic claim、worker run、task worktree、branch、base main-tree commit、allowed paths。
4. 只在 task worktree 完成 red → implementation → boundary self-check → tests/build/live（如适用）。
5. checker 检查 task diff 不越界、不夹带 dirty、证据完整、主树基线未漂移后，才合并到 `codex/v4-cordis-refactor-main`。
6. 合并后更新本表状态、merge commit、主树验证证据；依赖任务读取最新主树 HEAD 后再 claim。

## M00：架构冻结与接线准备

| task_id | claim_id | 内容 | 允许路径 | 依赖 | 状态 | merge target |
|---|---|---|---|---|---|---|
| M00-T00 | `feature_id:v4.cordis_m00.migration_plan` | 将 M00→M12 唯一迁移计划纳入 V4 主树并闭合 canonical doc 引用 | `v4/docs/goals/**` | 无 | `merged` (`cf1bfab26`, main-tree merge `3b62ffd9a`) | `codex/v4-cordis-refactor-main` |
| M00-T01 | `feature_id:v4.cordis_m00.contracts` | ADR、ExecutionEpochBundle、NativePluginCatalog、Control、NodeOutcome 合同 | `v4/contracts/**`, `v4/docs/architecture/v4-cordis-mainline-adr.md` | 无 | `merged` (`9f4577081`, main-tree merge `aaf8b1f39`) | `codex/v4-cordis-refactor-main` |
| M00-T02 | `feature_id:v4.cordis_m00.ratchet_gate` | bypass ratchet 正反测试与 canonical gate 接线；先处理 protected projection promotion | `v4/scripts/architecture/**`, `v4/scripts/_gate-matrix.mjs`, `v4/package.json`, V4 maps | M00-T01 | `merged` (`faab92ff8`, main-tree merge `70bf0bda2`; live gate remains blocked by upstream HTTP 502 baseline) | `codex/v4-cordis-refactor-main` |
| M00-T03 | `feature_id:v4.cordis_m00.audit_surfaces` | 全局审计 checklist、依赖进度表、task board 与 wiki/manifest 回链 | `v4/docs/goals/**`, `v4/docs/architecture/**` | M00-T01 | `merged` (`de31399d6`, main-tree merge `c4d13d7b8`) | `codex/v4-cordis-refactor-main` |
| M00-T04 | `feature_id:v4.cordis_m00.stage_task_tables` | 每个 milestone 独立 claim task table，并同步 checklist/progress 状态 | `v4/docs/goals/**` | M00-T03 | `merged` (`55faef2ee`, main-tree merge `5e0090f9d`) | `codex/v4-cordis-refactor-main` |
| M00-T05 | `feature_id:v4.cordis_m00.live_admission_closeout` | provider/live admission A/B/C closeout；必须保留真实 provider continuation 语义 | V4 live/provider evidence paths | M00-T02 + M00-T04 | `blocked_by_provider_websocket_v2_endpoint`（最新 recheck 另见 provider `401 invalid_api_key`） | `codex/v4-cordis-refactor-main` |
| M00-T06 | `resource_id:v4.error.raw_wire_evidence` | canonical provider request/response diagnostic evidence contract | `v4/crates/routecodex-v4-server/**`, V4 maps/contracts | M00-T01 + M00-T03 | `merged` (`0bcd0e3ff`, main-tree merge `9f9ebc25d`) | `codex/v4-cordis-refactor-main` |
| M00-T07 | `feature_id:v4.cordis_m00.live_capture_binding` | 只绑定未来 live transport 的真实 provider-bound/raw evidence owner；无合法 owner/binding fail-closed；不实现 M08 runtime、不伪造 B 证据 | V4 provider contract + maps/gates/progress surfaces | M00-T06 | `merged` (`70ccc287b`, V4 main-tree merge `3bec92d81`) | `codex/v4-cordis-refactor-main` |
| M00-T08 | `feature_id:v4.cordis_m00.dependency_reconciliation` | 拆分 T07 evidence-owner contract 与 M08 async/native transport runtime，消除 M00/M08 循环依赖 | `v4/docs/goals/**` | M00-T01 + M00-T03 + M00-T04 | `merged` (`764351194`, main-tree merge `0f353bee8`) | `codex/v4-cordis-refactor-main` |
| M00-T09 | `feature_id:v4.cordis_m00.empty_epoch_admission` | 无 active epoch 时 fail-closed admission 与正反测试 | `v4/crates/routecodex-v4-node-container/**`, V4 maps/evidence | M00-T01 + M00-T02 | `merged` (`23220dceb`, main-tree merge `4298257666`) | `codex/v4-cordis-refactor-main` |

M00 结构出口：T00/T01/T02/T03/T04/T06/T07/T09 都完成并合并主树；T05 live provider admission 保留为独立 blocker，不得用 fallback 或伪造证据解除，也不得阻塞不依赖其运行时语义的 M01/M03/D0/M08。M00 全局 release/cutover 仍需 T05 解除；合同/map/wiki/manifest/gate 与独立 task tables 同步。

## M01-M05：Cordis 控制面与唯一执行器

| task_id | claim_id | 内容 | 依赖 | 状态 | merge target |
|---|---|---|---|---|---|
| M01-T01 | `feature_id:v4.native_plugin_abi` | NativePlugin、Resolver、Config、Outcome/Failure、catalog exporter | M00 structural contracts | `merged` (`7c7e141f5`, main-tree merge `100b9fd12`) | refactor main |
| M02-T01 | `feature_id:v4.cordis_generic_factory` | canonical catalog → generic Cordis factory → Fiber mount/dispose | M01 | `available` (M01 merged and main-tree verified) | refactor main |
| M03-T01 | `feature_id:v4.cordis_host_daemon` | child daemon、handshake、socket、heartbeat、generation、reconcile | M00 structural contracts | `available` (T05 独立 blocker 不传播) | refactor main |
| M04-T01 | `feature_id:v4.execution_epoch_transaction` | prepare/commit/abort/drain/rollback、stale/hash/idempotency | M02 + M03 | `blocked` | refactor main |
| M05-T01 | `feature_id:v4.execution_engine` | 唯一 ExecutionEngine、真实 NodeOutcome 链、删除第二 graph/registry | M04 | `blocked` | refactor main |

M01 与 M03 可并行；M02 等 M01；M04 等 M02+M03；M05 等 M04。

## M06-M10：数据面与状态语义

| task_id | claim_id | 内容 | 依赖 | 状态 | merge target |
|---|---|---|---|---|---|
| D0-T01 | `feature_id:v4.differential_harness` | old/new wire 与 raw response differential，不重复 provider 请求 | M00 structural contracts | `in_progress` (T05 独立 blocker 不传播) | refactor main |
| M06-T01 | `feature_id:v4.responses_request_mainline` | Responses JSON request chain takeover | M05 | `blocked` | refactor main |
| M07-T01 | `feature_id:v4.responses_response_mainline` | Responses JSON response chain takeover | M06 | `blocked` | refactor main |
| M08-T01 | `feature_id:v4.async_data_plane` | async server、native provider transport、cancel/deadline/buffer，并接入 M00-T07 已冻结的 live evidence owner | M00 structural contracts + M00-T07 | `available` (T05 live admission 独立阻塞) | refactor main |
| M09-T01 | `feature_id:v4.sse_mainline` | SSE parser → response pipeline → frame writer，zero per-frame IPC | M07 + M08 | `blocked` | refactor main |
| M10-T01 | `feature_id:v4.state_semantics` | Router/Error/Health/Continuation typed owner 接管 | M09 | `blocked` | refactor main |

D0、M08 在 M00 完成后可与 M01-M07 并行；M09 必须等 M07+M08；M10 等 M09。

## M11-M12：产品接入与 release

| task_id | claim_id | 内容 | 依赖 | 状态 | merge target |
|---|---|---|---|---|---|
| M11-T01 | `feature_id:v4.protocols` | Chat/Anthropic/Gemini/WebSocket codec plans | M10 | `blocked` | refactor main |
| M11-T02 | `feature_id:v4.tools_admin` | function/custom/web-search/servertool/stopless/Admin | M10 | `blocked` | refactor main |
| M12-T01 | `feature_id:v4.parity_release` | 全矩阵 differential/live、canary/drain/rollback/release | M11-T01 + M11-T02 + D0 | `blocked` | refactor main |

M11-T01/T02 可并行；M12 等二者和 D0。

## 主树合并记录

| task_id | task HEAD | merge commit | main-tree verification | status |
|---|---|---|---|---|
| M00-T01 | `9f4577081` | `aaf8b1f39` | targeted Cordis/resource/plane/node gates passed | merged |
| M00-T03 | `de31399d6` | `c4d13d7b8` | markdown scope/diff check passed; main-tree files present | merged |
| M00-T04 | `55faef2ee` | `5e0090f9d` | per-milestone table count=14; markdown diff check passed; main-tree files present | merged |
| M00-T02 | `faab92ff8` | `70bf0bda2` | source/architecture gates passed; canonical live admission failed on 5 upstream HTTP 502 cases | merged; M00 exit pending |

## 禁止事项

- 不得把主树当 worker worktree 直接编辑。
- 不得从旧 task branch 或旧主树 commit 开依赖任务。
- 不得跳过 checker、evidence、main-tree post-merge verify。
- 不得因并行而共享同一 semantic claim 或同一 task worktree。
- 不得用 fallback、silent strip、payload cleanup 或 V3 单请求 fallback 隐藏迁移缺陷。
