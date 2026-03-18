# RouteCodex Rust 化 Heartbeat

Heartbeat-Until: 2026-03-23T23:59:00+08:00
Last-Updated: 2026-03-17 (P0 slice routecodex-3.11.2 closed)

## Rust 化任务总览（基于 `.beads/issues.jsonl`）

- rust/rustify/rust化 关键词任务总数：`102`
- 已关闭：`92`
- 进行中：`9`
- 未开始（open）：`1`
- 当前活跃任务清单：`10`（另含 1 条 native-hotpath 关联任务）

## 当前任务列表

### P0（核心主线）

- [ ] `routecodex-260` (epic, open)  
  Virtual Router Rustification Completion
  - 进度：子任务完成 `0/1`
  - 当前子任务：`routecodex-3.11`

- [ ] `routecodex-3.11` (task, in_progress, updated: 2026-03-17)  
  Full Rust migration: HubPipeline + Virtual Router remaining TS modules
  - 子任务进度：完成 `3/6`
  - [ ] `routecodex-3.11.1` semantic-mappers native-primary（updated: 2026-03-09）
  - [x] `routecodex-3.11.2` tool-governance native-primary（closed: 2026-03-17）
  - [x] `routecodex-3.11.3` chat-request-filters native-primary（closed）
  - [ ] `routecodex-3.11.4` snapshot hooks/utils/recorder native-primary（updated: 2026-03-09）
  - [x] `routecodex-3.11.5` protocol-field-allowlists rust source-of-truth（closed: 2026-03-16）
  - [ ] `routecodex-3.11.6` virtual-router routing-instructions + stop/preCommand（updated: 2026-03-03）

- [ ] `routecodex-267` (epic, in_progress, updated: 2026-03-07)  
  Rustify conversion/shared TS modules
  - 子任务进度：完成 `3/5`
  - [x] `routecodex-267.1` conversion config/schema/boundary（closed）
  - [x] `routecodex-267.2` conversion codecs + v2 pipelines（closed）
  - [ ] `routecodex-267.3` shared responses/chat residual utils（in_progress, updated: 2026-03-13）
  - [x] `routecodex-267.4` compat provider/model behaviors（closed）
  - [ ] `routecodex-267.5` compat tool/request/response actions（in_progress, updated: 2026-03-09）

- [ ] `routecodex-254` (bug, in_progress, updated: 2026-03-01)  
  Fix Rust VR routing parity regressions

### P1（收尾 / 补充）

- [ ] `routecodex-248.1` (task, in_progress, updated: 2026-03-13)  
  Reasoning-only -> content for tool harvest (native)

### 关联（非 rust 关键词但属于 Rust 化链路）

- [ ] `routecodex-213` (task, in_progress, updated: 2026-02-25)  
  Native hotpath: enforce full native binding for connected modules

## Heartbeat 巡检顺序（执行建议）

1. 优先巡检 `routecodex-3.11.*`（P0 主链路，且存在多个久未更新子任务）。
2. 再巡检 `routecodex-267.3 / 267.5`（conversion/shared 残余收口）。
3. 处理 `routecodex-254` parity 回归与 `routecodex-213` native hotpath 约束一致性。
4. 每次巡检后同步更新状态与证据路径（bd notes + DELIVERY.md）。
