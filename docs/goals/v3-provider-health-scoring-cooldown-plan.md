# V3 Provider Key Health Scoring and Cooldown Implementation Plan

状态：source-controlled runtime pending live replay

实现设计真源：

`docs/design/v3-provider-health-scoring-cooldown-design.md`

当前基线：`main` / `origin/main` at `dfbfa79f2`。

当前实施状态：source-controlled runtime pending live replay；workspace build 与 provider key health 定向合同已通过，architecture 全量 gate、全量 runtime 合同、安装/重启/在线 replay/DSH Review 尚未闭环。

## 可直接执行的 `/goal` 提示词

```text
/goal
按 docs/design/v3-provider-health-scoring-cooldown-design.md 实现 V3 Provider-owned key 级健康治理，并按本计划完成验证与交付。

硬约束：Error 唯一生成 typed failure action；Provider health 唯一修改 score、streak、cooldown、probe；Target 只读 scheduling projection；Virtual Router 不读写 health。不可恢复错误立即进入明确 global cooldown；可恢复错误第 3 次才 cooldown；health-neutral 不计入 score/streak。cooldown 必须持久化，重启只允许 probe；probe failure 保持 blocked，probe success 才恢复并使用 recovery floor。success 涨分，score 只影响同 priority bucket，cooldown key 永不被选中。控制状态不得进入 provider/client normal payload；禁止 fallback、silent strip、请求侧 cleanup、VR re-entry 和第二套 scheduler。

执行顺序：先更新并验证 resource/function/mainline/verification map、wiki/manifest；再实现 classification/action、key health、persistence/probe、scheduling projection、runtime 接线；随后跑 red/green 正反测试、fmt/clippy/build 和全部架构 gate；最后 global install、一次聚合 restart、全部成员 health、真实旧样本 replay、DSH Review、evidence/handoff、精准 commit/push、MEMORY 收口。任何 gate、在线验证或 Review 未通过，不得宣称完成。

完成信号：所有 owner/edge/gate 绑定真实 symbol；recoverable 1/2/3、irrecoverable、success/probe、scope isolation、persistence failure、priority-first/same-priority scheduling、payload isolation 和 no-VR-reentry 均有证据；global install、restart、health、online replay、DSH Review PASS 全部记录在 evidence 中。
```

## 1. 目标与验收标准

实现 Provider-owned key health state：错误分类驱动 recovery action；不可恢复错误进入持久化 global cooldown；可恢复错误累计三次后 cooldown；重启只允许 probe 恢复；success/failure 更新 key score；同 priority bucket 内按 score/weight 调度。

验收：

- 相同 key 的 recoverable failure 第 1/2 次不 cooldown，第 3 次 cooldown；
- 不同 key/session/model 不错误合并；
- irrecoverable action 直接进入正确 global scope；
- cooldown 在 restart 后仍阻断，probe failure 不恢复，probe success 才恢复；
- success 提升 score，probe success 使用 recovery floor，不瞬间满分；
- score 只影响同 priority bucket；cooldown key 永不被 score 选中；
- Target 消费 typed scheduling projection，Router 不拥有 health mutation；
- score/cooldown/probe 不进入 provider/client payload；
- 所有 map、manifest、wiki、gate 与真实 symbols 对齐。

## 2. Scope

### In scope

- Error classified provider failure action；
- Provider health key state、score、streak、generation；
- session/global/persistent cooldown 与 probe 的关系；
- scheduling projection 与 Target 同 priority selection；
- health state persistence schema；
- source/unit/Target/persistence/live verification；
- resource/function/mainline/verification map 和 wiki lockstep。

### Out of scope

- provider/client payload 语义转换；
- protocol/tool/continuation 语义；
- Router 第二套 health policy；
- provider credential/config mutation；
- 已移除 provider 恢复；
- 当前 dirty worktree 的 AuthKey default scope 直接合入；
- fallback、silent strip、请求侧 cleanup。

## 3. 设计原则

1. Owner-first：Error 产 action；Provider health 唯一 mutation；Target 只读 projection；Router 只产 route plan。
2. Classification-first：先分 recoverable/irrecoverable/health-neutral，再执行计数、score、cooldown。
3. Cooldown-gates-score：score 不能绕过 cooldown；cooldown deadline 不能代替 probe success。
4. Priority-first：score 只在相同 priority bucket 内参与调度。
5. Side-channel-only：health state、score、probe、routing state 不进 normal payload。
6. No fallback：错误显式进入 Error chain；不靠协议旁路、payload 修补或第二 scheduler 补偿。

