# V3 Provider Key Health Scoring and Cooldown Design

状态：design / source-controlled runtime pending live replay

基线：`main` / `origin/main` at `dfbfa79f2` (`test(v3): lock session cooldown isolation`)

## 1. 目标

建立 Provider-owned、key 级健康治理真源，满足以下产品原则：

1. 错误先分类，再按分类处理。
2. 不可恢复错误进入 provider subscription 级 global cooldown，用于去毛刺；这不等于永久失败。
3. 可恢复错误累计三次才进入 cooldown。
4. cooldown 必须持久化；重启只触发 probe，不得直接恢复流量；probe 成功后才能恢复。
5. 错误降低健康分，成功提高健康分；同一 priority bucket 内按 key 级健康分调度，使错误少的 key 获得更多流量。

设计结果必须保持 V3 控制面/业务 payload 隔离。score、failure streak、cooldown、probe、routing decision 只能存在 Provider health typed resource 或 scheduling projection，不得进入 provider/client normal payload，也不得由 Router 从 payload 重建。

## 2. 当前 main 基线与 gap

### 2.1 已存在能力

当前 `main` 已有：

- `Auth / Quota / RateLimit / Transport / Semantic` failure class；
- provider health store 的 session-scoped consecutive failures；
- global subscription health；
- failure threshold 默认值 3；
- cooldown、`blocked_until_ms`、`next_probe_at_ms`、`probe_in_flight`；
- restart/load、startup/due probe、probe failure reschedule、probe success clear；
- Target-facing read-only availability projection；
- priority/weight route contract；health score projection 已接入 Target 的有效 priority；
- provider action gate 和 Error05 recovery admission。

代码/合同锚点：

- `v3/crates/routecodex-v3-provider-responses/src/health.rs`
- `v3/crates/routecodex-v3-provider-responses/src/provider_global_health.rs`
- `v3/crates/routecodex-v3-provider-responses/src/global_cooldown.rs`
- `v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs`
- `docs/architecture/v3-resource-operation-map.yml`
- `docs/architecture/v3-function-map.yml` feature `v3.provider_global_subscription_probe`
- `docs/architecture/v3-mainline-call-map.yml` chain `v3.provider_action_gate.mainline`

### 2.2 必须补齐的 gap

| Gap | 当前 main | 目标 |
| --- | --- | --- |
| 分类到恢复策略 | failure class 存在；分类、scope、cooldown action、score delta 未统一为一个 typed action | `V3ProviderFailureAction` 唯一策略产物 |
| 不可恢复/可恢复边界 | global cooldown 与 threshold 路径存在，但组合合同需显式锁定 | 不可恢复 immediate global；可恢复 count=3；health-neutral 不计入 |
| key 级健康分 | 无 canonical `score` | ProviderKeyHealthState 持有 0..1500 score，1000 为基线 |
| 成功涨分 | 有 success 清理部分 failure/cooldown 状态 | success 产生明确 score delta；probe success 受 recovery floor 约束 |
| score 持久化 | 持久化对象主要是 cooldown/probe | score 与 generation 一致性一并持久化 |
| priority/health 调度 | route contract 有 priority/weight；旧实现按小数值优先且把 score 乘入 weight | Target 消费 typed scheduling projection；大数值优先，score 调整 effective priority，weight 只在同 effective priority 内生效 |
| 文档一致性 | 旧 health-weighted Router 文档与 V3 health-blind Router owner 口径不完全收敛 | canonical V3 文档锁定 Target owner 与 projection 边界 |
| 架构地图 | 现有 health/global probe 已登记；score resource/function/edge/gate 尚未登记 | 先补 resource/function/mainline/verification map，再实现 |

当前主线默认普通 failure cooldown 仍是 Session scope。跨 session 的 auth/quota/global 影响由 global subscription health 承担。本设计不把未提交的 AuthKey 默认 scope 变化当作 main 基线。

## 3. Owner 与边界

### 3.1 Error owner

Error chain 负责：

- 归一化 source error；
- 分类 `failure_class`；
- 判断 `recovery_kind`；
- 生成 typed provider failure action。

Error chain 不负责：

- 直接写 Provider health store；
- 计算 score；
- 选择下一个 provider key；
- 修改 payload。

### 3.2 Provider health owner

`routecodex-v3-provider-responses` 负责唯一维护：

- key 级 score；
- failure/success streak；
- session-local cooldown；
- provider subscription/global cooldown；
- persistent cooldown；
- probe state；
- score/cooldown generation；
- read-only availability/scheduling projection。

Runtime 只能通过已登记的 provider health API 调 mutation；Target 只能读 projection。

### 3.3 Target / Router 边界

Virtual Router 只生成 route pool、priority、base weight 和 opaque target plan，不读写 Provider health。

Target 在已选 route plan 内：

