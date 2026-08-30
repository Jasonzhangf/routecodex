# V3 Provider Health Scheduler Audit

日期：2026-08-29

审计对象：`Jasonzhangf/routecodex`

审计性质：只读代码/合同/定向测试审计；本轮未修改运行时代码、配置或生产实例。

## 结论

当前动态 probe 能够发送请求、部分解除 cooldown，但不构成可靠的自动 failback 机制。

已确认一个 P0 调度活性漏洞：

> 高意愿 provider 的健康分下降后，健康分会直接改变 `effective_priority`。一旦它从最高 priority bucket 被挤出，业务流量和 probe 流量都可能变成零；没有流量就没有成功样本，没有成功样本就没有恢复，provider 会进入长期或无限期的低意愿吸附态。

已确认的第二条 P0 恢复漏洞：

> 生产 server 顺序执行两个 probe runner，但两个 runner 扫描同一个 `provider_cooldown_probes` 状态。global runner 先删除 probe 条目并只做部分恢复，key-health runner 随后无法执行其完整恢复路径。

因此，日志中出现 “probe success” 不能证明高优先级 provider 已经恢复到可重新获得流量的调度状态。

## 审计基线

| 项目 | 版本/状态 |
| --- | --- |
| `origin/main` | `6d9d211f51e3cc43c98b7ee2254db7b90e9e8690` |
| 当前本地 `HEAD` | `44f5b932130ae7797d4fb0ddd93833f9f2268f71` |
| 本地额外提交 | `6141baabe8a46e0b54c277753d63ade93415e561` |
| 本地额外提交内容 | 重启时清空持久化 cooldown |
| 当前工作树 | 存在与本审计无关的 dirty/untracked 文件，未触碰 |

`6141baabe` 只改变重启加载路径：它把持久化 cooldown 条目清空，不再把条目转换为 startup probe 状态。它没有修复：

- priority 与 health score 的量纲耦合；
- 未进入 cooldown 的低分 provider 没有 probe 通道；
- 两个 runner 的重复 owner；
- global probe success 不恢复 score/streak/delta window；
- key probe success 与 rolling delta 不一致；
- HTTP 200 语义错误被视为 probe success；
- 503 的恢复策略分叉。

如果产品合同仍要求“重启只允许 probe 后重新接纳”，`6141baabe` 本身还是一项 P1 合同回归：重启后会先恢复可用投影，而不是等待成功 probe。若产品已经明确改成“重启完全重积分”，必须同步 design/map/test，不得只改实现。

## 证实的漏洞与风险

### P0-1：健康分可跨越配置 priority，造成永久 starvation

证据：

- `v3/crates/routecodex-v3-provider-responses/src/health.rs:1262-1304`
  - `scheduling_projection_for_key` 将 `score_milli` 转为 `effective_priority`。
- `v3/crates/routecodex-v3-provider-responses/src/key_health.rs:111-123`
  - `raw_adjustment = score_milli - 1000`；
  - priority 为正时只限制正向提升，负向下降没有对称下限。
- `v3/crates/routecodex-v3-provider-responses/src/health.rs:984-1045`
  - recoverable failure 每次调用 `record_health_delta(-50)`；
  - 前两次失败已经改变 score，第三次才建立 cooldown。
- `v3/crates/routecodex-v3-target/src/lib.rs:395-408`
  - Target 只保留最高 `effective_priority` bucket，其他 bucket 的选择概率为零。
- `v3/crates/routecodex-v3-provider-responses/tests/provider_key_health_contract.rs:208-217`
  - 正式测试明确锁定 `priority=10, score=900 -> effective_priority=-90`。

最小反例：

```text
高意愿 H: configured priority = 2, score = 1000
低意愿 L: configured priority = 1, score = 1000

H 一次 recoverable failure:
H score = 950
H effective priority = 2 - 50 = -48
L effective priority = 1

Target 只保留 L 所在的最高 bucket。
```

