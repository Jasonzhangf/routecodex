# V4 Cordis 主线进度表

主树：`codex/v4-cordis-refactor-main`。所有 task merge target 固定为该主树；每个 milestone 完成后再合并仓库 `main`。

## 依赖图

```text
M00 -> M01 -> M02 --┐
  ├-> M03 ----------┼-> M04 -> M05 -> M06 -> M07 --┐
  ├-> D0 ----------┘                    M08 --------┼-> M09 -> M10 -> M11 -> M12
  └--------------------------------------┘
```

## 任务状态

| task | 当前状态 | 依赖 | 并行关系 |
|---|---|---|---|
| M00-T00 迁移计划 | `merged` | 无 | 已合并 `3b62ffd9a` |
| M00-T01 合同 | `merged` | 无 | 已进主树 |
| M00-T02 ratchet/protected promotion | `merged` | T01 | 已合并；canonical live admission 的 upstream HTTP 502 阻塞 M00 退出 |
| M00-T03 审计面 | `merged` | T01 | 已合并 `c4d13d7b8` |
| M00-T04 每 milestone 独立 claim 表 | `merged` | T03 | 已合并 `5e0090f9d` |
| M00-T05 live admission closeout | `blocked_by_provider_websocket_v2_endpoint` | T02 + T04 | 历史有效证据：A 首轮 HTTP 200；同 response-id continuation 要求 Responses WebSocket v2，当前 profile 无 HTTP 101；C continuation 503。最新 recheck 使用同一 profile 返回 provider `401 invalid_api_key`（Casdoor token validation failed），V4 `5520` 未监听；不得绕过 |
| M00-T06 canonical B wire evidence contract | `merged` | T01 + T03 | 已合并主树 `0bcd0e3ff` / merge `9f9ebc25d`；固定同 requestId 的 provider-request/provider-response diagnostic bundle，不改变 provider/continuation 语义 |
| M00-T07 live B capture binding contract | `merged` | T06 | 已合并独立 task `70ccc287b`，V4 主树 merge `3bec92d81`；绑定 provider-owned raw pair contract；无合法 owner/binding fail-closed；不实现 M08 runtime、不伪造 B 证据；M08 完成后再做 live integration |
| M00-T08 dependency reconciliation | `merged` | T01 + T03 + T04 | 已合并独立 task `764351194`，V4 主树 merge `0f353bee8`；拆分 T07 contract 与 M08 async/native runtime，消除循环依赖 |
| M00-T09 no-active-epoch admission | `merged` | T01 + T02 | 已合并独立 task `23220dceb`，V4 主树 merge `4298257666`；ActiveEpochStore 无 active epoch 时 fail-closed，6 项 L2、架构 gates、Active-linked build 与 AGY review 通过 |
| M01 NativePlugin ABI | `merged` | M00 structural contracts | task `7c7e141f5` 已合入重构主树 `100b9fd12`；主树 contract/catalog tests、plugin plan、resource binding `91/91`、diff check 通过；T05 独立保留 |
| M02 generic factory | `merged` | M01 | task `ff9065c8c` 已合入重构主树 `aa5518b50`；主树 host 30/30、red 10/10、release build、plugin tests 通过 |
| M03 Cordis daemon | `merged` | M00 structural contracts | task `8be1e7ced` 已合入重构主树 `3a425633c`；daemon 3/3、host 联测 30/30、red 10/10、release build 通过 |
| D0 differential harness | `stale_owner_handoff_required` | M00 structural contracts | `gate_id:V4-LAYER-GATE-001` 仍占用 feature-layer projection/build paths；原 run/worktree 已不可见，需 owner handoff 后才能修复 M05 admission，不得抢改 |
| M04 epoch transaction | `merged` | M02 + M03 | task `9914a69fe` 已以 merge `ba4af6c02` 合入重构主树；目标树定向 gates 全部通过，active-link 仍缺 frozen-consumer-registry 环境文件 |
| M05 ExecutionEngine | `in_progress` | M04 | 唯一 owner 已恢复其 runtime→plugin-contract 边并完成 red/partial-green；其独立 candidate 仍缺 build-link 注册、新 Active binding、candidate/protected projection，未 build/install/live/AGY/commit/merge |
| M06 request JSON | `blocked` | M05 | 必须串行 |
| M07 response JSON | `blocked` | M06 | 必须串行 |
| M08 async data plane | `ready_for_m05_execution_owner_handoff` | M00 structural contracts + M00-T07 | provider/server 独立 slice 已交接（5/5 provider、2/2 server、locked check、diff-check、handoff PASS）；整体待 M05 明确交接，runtime-bin async stream/cancellation、M00-T07 live evidence、full gates/live/AGY 未闭环；不得覆盖 M05 execution owner |
| M09 SSE | `blocked` | M07 + M08 | 必须串行 |
| M10 state semantics | `blocked` | M09 | 必须串行 |
| M11 protocols/tools/admin | `contract_preflight_merged` | M10 | M11-T01 前置合同已合入；实现仍依赖 M10，既有 host owner/catalog drift 仍需后续治理 |
| M12 parity/release | `blocked` | M11 + D0 | 最终串行收敛 |