1. 过滤 unavailable/cooldown key；
2. 计算 `effective_priority = configured_priority + min(score_milli - 1000, floor(configured_priority * 0.5))`；正的 configured priority 的健康正向调整最高为其 50%，即 effective priority 不超过其 150%；保留最高 effective-priority bucket；
3. 只在同一 effective priority bucket 内按配置 weight 调度；
4. 执行 deterministic selection；
5. provider failure 后做 target-local reselect，不重新进入 VR，不跨 immutable target plan。

健康调整只由 Provider scheduling projection 计算；route-tier precedence 仍由 Target 的组合 priority 保持，健康状态不能改变 route-tier 身份或进入 payload。

## 4. Typed contracts

### 4.1 Failure action

```rust
pub enum V3ProviderRecoveryKind {
    IrrecoverableGlobalCooldown,
    RecoverableCounted,
    HealthNeutralTransient,
    NotProviderHealth,
}

pub struct V3ProviderFailureAction {
    pub class: V3ProviderFailureClass,
    pub recovery: V3ProviderRecoveryKind,
    pub scope: V3ProviderHealthScope,
    pub score_delta: i32,
    pub cooldown: Option<V3CooldownInstruction>,
}
```

`V3ProviderFailureAction` 必须由 Error classification/policy 唯一构造。Provider health store 不得二次猜测 recoverability。
Action 同时携带 `V3ProviderHealthScope`：普通 recoverable failure 使用
`GlobalProviderKey`，由 Provider-owned key health 在第 3 次阻断该 provider+auth key+model，跨
session 持久化并要求 probe；只有显式 request-local/health-neutral action 才使用
`SessionProviderKey`。Target 不得从 error message 或 score 推导 scope。

### 4.2 Health key

```text
ProviderKeyHealthKey = provider_id + auth_alias + model_id
```

scope 由分类动作决定：

| 类别 | 默认 scope | 说明 |
| --- | --- | --- |
| Auth / Quota | provider + auth key + model | 只有该模型的上游配额/鉴权状态受影响 |
| RateLimit | provider + auth key + model | 按 provider/key/model 计分；同一 key 的其他模型保持可用 |
| Transport | session + provider key，三次后进入配置的 global policy | 避免单请求瞬态污染所有 session |
| Semantic / Protocol | provider + auth key + model | 只阻断确定受影响的模型，不扩散到同 key 其他模型 |
| ClientDisconnect | none | health-neutral |
| Session-local invalid state | session + provider key 或 session-only | 不得提升为 provider global |

实际 scope 必须随 action typed 传递，禁止按字符串/错误 message 在 store 内推导。

### 4.3 Key health state

```rust
pub struct V3ProviderKeyHealthState {
    pub key: V3ProviderKeyHealthKey,
    pub score_milli: u32, // 0..1500
    pub failure_streak: u32,
    pub success_streak: u32,
    pub last_failure_at_ms: Option<u64>,
    pub last_success_at_ms: Option<u64>,
    pub score_generation: u64,
    pub cooldown: Option<V3CooldownState>,
    pub probe: V3ProbeState,
}
```

`score_milli` 是调度信号，不是 availability。`cooldown` 阻断必须优先于 score；低分 key 仍可能 available，高分 key 仍可能 blocked。

### 4.4 Scheduling projection

```rust
pub struct V3ProviderSchedulingProjection {
    pub key: V3ProviderKeyHealthKey,
    pub priority: i32,
    pub effective_priority: i32,
    pub available: bool,
    pub blocked_scopes: Vec<String>,
    pub score_milli: u32,
    pub base_weight: u32,
    pub effective_weight_milli: u64,
    pub score_generation: u64,
}
```

这是 Target 消费的只读 projection。它不是 provider payload，也不是 Router 控制 metadata。

## 5. Error policy

### 5.1 不可恢复错误

```text
Error classified as irrecoverable
  -> score delta large negative
  -> immediate provider subscription/global cooldown
  -> persist cooldown
  -> no same-provider retry
  -> no payload repair
  -> probe required before re-admission
```

“不可恢复”表示当前 failure 不值得在本次请求内 retry，不表示 provider 永久死亡。

不可恢复判定不仅由 HTTP 状态决定。`401/402/403` 以及 typed source code 中的
`invalid_api_key`、`unauthorized`、`insufficient_quota`、`quota_exceeded`、
`account_disabled`、`account_suspended`、`billing_disabled` 都必须立即走
`IrrecoverableGlobalCooldown`；错误分类 owner 先生成 action，health owner 不得重新猜测。

### 5.2 可恢复错误

```text
recoverable failure #1/#2
  -> score down
  -> failure_streak + 1
  -> current key request-local exclusion as needed

recoverable failure #3
  -> score down
  -> cooldown
  -> persist
  -> probe schedule
```

