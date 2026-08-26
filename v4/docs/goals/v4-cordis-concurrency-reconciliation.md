# V4 Cordis 并发、依赖与交付协议审计

状态：`active`；owner claim：`gate_id:v4.cordis-concurrency-reconciliation`；issue：`M00-T10`。

本审计只治理 V4 Cordis 计划、机器任务清单和交付门禁，不改变 runtime、runtime-bin、ExecutionEngine、D0、M08、Active artifact、V3 或全局运行时。机器真源是 `v4/contracts/v4-cordis-concurrency-reconciliation.manifest.json`；本文件解释其不变量。

## 唯一主线与独立性

- 所有 task 必须声明独立 semantic claim、issue/task id、依赖、允许并行 lane 和唯一 merge target。
- 唯一 integration target 是 `codex/v4-cordis-refactor-main`。worker 从该 ref 的最新 HEAD 创建自己的 `./playground/<task>-<run-id>/` worktree；不得直接写父主树，也不得把 task 合入仓库 `main`。
- 一个 semantic claim 一个 owner，一个 task 一个 worktree；旧 heartbeat 只能标记 stale，不能授权接管。
- M01 与 M03 可并行；M02 等 M01；M04 等 M02+M03；M05 等 M04。D0 在 M00 structural contracts 后独立并行，M00-T05 blocker 不传播到 D0。
- M06→M07→M09→M10 串行；M08 与 M05 共享 runtime-bin execution owner，当前暂停，必须等 M05 merge 或明确交接后恢复；M11-T01 与 M11-T02 可并行；M12 等二者与 D0。

## 红测与交付序列

`claim → isolated worktree → red → implementation → boundary self-check → focused gates → evidence → checker merge → refactor-main post-merge reverify → claim release → cleanup`。

红测必须在缺少独立 claim、依赖、post-merge verification、release/cleanup 顺序，或 manifest/task 使用错误 merge target 时失败。实现后的正向 gate 与 `--red-self-test` 成对运行；机器 manifest、文档和 map/package gate 必须同一 change set 绑定。

checker 只合并声明 change set 到 `codex/v4-cordis-refactor-main`，并记录 merge receipt 与受影响 gate 的主树复验。主树复验通过前，依赖任务保持 blocked，不能因 worker 声称完成而开放。

## claim release 与 cleanup

先写本 run `evidence.jsonl` 与 merge queue，等待 checker receipt；再在 refactor-main 复验。只有这些事实成立、远端 receipt（如适用）完成后，才释放 claim。释放后确认 worktree 无 dirty、branch 无未合并唯一提交，才清理 worktree/branch。任何检查失败都停止 cleanup，不删除或重写他人状态。

## 当前 blocker（未解决）

- M05：仍被 Active artifact、feature-layer admission、isolation wiring、install/live 基线阻断；尚未 AGY、commit、merge。本审计不宣称解决。
- D0：独立进行，M00-T05 不传播阻塞；其完成状态仍由自身 worker/evidence 决定。本审计不宣称解决。
- M08：因与 M05 共享 runtime-bin execution owner 暂停；待 M05 merge 或显式交接后恢复。本审计不宣称解决。

## 绑定门禁

入口命令为 `npm --prefix v4 run verify:v4-cordis-concurrency-reconciliation`；红测为同命令加 `--red-self-test`。对应 feature/function/map gate 为 `v4_cordis_concurrency_reconciliation`，只验证治理 manifest 的字段、依赖、唯一 target、交付序列和 blocker 非解决声明。
