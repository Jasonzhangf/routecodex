# V3 Parallel Worker Merge Audit Closeout Plan

## 1. 目标与验收标准

在 OpenAI Chat Relay Runtime、Anthropic Relay local continuation、Responses WebSocket v2
transport hardening 三个 worker 并行开发期间，主线程只做独立合并审计与收口：持续读取
`.agent-collab` 证据、审查每个 worker 的 diff、修复非破坏性 gate/blocker、跑完整回归并提交已验证集成。

验收标准：

- 不抢占三个 worker 的 feature owner，不直接改其 runtime 实现，除非它们完成后进入 merge audit。
- 每个 worker 完成后按 claim/evidence/diff/source/gate 顺序审计。
- 发现架构违规时先加红 gate，再回唯一 owner 做最小 forward fix。
- 最终提交只包含已验证 intended scope；active worker 半成品保持未提交并明确隔离。

## 2. 范围与边界

In scope：

- `.agent-collab` runs/claims/evidence/handoff/merge-queue 审计。
- worker commit/diff review、架构边界审计、补充红测/gate。
- maps/wiki/package 共享文件冲突调解。
- focused + full V3 + architecture review gate 聚合。
- 定向 stage/commit 与最终状态报告。

Out of scope：

- 主动实现 OpenAI Chat Runtime、Anthropic local continuation、WebSocket transport hardening。
- live config、credential、install、restart、provider endpoint 猜测。
- broad checkout/reset/kill 或覆盖 active worker dirty files。

## 3. 设计原则

- 主线程是 checker/integrator，不是第四个 runtime feature owner。
- 先证据后结论：worker evidence 不足时只说 source/controlled 通过，不宣称闭环。
- no fallback：审计发现错层实现、materialization、第二 owner、payload 泄漏，必须 forward fix。
- 多 worker 文件协议优先：每轮刷新 active heartbeats 和 claims。
- 提交按 verified scope 定向 stage；未完成 worker diff 不混入。

## 4. 技术方案与文件清单

主要操作面：

- `.agent-collab/runs/*/heartbeat.json`
- `.agent-collab/runs/*/evidence.jsonl`
- `.agent-collab/claims/*/owner.json`
- `git status --short`
- `git diff HEAD`
- `docs/architecture/v3-*.yml`
- `package.json`
- `scripts/architecture/*`
- `scripts/tests/*`

主线程只能在 worker 完成或 handoff 后修改其 owner 文件；对 active worker 文件只读。

## 5. 风险与规避

- Active worker dirty 被误提交：提交前必须比对 heartbeat、claim、status、git diff，并只 stage completed scope。
- Gate 绿但架构错：必须人工 review owner boundary、SSE materialization、fallback、payload side-channel。
- 共享 map 冲突：按 feature_id/resource_id/mainline edge 分段审查，必要时修 map/gate，不回滚 worker。
- Live 证据混淆：source/controlled/live 三类证据分开报告。

## 6. 测试计划

- 每个 worker focused gate 和 mutation red fixtures。
- `npm run verify:v3-cargo-fmt`
- `npm run verify:v3-clippy`
- `npm run test:v3-workspace`
- 相关 package/focused integration tests。
- `npm run verify:v3-architecture-docs`
- `npm run verify:v3-resource-map`
- `npm run verify:v3-module-boundaries`
- `npm run verify:v3-rust-only`
- `npm run verify:architecture-review-surface`
- `git diff HEAD --check`
- secret/broad-kill/fallback/materialization scans。

## 7. 实施步骤

1. 刷新 `.agent-collab` active runs、claims、handoff、merge-queue、kill switch。
2. 对每个 worker：读 heartbeat/events/evidence，确认状态是否 complete。
3. 对 complete worker：审查 diff、source owner、maps、tests、red fixtures。
4. 若发现 blocker：先补红 gate，再最小 forward fix，跑 focused gate。
5. 三个 worker 都完成或可安全分批时，跑聚合 V3/full architecture gates。
6. 定向 stage 已验证范围，确认无 active half-done diff 混入。
7. commit，写 review run evidence，汇报 commit hash、验证、剩余风险。

## 8. 完成定义

- 三个 worker 的 completed scope 均经主线程审计。
- 所有必要 blocker 已 forward-fixed 且有红/绿证据。
- 聚合 gate 全绿。
- 已提交 verified integration commit。
- 未完成/live 缺口明确列出。