三次计数必须绑定 action scope 和 provider key model。不同 auth key 不得意外合并；同一 auth key
在不同 session、同一 model 上必须共享同一计数、score 和 cooldown；不同 model 必须隔离。只有明确构造的
`SessionProviderKey` action 才限制在当前 session；普通 recoverable 不得退化成 session-only
绕行，否则会使持久化 cooldown 和 restart probe 失效。

### 5.4 显式 direct pin 规则

显式 provider/model 或 provider/key pin 仍然只负责缩小候选集合，不拥有绕过健康状态的权限。
持久化 cooldown、probe pending、request-local provider failure 和任何 typed health block
都必须在 Target selection 中先被过滤；如果该 pin 没有其他可用候选，返回 exhaustion，不能把
被 cooldown 的 key 作为 direct fallback 发送。direct pin 只可保留其协议/模型语义，不可改变
Provider-owned health truth。

### 5.3 health-neutral

SSE inter-event stall、client disconnect、未提交响应后的 transport 生命周期等已登记 health-neutral 情况：

- 不改变长期 score；
- 不累计 recoverable failure streak；
- 仅允许 request/session 短期 bypass；
- 不写 global cooldown；
- 不投影成 provider health failure。

Resp03 内部的 server-tool `web_search` hop failure 也属于 health-neutral：搜索后端失败只能
结束当前 server-tool 往返并进入错误链，不得把模型 provider key 记为失败、降低其 score、
累计 streak 或触发 cooldown。搜索后端健康与模型 provider key 健康是两个资源，不能借同一
个 key-health store 代偿。

## 6. Score algorithm

### 6.1 Initial value

```text
baseline = 1000
```

新 key 不使用随机值；没有历史时确定性为 baseline。

### 6.2 Event deltas

初始建议值，最终放入 config manifest/typed policy，不散落常量：

| Event | Delta | 其他状态 |
| --- | ---: | --- |
| ordinary success | +20 | failure_streak=0 |
| recoverable failure | -100 | failure_streak += 1 |
| irrecoverable failure | -400 | immediate global cooldown |
| probe failure | -50 | 保持 cooldown，reschedule |
| probe success | recovery floor | 清 cooldown，清 failure generation |
| health-neutral | 0 | 可写 request-local bypass |

所有变化执行：

```text
score = clamp(score + delta, 0, 1500)
```

### 6.3 Probe success

probe success 不得直接把 key 恢复到 1000。建议：

```text
score_after_probe = max(score_before_probe, recovery_floor)
recovery_floor = 600
```

后续真实 success 再逐步涨分，避免刚 probe 通过的 key 瞬间压过长期稳定 key。

### 6.4 Time recovery

可选第一版：不加后台时间衰减，只由真实 success 恢复，降低调度隐式状态。

后续若需要 idle recovery，必须由 Provider health owner 使用固定 half-life，并持久化 `last_score_update_at_ms`；Target/Router 不得各自计算。

## 7. Cooldown persistence and probe

持久化记录必须至少包含：

```text
provider_id
auth_alias
model_id
scope
failure_class
score_milli
failure_streak
success_streak
last_failure_at_ms
last_success_at_ms
score_generation
blocked_until_ms
next_probe_at_ms
probe_in_flight
```

写入必须原子提交；load/decode/lock/persist 失败显式报错，不能把错误转换成 available。
当前 key-health persistence schema 为 v4，canonical identity 是 `provider_id + auth_alias + model_id`。v1/v2 旧条目按完整 provider/key/model identity 保留，v3 旧条目从 state 的 `probe_model_id` 恢复 model；缺少该字段必须显式拒绝，不能把 cooldown 扩散到同 key 的全部模型。下一次 mutation 以 v4 写回；未知 schema 必须显式拒绝，不能静默解释为新的 score truth。持久化 recoverable key 由 Provider key-health 自己登记 startup/due probe candidate；不可恢复 key 的 probe 由 global cooldown owner 持有，二者不得重复探测。

V3 仍保留两个不同 owner 的持久化资源：`provider-key-health.json` 保存 key score、streak、key cooldown 和
probe generation；`provider-cooldowns.json` 保存分类级 cooldown coordinator 的 probe deadline。
二者不是两套调度器：前者是 key scheduling truth，后者只承载已登记的 global/class cooldown
协调状态。启动时两者都只产生 probe candidate，任何一侧未 probe success 都不得重新放行对应 key。

生命周期：

```text
record action
  -> mutate in-memory state
  -> persist
  -> restart
  -> load blocked state
  -> startup probe permit
  -> provider probe
      success -> clear cooldown, recovery floor, persist
      failure -> preserve block, next probe, persist
```

cooldown deadline 到达只表示 probe eligible；不得直接恢复调度。

