# SSE 客户端 / Provider 解耦与重启生命周期实现计划

## 目标与验收标准

解决两类问题：

1. SSE 挂死：provider 首帧或后续帧无响应时，客户端不能无限等待；Direct 与 Relay 都必须由 RouteCodex 拥有客户端连接，并在同一请求生命周期内完成 provider attempt 超时、切换或显式终态。
2. SSE 异常中断：provider 错误、stream drop、client disconnect、server restart 必须按合同分别终态化；不能把 provider socket 直接暴露给客户端，也不能只发送 keepalive 后永久存活。
3. 重启生命周期：重启期间的 in-flight SSE 必须有明确策略：可恢复接续，或在 restart boundary 发送可识别终态并释放资源；禁止永久 keepalive、静默 EOF、伪造成功、借 payload/metadata 猜测恢复。

验收必须包含 Direct、Relay、首帧挂起、首帧后挂起、中途 provider 错误、客户端断开、aggregate restart 六类场景的正反证据。

## 范围与边界

In scope：

- `v3/crates/routecodex-v3-server` 客户端 SSE broker/body/closeout。
- `v3/crates/routecodex-v3-runtime` Direct/Relay provider-attempt loop、timeout、switch、terminal handoff。
- `v3/crates/routecodex-v3-sse` 仅 transport framing/backpressure/closeout 合同，如证据证明其有问题。
- managed aggregate restart 与 in-flight lifecycle contract。
- 相关 resource/function/mainline/verification map、wiki/design、playground evidence。

Out of scope：

- provider 配置、凭据、模型能力、协议语义改造，除非 A/B/C 证据证明其是首次偏离点。
- 在 SSE handler、outbound 或 client projection 层补业务语义、补历史、补 continuation、静默 strip 或 fallback。
- 未授权的 live 配置迁移、生产切换、删除、回滚。

## 设计原则

- 客户端 SSE connection 由 Server/Proxy owner 管理；provider attempt 是可释放、可超时、可切换的子生命周期。
- Direct 必须经过中继；Direct/Relay 共享生命周期框架，协议差异只在 codec/provider runtime owner。
- keepalive 只负责连接保活，不代表 provider 成功、不延长已过期 provider deadline、不替代终态。
- routing、switching、retry、provider selection、restart、health、error、scope 只能走 typed side-channel / control resource / Error chain，不能进入业务 payload 或 metadata。
- 无 fallback、无 silent strip、无 handler/SSE/outbound 补偿；错误回唯一 owner 显式暴露。
- restart 若不支持 transport reattach，必须明确终止全部受影响 client SSE；若支持 reattach，必须有 typed locator、scope、owner、provider pin 和过期/释放规则。

## 证据与待确认假设

现有排查报告：`docs/research/sse-client-provider-restart-lifecycle-2026-08-23.md`。

已知风险：Direct 存在完整收集 provider stream 后再交付客户端的路径；Relay 有完整流无界 buffer 风险；已有审计记录指出 restart handoff 不能重新挂接 provider transport state。上述内容必须用同一 requestId 的 live/raw/provider/client/restart 证据确认首次偏离节点后才能修复。

## 关键文件与 owner 查询顺序

先读 MemoryPalace、当前 run notes、`.agent-collab/PROTOCOL.md`，再读取：

1. `docs/architecture/v3-resource-operation-map.yml`
2. `docs/architecture/v3-function-map.yml`
3. `docs/architecture/v3-mainline-call-map.yml`
4. `docs/architecture/v3-verification-map.yml`
5. `docs/architecture/wiki/mainline-call-graph.md`
6. `docs/architecture/wiki/v3-mainline-skeleton-sop.md`
7. `docs/goals/v3-runtime-restart-handoff-skeleton-plan.md`
8. `.agents/skills/rcc-dev-skills/references/24-node-contract-debug-method.md`
9. `.agents/skills/rcc-dev-skills/references/25-protocol-sse-continuation-boundary.md`

再打开真实 owner source；不得只凭 grep 命中修改。

## 验证矩阵

所有临时复现程序、脚本、fixture、抓包、日志、报告草稿、测试输出放在：

`./playground/sse-client-provider-restart-lifecycle-<run_id>/`

最小矩阵：