后续闭环：

```text
H 被降出最高 bucket
 -> H 没有业务流量
 -> H 没有成功样本
 -> H score 不恢复
 -> H 继续不被选择
```

这是调度活性/可用性漏洞，不是传统权限漏洞，但影响是 P0：

- 高质量、高意愿模型可能被一次瞬态错误长期软下线；
- 低意愿 provider 会吸附全部请求；
- 质量、成本、延迟和用户选择意愿发生长期偏移；
- 只看 provider available 或 cooldown 是否消失会误判恢复。

### P0-2：两个 probe runner 争用同一个 probe 状态，完整恢复路径被遮蔽

证据：

- `v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs:420-490`
  - `run_due_global_subscription_probes` 扫描
    `provider_cooldown_probe_keys_due`；
  - 成功调用 `complete_provider_cooldown_probe_success_at`。
- `v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs:492-569`
  - `run_due_provider_key_health_probes` 也扫描同一个
    `provider_cooldown_probes`；
  - 成功调用 `complete_provider_key_probe_success_at_generation`。
- `v3/crates/routecodex-v3-server/src/lib.rs:524-563` 和 `577-607`
  - startup 与每 60 秒循环都先运行 global，再运行 key-health。
- `v3/crates/routecodex-v3-provider-responses/src/health.rs:901-982`
  - global success 只调用 `record_adaptive_success`，然后删除 cooldown/probe；
  - `record_adaptive_success` 只更新 attempts、recovery EWMA、probe failure count；
  - 不恢复 score、不清 failure streak、不清 rolling delta。
- `v3/crates/routecodex-v3-provider-responses/src/health.rs:1082-1117`
  - key-health success 才会清 failure streak、将 score 设为 1000、删除 cooldown。

生产时序：

```text
global runner acquire
 -> global probe success
 -> 删除 provider_cooldown_probes
 -> 只部分更新 adaptive history
 -> key-health runner 再查询
 -> 找不到该 entry
```

这解释了“日志显示 probe 成功，但高优先级 provider 仍不回切”。

### P0-3：probe success 不是原子健康 epoch reset

证据：

- `health.rs:1082-1117` 的 key probe success 将 `score_milli` 设为 `1000`，
  但没有清除 `recent_deltas_milli`。
- `health.rs:1048-1070` 的真实成功继续调用 `record_health_delta(+10)`。
- `health.rs:1900-1904` 每次记录 delta 都按 rolling window 重新计算：
  `score_milli = clamp(1000 + sum(recent_deltas_milli), 0, 1500)`。

反例：

```text
三次失败: recent_deltas = [-50, -50, -50], score = 850
probe success: score = 1000，但 recent_deltas 仍保留
下一次真实 success: 重新计算为 1000 - 150 + 10 = 860
```

这会把“恢复成功”重新变成“健康下降”，造成状态真相不一致。它也是 P0，因为恢复后的第一笔成功可能反向污染刚完成的恢复。

### P0-4：只失败一两次、但已被 priority 淘汰的 provider 没有独立 probe 通道

证据：

- `health.rs:818-845` 的 `provider_cooldown_probe_keys_due` 只扫描
  `provider_cooldown_probes`。
- `health.rs:1191-1221` 的 key-health probe candidate 也只扫描
  `provider_cooldown_probes`。
- recoverable 第一次、第二次失败时，`health.rs:1029-1042` 尚未建立
  cooldown/probe entry。
- `health.rs:1262-1304` 的 score 已经会影响 priority。

因此，当前状态可能同时满足：

```text
score 已经足以让 provider 输掉 priority bucket
但 failure_streak 未达到 3
且 provider_cooldown_probes 中没有 entry
```

这种 provider 既没有业务流量，也没有后台 probe，是 P0 starvation variant。修复 priority/health 解耦后，这条路径自然消失；若仍保留 score 影响同层 weight，则必须另外建立明确的 canary/probe 通道。

