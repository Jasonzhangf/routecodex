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
| M00-T02 ratchet/protected promotion | `blocked` | T01 | 与 T03 可并行，需修 protected gate 接线 |
| M00-T03 审计面 | `merged` | T01 | 已合并 `c4d13d7b8` |
| M00-T04 每 milestone 独立 claim 表 | `merged` | T03 | 已合并 `5e0090f9d` |
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
