# V4 Cordis 主线 Milestone 独立任务表

状态：`active`。本文件是 worker claim 入口；所有 task 的 merge target 固定为 `codex/v4-cordis-refactor-main`。

## Claim 与合并合同

- 每一行是一个独立 semantic claim；worker 只能 claim 自己的一行。
- 每个 task 必须从当前 V4 重构主树 HEAD 新建独立 branch/worktree，完成 red → implementation → boundary self-check → required gates → evidence。
- task 通过后先进入 merge queue，由 checker 精确合并到 V4 重构主树；主树合并后跑受影响 gate。
- milestone 只有在本 milestone 的所有 task 合并并通过主树复验后，才允许把 V4 重构主树整体合并仓库 `main`；main 复验并同步回重构主树后，才开放下一个依赖 milestone。
- `blocked` 不得被 worker 自行改成 `available`；依赖由主树 merge receipt 和复验事实解除。

## M00 — 架构冻结与接线准备

| task_id | claim_id | 依赖 | 状态 | merge target |
|---|---|---|---|---|
| M00-T00 | `feature_id:v4.cordis_m00.migration_plan` | 无 | merged (`3b62ffd9a`) | `codex/v4-cordis-refactor-main` |
| M00-T01 | `feature_id:v4.cordis_m00.contracts` | 无 | merged | `codex/v4-cordis-refactor-main` |
| M00-T02 | `feature_id:v4.cordis_m00.ratchet_gate` | T01 | merged (`70bf0bda2`) | `codex/v4-cordis-refactor-main` |
| M00-T03 | `feature_id:v4.cordis_m00.audit_surfaces` | T01 | merged | `codex/v4-cordis-refactor-main` |
| M00-T04 | `feature_id:v4.cordis_m00.stage_task_tables` | T03 | merged (`55faef2ee`, main-tree merge `5e0090f9d`) | `codex/v4-cordis-refactor-main` |
| M00-T05 | `feature_id:v4.cordis_m00.live_admission_closeout` | T02 + T04 | blocked_by_provider_websocket_v2_endpoint | `codex/v4-cordis-refactor-main` |
| M00-T06 | `resource_id:v4.error.raw_wire_evidence` | T01 + T03 | merged (`0bcd0e3ff`, main-tree merge `9f9ebc25d`) | `codex/v4-cordis-refactor-main` |
| M00-T07 | `feature_id:v4.cordis_m00.live_capture_binding` | T06 | merged (`70ccc287b`, V4 main-tree merge `3bec92d81`) | `codex/v4-cordis-refactor-main` |
| M00-T08 | `feature_id:v4.cordis_m00.dependency_reconciliation` | T01 + T03 + T04 | merged (`764351194`, main-tree merge `0f353bee8`) | `codex/v4-cordis-refactor-main` |
| M00-T09 | `feature_id:v4.cordis_m00.empty_epoch_admission` | T01 + T02 | merged (`23220dceb`, main-tree merge `4298257666`) | `codex/v4-cordis-refactor-main` |

## M01 — NativePlugin ABI

| task_id | claim_id | 依赖 | 状态 | merge target |
|---|---|---|---|---|
| M01-T01 | `feature_id:v4.native_plugin_abi` | M00 structural contracts | merged (`7c7e141f5`, main-tree merge `100b9fd12`; post-merge gates passed) | `codex/v4-cordis-refactor-main` |

## M02 — Generic Cordis Factory

| task_id | claim_id | 依赖 | 状态 | merge target |
|---|---|---|---|---|
| M02-T01 | `feature_id:v4.cordis_generic_factory` | M01 | available (M01 merged and main-tree verified) | `codex/v4-cordis-refactor-main` |

## M03 — Cordis Host Daemon

| task_id | claim_id | 依赖 | 状态 | merge target |
|---|---|---|---|---|
| M03-T01 | `feature_id:v4.cordis_host_daemon` | M00 structural contracts | available (T05 live admission is independent) | `codex/v4-cordis-refactor-main` |

## M04 — Execution Epoch Transaction

| task_id | claim_id | 依赖 | 状态 | merge target |
|---|---|---|---|---|
| M04-T01 | `feature_id:v4.execution_epoch_transaction` | M02 + M03 | blocked | `codex/v4-cordis-refactor-main` |

## M05 — 唯一 ExecutionEngine

| task_id | claim_id | 依赖 | 状态 | merge target |
|---|---|---|---|---|
| M05-T01 | `feature_id:v4.execution_engine` | M04 | blocked | `codex/v4-cordis-refactor-main` |

## M06 — Responses Request 主线

| task_id | claim_id | 依赖 | 状态 | merge target |
|---|---|---|---|---|
| M06-T01 | `feature_id:v4.responses_request_mainline` | M05 | blocked | `codex/v4-cordis-refactor-main` |

## M07 — Responses Response 主线

| task_id | claim_id | 依赖 | 状态 | merge target |
|---|---|---|---|---|
| M07-T01 | `feature_id:v4.responses_response_mainline` | M06 | blocked | `codex/v4-cordis-refactor-main` |

## M08 — Async Data Plane

| task_id | claim_id | 依赖 | 状态 | merge target |
|---|---|---|---|---|
| M08-T01 | `feature_id:v4.async_data_plane` | M00 | blocked_by_M00 | `codex/v4-cordis-refactor-main` |

## M09 — SSE 主线

| task_id | claim_id | 依赖 | 状态 | merge target |
|---|---|---|---|---|
| M09-T01 | `feature_id:v4.sse_mainline` | M07 + M08 | blocked | `codex/v4-cordis-refactor-main` |

## M10 — State Semantics

| task_id | claim_id | 依赖 | 状态 | merge target |
|---|---|---|---|---|
| M10-T01 | `feature_id:v4.state_semantics` | M09 | blocked | `codex/v4-cordis-refactor-main` |

## M11 — Protocols / Tools / Admin

| task_id | claim_id | 依赖 | 状态 | merge target |
|---|---|---|---|---|
| M11-T01 | `feature_id:v4.protocols` | M10 | blocked | `codex/v4-cordis-refactor-main` |
| M11-T02 | `feature_id:v4.tools_admin` | M10 | blocked | `codex/v4-cordis-refactor-main` |

## M12 — Parity / Release

| task_id | claim_id | 依赖 | 状态 | merge target |
|---|---|---|---|---|
| M12-T01 | `feature_id:v4.parity_release` | M11-T01 + M11-T02 + D0 | blocked | `codex/v4-cordis-refactor-main` |

## D0 — Differential Harness（跨 milestone 并行 lane）

| task_id | claim_id | 依赖 | 状态 | merge target |
|---|---|---|---|---|
| D0-T01 | `feature_id:v4.differential_harness` | M00 structural contracts | in_progress (independent of T05) | `codex/v4-cordis-refactor-main` |