## 8. Same-priority scheduling

输入：

```text
candidate key
priority
base weight
availability projection
score_milli
deterministic round-robin cursor
```

算法：

```text
1. remove configured-disabled / cooldown / request-excluded keys
2. choose maximum numeric effective priority bucket
3. effective_priority = configured_priority + min(score_milli - 1000, floor(configured_priority * 0.5)) for positive configured priority; zero priority receives no positive uplift and negative priority keeps additive semantics
4. within bucket:
     effective_weight = base_weight
5. select by deterministic SWRR
6. tie-break by stable key order/cursor
```

`score_milli` 不再乘入 weight：score 1000 保持 configured priority，score 1500 的正向调整最多为 configured priority 的 50%，score 低于 1000 则按 additive delta 降低 effective priority。`effective_weight_milli` 始终为 `max(base_weight, 1)`；cooldown key 不进入权重计算。

## 9. State machine

```text
Healthy(score=S, streak=0)
  success -> Healthy(score=min(1000,S+20), streak=0)
  recoverable failure -> Degraded(score=max(0,S-100), streak+1)
  irrecoverable failure -> GlobalCooldown(score=max(0,S-400))

Degraded(streak<3)
  success -> Healthy(score up, streak=0)
  recoverable failure ->
      streak<3: Degraded
      streak=3: Cooldown

Cooldown(blocked_until, probe_due)
  ordinary request -> unavailable
  deadline -> ProbeEligible
  probe failure -> Cooldown(next probe)
  probe success -> Healthy(score>=recovery_floor, streak=0)

HealthNeutral
  -> no score/cooldown mutation
  -> optional bounded request/session bypass
```

## 10. Architecture map changes required before implementation

本设计本轮只落文档，不修改 map。实现前必须补齐：

1. `docs/architecture/v3-resource-operation-map.yml`
   - `v3.provider.key_health_state`
   - `v3.provider.scheduling_projection`
   - `v3.provider.failure_action`
   - persistence/probe relationship
2. `docs/architecture/v3-function-map.yml`
   - score mutation owner
   - success/failure/probe entry symbols
   - scheduling projection builder
3. `docs/architecture/v3-mainline-call-map.yml`
   - Error03 -> Provider action -> Health mutation
   - Health projection -> Target selection
   - cooldown load -> startup probe -> re-admission
4. `docs/architecture/v3-verification-map.yml`
   - positive/negative score tests
   - same-priority distribution tests
   - persistence/probe tests
   - payload isolation and non-adjacent owner red tests
5. V3 wiki/mainline manifest
   - node IDs must match map IDs
   - current old health-weighted Router wording must be marked legacy or rewritten to Target-owned projection semantics

未完成上述 map/gate 前，不得先写 runtime implementation。

## 11. Verification design

### Unit / white-box

- classification produces exactly one recovery kind;
- irrecoverable action immediately creates global cooldown;
- recoverable failures 1/2 do not cooldown;
- recoverable failure 3 cooldowns;
- health-neutral event changes neither score nor streak;
- success increments score and clears failure streak;
- score clamps at 0/1500;
- probe failure retains cooldown;
- probe success clears cooldown but uses recovery floor;
- concurrent probe acquisition is single-flight;
- stale generation success cannot clear newer cooldown.

### Target black-box

- higher numeric effective priority wins;
- health score changes effective priority; weight is used only within the highest effective-priority bucket;
- cooldown key never selected;
- low score changes effective priority but does not itself make a key unavailable;
- request-local exclusion does not mutate persistent score;
- target reselect does not re-enter Virtual Router.

### Persistence / restart

- score/cooldown/probe state survives restart;
- startup probe is required before re-admission;
- probe failure persists next probe deadline;
- persistence/lock/decode failure is explicit error, never availability success;
- atomic temp file collision cannot corrupt prior state.

### Payload / architecture negative tests

- score/cooldown/probe fields absent from provider body;
- score/cooldown/probe fields absent from client response;
- Router cannot mutate Provider health;
- Target cannot construct health mutation;
- no duplicate score calculation in Router/Runtime/Server;
- no fallback from score selection to another protocol or payload repair.

### Runtime closeout

按项目硬门禁执行：focused tests -> build -> global install -> one aggregate restart -> all member `/health` -> real old-sample replay -> DSH Review。任何后续代码/测试/构建/运行配置修改都会使旧证据失效。

## 12. Non-goals

- 不修改 provider/client normal payload；
- 不恢复已移除 provider；
- 不在 Virtual Router 增加第二套 health policy；
- 不把 score 当作 cooldown 替代品；
- 不把同 priority score 变成跨 priority fallback；
- 不把 client disconnect、session-local invalid state 误记为 provider global failure；
- 不在本轮直接修改当前 dirty worktree 中的 AuthKey default scope。