### P1-1：503 的分类与计数策略分叉

证据：

- `v3/crates/routecodex-v3-error/src/subscription.rs:74`
  - `http_status_is_health_counted` 只包含 `429 | 500 | 502`，不包含 503。
- `subscription.rs:88-100`
  - 503 进入 `IrrecoverableGlobalCooldown`；
  - failure threshold 为 1；
  - 默认 cooldown 为 1 小时。
- `subscription.rs:102-106`
  - health-counted status 才进入 recoverable counted。

一次 503 可能因此触发一小时 provider 级封锁，而 500/502 走三次 recoverable 路径。503 常见于短暂过载、部署切换、模型启动和上游瞬态故障；这种路径差异会放大抖动并延长 failback。

建议将 503 归入 `RecoverableCounted`，并由 typed policy 明确 `Retry-After`、阈值、cooldown 和 probe delay；不要让 HTTP status 在多个入口各自决定恢复语义。

### P1-2：HTTP 2xx 不等于 probe 语义成功

证据：

- `v3/crates/routecodex-v3-runtime/src/provider_failure_global_probe.rs:106-124`
  - probe 只检查 `200..=299`；
  - 不解析 response body。
- `v3/crates/routecodex-v3-provider-responses/src/probe.rs:11-84`
  - probe 是真实低成本生成请求，但没有对应的统一 semantic success contract。

以下响应可能被错误视为成功：

```json
{"error":{"code":"invalid_api_key"}}
```

还应拒绝：

- JSON/SSE codec 失败；
- Responses `status=failed` 或 `incomplete`；
- 空结果或不属于请求模型的结果；
- provider 返回 2xx 但携带 quota/auth/rate-limit semantic error。

错误归因应在 provider response/inbound 与统一 error policy owner 完成，不应由 server handler 或 Target 猜测。

### P1-3：blocked deadline 与 probe deadline 被强行合并

证据：

- `health.rs:2038-2077`
  - `blocked_until_ms` 与 `next_probe_at_ms` 被写成同一个时间。
- `health.rs:756-759`
  - cooldown 到期不自动恢复，必须 probe 成功。

当前第一次 probe 不能早于业务 blocked deadline。若普通 recoverable cooldown 是 15 分钟，则初始 probe 也要等待 15 分钟；503 的一小时策略则会进一步放大等待。

正确模型应分离：

```text
business_blocked_until: 业务流量仍禁止
next_probe_at: 独立恢复判断时间
```

probe 可以较早执行，但只有 semantic success 才清除业务阻断。

### P2-1：固定 60 秒扫描造成恢复上界粗糙、资源利用低

证据：

- `v3/crates/routecodex-v3-server/src/lib.rs:564-606`
  - server 使用固定 60 秒 interval 扫描。

这不是永久吸附的根因，但会带来：

- failback latency 至少受扫描周期影响；
- 条目少时持续轮询；
- 条目多时同一 tick 产生 probe burst；
- 无法直接证明每个 provider 的恢复上界。

后续可以改为按最早 `next_probe_at` 驱动的 timer/min-heap。该优化必须在单一 probe owner 收口后进行，不应先通过调整轮询频率掩盖状态机错误。

### P2-2：设计文档、映射合同和实现语义不一致

设计文档：

- `docs/design/v3-provider-health-scoring-cooldown-design.md:12-15`
  要求 score、success、cooldown、probe 协同；
- `:97-105`
  要求 health projection 影响 priority；
- `:169`
  明确 score 不是 availability；
- `docs/goals/v3-provider-adaptive-health-cooldown-probe.md`
  记录 single owner、successful probe recovery、bounded probe ladder。

实现却存在三种 probe success 语义：

