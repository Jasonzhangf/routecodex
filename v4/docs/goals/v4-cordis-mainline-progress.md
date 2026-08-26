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
| M00-T05 live admission closeout | `blocked_by_provider_websocket_v2_endpoint` | T02 + T04 | A 首轮 HTTP 200；同 response-id continuation 要求 Responses WebSocket v2，当前 profile 无 HTTP 101；C continuation 503；不得绕过 |
| M00-T06 canonical B wire evidence contract | `merged` | T01 + T03 | 已合并主树 `0bcd0e3ff` / merge `9f9ebc25d`；固定同 requestId 的 provider-request/provider-response diagnostic bundle，不改变 provider/continuation 语义 |
| M00-T07 live B capture binding | `blocked_by_live_transport_owner` | T05 + M08 transport owner | 真实 provider-bound/raw capture 尚未接入 live transport；不得由 server contract 自行重建或伪造 B 证据 |
| M00-T09 no-active-epoch admission | `in_progress` | T01 + T02 | 为“无 active epoch 不接受业务请求”补可构造的 empty store 与正反测试，owner 为 ActiveEpochStore |
| M01 NativePlugin ABI | `blocked_by_M00` | M00 | M00 完成后可 claim |
| M02 generic factory | `blocked_by_M01` | M01 | 不可抢跑 |
| M03 Cordis daemon | `blocked_by_M00` | M00 | M00 后与 M01 并行 |
| D0 differential harness | `available_after_M00` | M00 | 与 M01/M03/M08 并行 |
| M04 epoch transaction | `blocked` | M02 + M03 | 必须串行收敛 |
| M05 ExecutionEngine | `blocked` | M04 | 必须串行 |
| M06 request JSON | `blocked` | M05 | 必须串行 |
| M07 response JSON | `blocked` | M06 | 必须串行 |
| M08 async data plane | `available_after_M00` | M00 | 可与 M06/M07 并行 |
| M09 SSE | `blocked` | M07 + M08 | 必须串行 |
| M10 state semantics | `blocked` | M09 | 必须串行 |
| M11 protocols/tools/admin | `blocked` | M10 | 协议 lane 与 tools/admin lane 可并行 |
| M12 parity/release | `blocked` | M11 + D0 | 最终串行收敛 |

## 周期

`audit → claim → isolated worktree → red → implement → boundary self-check → focused gates → build/live → evidence → checker → merge refactor main → refactor main reverify → milestone merge repo main → sync`。

任何 task 未合并并通过主树复验，依赖 task 保持 blocked；worker 不得直接写主树。