## 周期

`audit → claim → isolated worktree → red → implement → boundary self-check → focused gates → build/live → evidence → checker → merge refactor main → refactor main reverify → milestone merge repo main → sync`。

任何 task 未合并并通过主树复验，依赖 task 保持 blocked；worker 不得直接写主树。

## 当前并发任务清单（2026-08-26）

| lane | task | 状态 | 是否可再派发 | 原因 / 收口条件 |
|---|---|---|---|---|
| execution owner | M05-T01 | `blocked_candidate_contract` | 否 | 外部 Active-link/isolation 已通过；原 worktree candidate 缺新 execution 边注册、runtime plugin-contract 边、projection/queue identity 与隔离 Active binding；不得伪造 artifact、clean、AGY、commit、merge |
| build-link owner | B01 | `in_progress` | 否 | 复用 M02 会话但新建独立 claim/worktree；只处理真实 consumer registry 与 canonical Active resolver binding，不修改 D0 feature-layer projection/gates |
| differential governance | D0-T01 | `stale_owner_handoff_required` | 否 | claim 仍 active 但原 feature-layer worktree 已不存在且无可调用会话；必须先完成 owner handoff，M05 不得抢改其 gate 文件 |
| async data plane | M08-T01 | `ready_for_m05_execution_owner_handoff` | 否（等待交接） | provider/server 独立 slice 已完成并写入 handoff；整体 runtime-bin async stream/cancellation 尚未完成，必须等待 M05 交接，不覆盖 M05 |
| provider live admission | M00-T05 | `blocked` | 否 | Responses WebSocket v2 / credential blocker；不得猜 endpoint、伪造 101 或绕过真实 continuation |
| next dependency | M06-T01 | `blocked` | 否 | 必须等待 M05 合入重构主 tree 并完成主树复验 |
| governance audit | M00-T10 | `merged_and_cleaned` | 否 | merge `de7596514`；red/positive 主树复验通过；claim、worktree、branch 已释放/清理 |
| protocol/tools/admin contract | M11-T01 | `merged_and_cleaned` | 否 | merge `d48956155`；合同/host/red gates 主树复验通过；resource binding 的既有 host owner/catalog drift 已记录；claim、worktree、branch 已释放/清理 |

当前可并发 lane：M08-T01 的 provider/server 独立 slice；D0-T01 仍由既有 owner 处理。M05 是唯一 execution owner，正在正确的 `v4/` 工作目录重跑 Active/admission gate；M06 及后续 milestone 继续等待 M05 合入重构主树并完成主树复验。M00-T10、M11-T01 已完成合入并清理，不得重复 claim；M08 使用既有 worktree，未获 M05 明确交接前不得修改 runtime-bin、maps、ExecutionEngine 或 NodeContainer。

## 当前派发记录（2026-08-26，证据优先）

| worker | 已派发动作 | 当前结论 |
|---|---|---|
| M05-T01（原会话复用） | 已恢复自身 `runtime → plugin-contract` 边；继续保留 M05 execution candidate，等待 B01 handoff 后重跑 `v4/` Active/admission/build/install/live/AGY | 当前被外部 build-link/projection/Active binding 阻塞；禁止伪造 artifact、allowlist、clean、AGY、commit、merge、cleanup |
| B01（复用 M02 会话） | 新 claim/worktree 处理 build-link consumer registry 与 canonical frozen Active resolver binding；只允许合入 `codex/v4-cordis-refactor-main` | 已派发；必须先 red→green、locked focused gates 和 evidence，未完成不得交付 |
| M08-T01（原会话复用） | provider/server async transport、chunked response、cancellation/deadline、合同/边界/定向 red/green/evidence 已完成；等待 M05 execution owner 明确交接后再接 runtime-bin | 独立 slice ready；整体 M08 未完成，不得提前合并或宣称完成 |
| D0-T01（既有 owner） | 继续其 differential/build-guard gate 收口；当前等待 stale owner handoff | claim 仍占用 gate projection；原 worker 会话不可见，禁止重复派发、抢改 gate 文件或自动接管 |
| M00-T10 / M11-T01 | 已合入重构主树后完成主树复验、release claim、worktree/branch cleanup | 已完成并清理 |