| 路径 | score | streak | rolling delta | cooldown/probe |
| --- | --- | --- | --- | --- |
| global success | 不恢复 | 不清 | 不清 | 清除 |
| key-health success | 设为 1000 | 清零 | 不清 | 清除 |
| real success | `+10` 后按 rolling window 重算 | 清零 | 保留 | 只清部分状态 |

这不是单纯参数不合适，而是状态机没有一个唯一 completion transition。

## 当前验证证据

本轮已运行：

| 检查 | 结果 |
| --- | --- |
| `provider_key_health_contract` | 19 passed |
| `provider_global_subscription_probe_contract` | 3 passed，2 failed |
| `routecodex-v3-target --lib` | 32 passed |
| `verify:v3-provider-key-health-model-binding` | passed |
| `verify:v3-module-boundaries` | failed；失败来自现有 dirty 的 `admin-webui/responses_relay_runtime` 范围，不是本审计新增改动 |
| 在线端口 | 4444、7777、5520 可达；5555、10000、8777 当前不可达 |

两个失败测试：

- `cooldown_expiry_only_makes_probe_due_and_success_probe_restores`
- `failed_probe_keeps_blocked_and_stretches_next_deadline`

它们集中在 cooldown expiry、probe due 和 probe completion 合同，说明当前本地更新后的恢复语义与既有测试合同已发生偏离。由于本轮是审计，不把测试失败改成“修复”。

## 推荐目标模型

### 1. 三个正交维度

```text
configured priority = 用户/配置意愿
health state        = 当前是否允许承接业务
weight              = 同意愿层内部如何分流
```

推荐选择顺序：

1. 先过滤 `Disabled / Open / Cooldown`；
2. 按 `configured_priority` 选择最高可用层；
3. 只在同一 priority 层使用 weight；
4. health score 只作为同层 weight 的轻微调整，或第一版完全不影响选择；
5. probe/canary 成功后恢复 `Healthy`，配置 priority 自动重新生效。

关键性质：

> 高 priority provider 一旦从某时刻开始持续 semantic healthy，且 probe 能持续成功，则必须在固定上界 `T` 内重新被选择。

当前实现不满足这个活性性质，因为它允许“业务选择概率 = 0，同时 probe 选择概率 = 0”。

### 2. 状态机

```text
Healthy
  -- 单次瞬态失败 --> 当前请求排除，累计 failure window
  -- 达到阈值 --> Open

Open
  -- next_probe_at --> HalfOpen

HalfOpen
  -- semantic probe 失败 --> Open + backoff
  -- semantic probe 成功 --> 一个 canary

canary
  -- 成功 --> Healthy
  -- 失败 --> Open
```

必须保持：

- HalfOpen 单飞；
- probe success/failure 使用唯一原子 transition；
- stale generation 不能清除更新后的失败状态；
- cooldown key 不能被 Target 直接选中；
- provider failure reselect 保持 target-local，不重新进入 Virtual Router；
- 控制状态只在 typed health/scheduling side-channel，不进入 payload。

## 分阶段优化策略

### P0：先恢复 failback 正确性

1. 在 `routecodex-v3-provider-responses` 保留唯一 probe owner。
2. 删除 global/key 两套对同一 map 的重复扫描和完成路径。
3. 增加唯一 typed `ProviderProbePermit`，至少包含 key、generation、cause。
4. 增加唯一 `complete_probe_success`：
   - 校验 generation；
   - 清 failure/success streak；
   - 清 `recent_deltas_milli`，或开启明确的新 score epoch；
   - 重置 score 到唯一规定的 recovery floor；
   - 清 probe failure/backoff；
   - 清 cooldown；
   - 一次性持久化并唤醒等待者。
5. 将 health score 从跨 priority 的 `effective_priority` 移除。
6. `Target` 只按配置 priority 选层，weight 只在同层生效。
7. 503 改为 recoverable policy，并补 typed policy 正反测试。
8. probe 成功必须验证 HTTP body/协议终态，不得只看 status code。

### P1：建立有界恢复

