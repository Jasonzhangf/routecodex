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
| D0 differential harness | `in_progress` | M00 structural contracts | 已有独立 worker；与 M03/M08 并行，T05 不传播阻塞 |
| M04 epoch transaction | `merged` | M02 + M03 | task `9914a69fe` 已以 merge `ba4af6c02` 合入重构主树；目标树定向 gates 全部通过，active-link 仍缺 frozen-consumer-registry 环境文件 |
| M05 ExecutionEngine | `in_progress` | M04 | 已 claim 独立 worktree；源码与 M05 专项验证完成，交付门禁被 Active artifact、feature-layer admission、isolation wiring、install/live 基线阻断；未 AGY/commit/merge |
| M06 request JSON | `blocked` | M05 | 必须串行 |
| M07 response JSON | `blocked` | M06 | 必须串行 |
| M08 async data plane | `paused_due_to_m05_runtime_bin_overlap` | M00 structural contracts + M00-T07 | 原 worktree 保留；旧 curl、同步 runtime-bin、真实 evidence integration 未完成。当前 M05 正在修改同一 runtime-bin execution owner，暂停并发避免语义冲突；M05 收口后再恢复 |
| M09 SSE | `blocked` | M07 + M08 | 必须串行 |
| M10 state semantics | `blocked` | M09 | 必须串行 |
| M11 protocols/tools/admin | `blocked` | M10 | 协议 lane 与 tools/admin lane 可并行 |
| M12 parity/release | `blocked` | M11 + D0 | 最终串行收敛 |

## 周期

`audit → claim → isolated worktree → red → implement → boundary self-check → focused gates → build/live → evidence → checker → merge refactor main → refactor main reverify → milestone merge repo main → sync`。

任何 task 未合并并通过主树复验，依赖 task 保持 blocked；worker 不得直接写主树。

## 当前并发任务清单（2026-08-26）

| lane | task | 状态 | 是否可再派发 | 原因 / 收口条件 |
|---|---|---|---|---|
| execution owner | M05-T01 | `in_progress` | 否 | 唯一 ExecutionEngine 正在退役旧 runtime execution surface；完成 Active/feature-layer/install/live 前不得 AGY、commit、merge |
| differential governance | D0-T01 | `in_progress` | 否 | 已有独立 worker/claim 处理 layer-batch gate；不得重复 claim 或抢改其 gate 文件 |
| async data plane | M08-T01 | `paused` | 否 | 与 M05 共享 runtime-bin 语义和文件；待 M05 merge 或明确交接后恢复，原 worktree/dirty 保留 |
| provider live admission | M00-T05 | `blocked` | 否 | Responses WebSocket v2 / credential blocker；不得猜 endpoint、伪造 101 或绕过真实 continuation |
| next dependency | M06-T01 | `blocked` | 否 | 必须等待 M05 合入重构主 tree 并完成主树复验 |

结论：当前无新的可安全 claim 的并发任务。新增 worker 会与 M05、D0 或 M08 产生 owner/file 竞争；先完成现有 lane 的 merge/复验/清理，再开放后续 milestone。