## 4. Gap 对齐

| 主线事实 | 实施差距 | 处理 |
| --- | --- | --- |
| failure class 已存在 | 没有统一 typed recovery action | Phase 1 建 action contract |
| threshold=3 已存在 | scope/分类组合缺红测锁 | Phase 2 补分类矩阵 |
| global cooldown/probe 已存在 | score 未进入持久化 health state | Phase 3 扩展 Provider owner |
| session isolation 已存在 | score key 与 cooldown scope 需分层 | Phase 3 锁 key/scope contract |
| same-priority weight contract 已存在 | Target 无 score projection | Phase 4 接 Target |
| maps 已登记旧 health/probe | score resource/edges/gates 未登记 | Phase 0 先更新 maps/wiki |
| 旧文档有 Router health-weighted | V3 canonical owner 是 Target projection | Phase 0 标 legacy/收敛文档 |

## 5. 文件与 owner 计划

### Phase 0：合同与地图

预期文件：

- `docs/architecture/v3-resource-operation-map.yml`
- `docs/architecture/v3-function-map.yml`
- `docs/architecture/v3-mainline-call-map.yml`
- `docs/architecture/v3-verification-map.yml`
- `docs/architecture/wiki/**`
- `docs/architecture/manifests/**`

动作：

1. 登记 `v3.provider.key_health_state`、`v3.provider.failure_action`、`v3.provider.scheduling_projection`。
2. 登记唯一 writer/readers/forbidden writers。
3. 登记相邻 edges：Error03 -> action -> Provider health -> projection -> Target。
4. 登记 persistence/probe lifecycle，不允许 store transport 直接恢复语义。
5. 把旧 Router health-weighted 文档标为 legacy compatibility，或改成 V3 Target-owned projection 口径。
6. 为每个 contract 增加 required positive/negative tests 和 gate。

门槛：map parse、symbol/path anchor、owner/edge registry、wiki/manifest sync 全绿。未绿不得改 Rust。

### Phase 1：分类与 action contract

预期 owner：`routecodex-v3-error` + `routecodex-v3-runtime` policy bridge。

动作：

1. 定义 `V3ProviderRecoveryKind`、`V3ProviderFailureAction`、`V3ProviderHealthScope` typed scope。
2. 把不可恢复、可恢复、health-neutral、not-provider-health 显式分开。
3. 删除/禁止调用方二次猜测 recoverability、affects_health、cooldown scope。
4. 将 action 的 score delta、threshold、cooldown instruction 绑定到 manifest/policy 真源。

门槛：分类矩阵正反测试；同一 source error 只能产一个 action；payload 无泄漏。

### Phase 2：Provider key health state

预期 owner：`routecodex-v3-provider-responses`。

动作：

1. 增加 `V3ProviderKeyHealthState`，key 为 provider + auth key；model 只作为候选和 probe wire model，不参与 health identity。
2. 增加 `score_milli`、failure/success streak、last timestamps、generation、scope/class。
3. 实现 success/failure/probe score mutation。
4. 固化默认 delta：success +20、recoverable -100、irrecoverable -400、probe failure -50；实际值经 manifest/policy 注入。
5. 固化 score clamp 0..1000。
6. probe success 使用 recovery floor，不直接恢复满分。
7. 保持普通 recoverable cooldown 的 session isolation；global subscription health 承担跨 session 的明确 global action。

门槛：unit tests、generation stale-success negative tests、session/key isolation tests，以及同一 key 跨 model 共享 score/cooldown 的正反测试。

### Phase 3：Persistence 与 probe lockstep

预期 owner：`routecodex-v3-provider-responses/src/global_cooldown.rs` + runtime coordinator。

动作：

1. 扩展 persistence schema：score/streak/generation/scope/class/cooldown/probe。
2. 版本化 schema；v1/v2 旧条目按 provider+auth key 显式合并后升级为 v3，未知 schema 不能静默解释成新 score truth。
3. 原子写入、load/decode/lock failure 显式错误。
4. restart 触发 startup probe；deadline 只产生 probe eligibility。
5. probe failure 保留 cooldown 并 reschedule；probe success 清 cooldown、清 failure generation、设置 recovery floor。
6. 保证 single-flight probe 和 stale generation 不能清除更新状态。