1. 分离 `business_blocked_until` 与 `next_probe_at`。
2. 推荐 transient probe 梯度：
   `15s -> 30s -> 1m -> 5m -> 15m -> 1h`。
3. 429 优先使用合法 `Retry-After`，但仍由统一 typed policy 生成下一次 probe deadline。
4. HalfOpen 只放行一个 probe/canary，避免高优先级 provider 抖动造成切换风暴。
5. 普通 transient 错误不跨重启保留过时 deadline；明确 auth/account-disabled 等 operator 状态是否持久化。
6. 若重启清空健康状态，必须同步设计/map/test；否则恢复为“startup probe 成功后再重新接纳”。

### P2：可观测性与调度效率

选择事件至少记录：

```text
provider/auth/model
configured_priority
effective_priority
health_score
circuit_state
available
failure_streak
probe_generation
next_probe_at
last_probe_result
selected/rejected_reason
```

建议指标：

- `provider_probe_success_but_not_selected_total`
- `provider_available_starved_duration_seconds`
- `provider_failback_latency_seconds`
- `provider_probe_semantic_failure_total`
- `provider_half_open_concurrency_violation_total`

当出现：

```text
probe_success
+ highest configured priority
+ selected=false 持续超过 T
```

应直接报警。

## 必须新增的回归合同

### 正向

1. `single_transient_failure_preserves_recovery_path`
2. `cooldown_probe_success_restores_configured_priority_selection`
3. `probe_success_starts_clean_score_epoch`
4. `single_probe_owner_completes_each_due_entry_once`
5. `http_200_without_semantic_error_is_probe_success`
6. `http_503_is_recoverable_counted`
7. `healthy_primary_has_bounded_failback_latency`
8. `half_open_allows_only_one_canary`

### 反向

1. `degraded_score_cannot_cross_configured_priority_bucket`
2. `probe_success_cannot_clear_newer_generation`
3. `probe_success_cannot_leave_old_delta_window_active`
4. `global_and_key_runner_cannot_consume_same_probe_entry`
5. `http_200_embedded_error_is_probe_failure`
6. `failed_probe_keeps_provider_blocked`
7. `cooldown_candidate_is_never_selected`
8. `flapping_primary_does_not_create_probe_storm`

端到端 property：

```text
若最高 configured-priority candidate 从时间 t 起持续 semantic healthy，
且后台 probe 每次成功，
则存在有限 T，使 t + T 前该 candidate 被重新选择。
```

这是本审计最重要的验收合同。没有它，单测通过仍不能证明动态 probe 有效。

## Owner 与实施边界

| 语义 | 唯一 owner | 禁止位置 |
| --- | --- | --- |
| failure classification/action | `routecodex-v3-error` | Provider store、Target、handler |
| score/streak/cooldown/probe transition | `routecodex-v3-provider-responses` | Router、handler、SSE、payload |
| probe transport + response semantic validation | provider probe/response codec adjacent owner | Target、server handler |
| configured priority / same-layer selection | `routecodex-v3-target` | Virtual Router 重建 health |
| provider failure reselect decision | 已登记 runtime Error05/Target-local edge | RespOutbound、handler fallback |
| client error projection | Error06/server projection owner | health/probe owner |

不要通过修改 handler、SSE、outbound、provider payload 或增加 fallback 解决这个问题。那样只能掩盖 starvation，不能恢复唯一健康状态真相。

## 最终判定

当前版本应判定为：

```text
动态 probe：可发送、部分可解封
自动 failback：不可靠
调度活性：未满足
瞬态抖动隔离：不充分
状态机 owner：重复/未收口
生产就绪：不通过
```

优先修复顺序不是调整 probe 频率，而是：

```text
priority/health 解耦
 -> 单一 probe owner
 -> 原子 probe completion
 -> semantic probe
 -> 503 policy 收口
 -> 有界 failback property
 -> timer/observability 优化
```
