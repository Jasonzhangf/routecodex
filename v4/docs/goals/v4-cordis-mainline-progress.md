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
| M04 epoch transaction | `available` | M02 + M03 | 两个前置 task 已合并并完成主树复验；可独立 claim |
| M05 ExecutionEngine | `blocked` | M04 | 必须串行 |
| M06 request JSON | `blocked` | M05 | 必须串行 |
| M07 response JSON | `blocked` | M06 | 必须串行 |
| M08 async data plane | `blocked_by_incomplete_sync_transport_migration` | M00 structural contracts + M00-T07 | worker 已完成局部 async listener/native transport 测试，但旧 curl、同步 runtime-bin、真实 evidence integration 未完成；另有无关 formatter dirty，未合入；T05 不是该 blocker |
| M09 SSE | `blocked` | M07 + M08 | 必须串行 |
| M10 state semantics | `blocked` | M09 | 必须串行 |
| M11 protocols/tools/admin | `blocked` | M10 | 协议 lane 与 tools/admin lane 可并行 |
| M12 parity/release | `blocked` | M11 + D0 | 最终串行收敛 |

## 周期

`audit → claim → isolated worktree → red → implement → boundary self-check → focused gates → build/live → evidence → checker → merge refactor main → refactor main reverify → milestone merge repo main → sync`。

任何 task 未合并并通过主树复验，依赖 task 保持 blocked；worker 不得直接写主树。