| 场景 | 正向证明 | 反向证明 |
| --- | --- | --- |
| provider 首帧挂起 | client SSE 保持到明确切换/终态 | 无 timeout 不得永久 keepalive |
| 首帧后挂起 | 同一 client request 进入 provider policy | 只保活、不终态必须失败 |
| provider 中途错误 | Error01→05 决策后切换或显式终态 | 不得 EOF 成功、不得 client_disconnect 冒充 provider |
| Direct | Direct 经过 proxy broker，provider socket 不直达 client | 禁止 direct passthrough 直连 client |
| Relay | Relay 不无界收集，按合同增量交付或有界等待 | 无界 buffer / 全量等待必须失败 |
| client disconnect | 释放 client/provider 资源，health-neutral | 不得 cooldown/provider failure |
| aggregate restart | 显式终态或合同化 reattach，资源释放可观测 | 永久 keepalive、静默 EOF、伪造成功必须失败 |

需要同一 requestId 绑定：raw client request、provider-bound request、provider raw response/SSE、client projection、Error01/05/06、restart generation/instance evidence。

## 实施步骤

1. 创建独立 run_id、claim、干净 worktree：`./playground/<issue>-<run_id>/`；声明 branch/base/绝对路径，确认与 `git worktree list` 一致。
2. 刷新 `.agent-collab`，读取活跃 runs、claims、handoff、merge queue、kill switch；发现同语义 claim 立即避让或走 handoff。
3. 只读追踪 Direct/Relay 两条主线，完成节点合同、owner、允许/禁止边和 requestId 证据表。
4. 在 playground 先建立最小 failing sample/red test：首帧挂起、帧间挂起、provider error、client drop、restart 各至少一条；确认当前红后再改代码。
5. 用 A/B/C + live replay 证明首次偏离：provider 最小直连、完整 provider-bound 原样直连、同入口 RouteCodex client SSE；Direct/Relay 分开验证。
6. 只改唯一 owner，优先消除 provider stream 与 client connection 的耦合、无界收集和 restart 未定义生命周期；不得在 handler/outbound 做补丁。
7. 在独立 worktree 运行定向正反测试、架构/resource/function/mainline/verification gates、build；所有临时产物留 playground。
8. 如需永久回归测试，先从 playground 精确迁移最小测试到 canonical gate 路径；否则测试文件全部留 playground，不把临时测试带入 change set。
9. 写 `evidence.jsonl` 与 handoff/merge-queue；checker 复核 owner、diff、测试和证据。
10. 精确合并 change set 到 main worktree/目标 main branch；不得 reset、checkout、stash 或覆盖无关 dirty 改动。
11. 在 main 上重跑受影响验证；运行时改动必须按项目规则完成全局安装、一次 aggregate `routecodex restart --port <locator>`、全部成员 health、同入口旧样本/真实样本 replay。
12. 前置验证全部通过后执行 DSH Review；review FAIL 必须修复并从受影响验证重跑，禁止用 Codex review 绕过 DSH FAIL。
13. review PASS 后只提交声明 change set；commit 前检查 staged stat/name-status，确认未带入 playground 临时文件或他人 dirty 改动。push 及远端 HEAD 一致后再清理 worktree/branch/claim。

## 风险与规避

- 只发 keepalive 可能掩盖 provider hang：必须同时断言 provider deadline、attempt outcome、client terminal。
- 将 provider 错误变成客户端断线会丢失错误归属：必须保留 Error01→05→06 链。
- restart 期间用 session/payload 自动恢复会污染 continuation：只能使用明确 typed lifecycle locator。
- Relay 全量收集可能造成内存和延迟风险：必须有界，且验证增量交付语义。
- 当前主 tree 有并发 dirty 改动：只在声明 worktree 修改，合并前逐路径核对。

## 完成定义（DoD）

- Direct/Relay 均由 proxy-owned client SSE broker 管理，provider 切换/错误不直接破坏客户端连接。
- 首帧/帧间 provider hang 不会永久挂死；有明确 timeout、policy decision 和 client terminal/切换证据。
- provider 错误、client disconnect、server restart 三者错误归属和资源释放可区分。
- restart 有明确终止或接续合同，且有受控真实 replay 证据。
- 代码、测试、maps、wiki、manifest、verification gate 一致；无 fallback、payload/control 泄漏、重复 owner 或临时补丁。
- 独立 worktree 完成并精确合并 main；main 验证、安装/重启/在线 replay、DSH Review PASS；临时文件和非必要测试留在 playground 或已清理，change set 不含未声明产物。