门槛：persistence positive/negative、restart fixture、probe concurrency、corrupt state fail-fast tests。

### Phase 4：Scheduling projection 与 Target

预期 owner：Provider health projection + `routecodex-v3-target` selection。

动作：

1. 增加 `V3ProviderSchedulingProjection`。
2. availability/cooldown 先过滤；score 不得改变 blocked 结果。
3. 只保留最高可用 priority bucket。
4. equal priority 使用 `effective_weight = base_weight * score_multiplier`。
5. 使用 deterministic SWRR/tie-break；不引入 randomness。
6. provider failure 后 target-local reselect；禁止重新进入 Virtual Router。
7. score projection 只通过 typed side-channel 进入 Target。

门槛：priority-first、same-priority distribution、cooldown exclusion、minimum multiplier、no VR re-entry 正反测试。

### Phase 5：Runtime 接线

预期 owner：`v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs` 与现有 direct/relay action gate edges。

动作：

1. Error05 action 进入 Provider health mutation。
2. success path 进入 score increase，但不得误清 global cooldown；probe success 仍是 global recovery 唯一入口。
3. health-neutral path 不更新长期 score。
4. Direct/Relay 都消费同一 action/health projection，不增 protocol-specific policy。
5. Error06 只做 client projection。

门槛：Direct/Relay JSON/SSE paired tests、provider failure reselect、post-commit health-neutral、default floor exhaustion tests。

### Phase 6：全局验证与交付

顺序固定：

1. 定向 red/green tests；
2. Rust build、fmt、Clippy、workspace；
3. architecture/resource/function/mainline/verification gates；
4. global install；
5. `routecodex restart --port <locator-port>` 一次；
6. 验证全部成员 `/health`；
7. 真实旧样本 replay：不可恢复 global cooldown、可恢复三次、restart probe fail/success、same-priority key distribution；
8. 检查 runtime logs/canonical sample evidence；
9. DSH Review；
10. 仅在 review PASS 后精准 commit/push。

任一代码、测试、构建或运行配置在 review 后修改，旧证据和 PASS 失效，必须从受影响 gate 重跑。

## 6. Verification matrix

| Area | Positive | Negative |
| --- | --- | --- |
| Classification | action matches class/recovery | caller/store cannot reclassify |
| Recoverable | failures 1/2 score down, 3 cooldown | 2 failures never cooldown |
| Irrecoverable | immediate scoped global cooldown | not same-provider retry |
| Success | score rises, streak resets | success cannot bypass active global cooldown |
| Probe | success re-admits at recovery floor | failure keeps blocked/reschedules |
| Scope | key/session/model isolation | A1+B2 never combine accidentally |
| Scheduling | same priority favors higher score | lower priority high score cannot preempt |
| Availability | cooldown key excluded | low score alone does not mean blocked |
| Persistence | restart retains state | decode/lock failure != available |
| Architecture | typed projection only | score/cooldown absent from payload; no VR re-entry |

## 7. Risks

1. 双重 global cooldown：普通 health store 与 global subscription store 同时阻断同一 key。规避：action 明确唯一 scope/owner；重复 mutation 红测。
2. score 穿透 priority：score 被误用于跨 tier fallback。规避：Target 只在最高可用 priority bucket 计算。
3. score 绕过 cooldown：低层 scheduler 只看分数。规避：availability gate 先于 score。
4. 成功错误清 global cooldown：普通 success 不得清 global subscription block。规避：只有 probe success 拥有 global clear。
5. health-neutral 污染 score：SSE/client disconnect 进入 failure mutation。规避：negative event tests + action kind gate。
6. 文档/地图虚假锁定：design 条目被当 active。规避：status 仍为 design/pending，代码完成后再同步 active/gates。

## 8. Definition of Done

- 设计文档、goal plan、resource/function/mainline/verification map、wiki/manifest 同步；
- 唯一 owner 和相邻边可由机器 gate 验证；
- classification/action/score/cooldown/probe/scheduling 全部有正反测试；
- global install、aggregate restart、全部成员 health、真实旧样本 replay 有证据；
- provider/client payload 无 health control 字段；
- DSH Review 明确 PASS；
- evidence/handoff/commit/MEMORY 收口完成。
