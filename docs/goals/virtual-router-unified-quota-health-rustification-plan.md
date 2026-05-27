# Virtual Router Unified Quota / Health / Availability Rustification Plan

## 索引概要
- L1-L10 `goal`：目标、范围与本计划定位。
- L12-L31 `current-state`：当前双中心现状与已确认真相。
- L33-L49 `target-architecture`：收口后的唯一真源架构。
- L51-L76 `invariants`：必须长期成立的约束。
- L78-L109 `phase-a`：真相审计 + 红测 / replay / shadow 基线。
- L111-L138 `phase-b`：Rust 状态机补齐（quota/health/availability 统一模型）。
- L140-L165 `phase-c`：事件接线与 shadow 对比，不切主。
- L167-L191 `phase-d`：切主到 Rust route decision，并收缩 TS 为桥。
- L193-L213 `phase-e`：物理删除 TS 第二决策中心与收尾验证。
- L215-L248 `test-matrix`：测试与 replay/shadow 覆盖矩阵。
- L250-L276 `file-ownership`：文件责任与唯一修改面。
- L278-L298 `done-definition`：完成标准。

## 目标

把 Virtual Router 的 quota / health / availability 统一收口到 Rust `virtual_router_engine`，让：

```text
provider error/success
  -> availability state
  -> route decision
```

全链路只有一个真源：

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/`

本计划是实施真源，不是历史说明。若后续实现与本文冲突，以“先更新本文，再改代码”为准。

## 当前双中心现状（已确认）

### Rust 侧已存在的真源骨架
- `virtual_router_engine/health.rs`
- `virtual_router_engine/engine/events.rs`
- `virtual_router_engine/engine/selection.rs`
- `virtual_router_engine/quota.rs`

Rust 已经承担：
- provider success / error 事件入口的一部分健康态更新；
- provider unavailable details / recoverable cooldown hints 生成；
- route selection 时对 health 状态的过滤；
- 对 JS `quotaView` 的只读桥接。

### TS 侧仍保留的第二决策中心
- `sharedmodule/llmswitch-core/src/quota/quota-manager.ts`
- `sharedmodule/llmswitch-core/src/router/virtual-router/health-manager.ts`
- `sharedmodule/llmswitch-core/src/router/virtual-router/engine/cooldown-manager.ts`
- `src/manager/modules/quota/*`
- `quotaView` 注入链：HTTP server / HubPipeline / VirtualRouterEngine deps

### 已确认问题
1. `quota.rs` 当前只是读取 JS `quotaView`，不是 Rust 自己维护 quota state。
2. availability 判定仍同时依赖：
   - Rust `health_manager`
   - TS `quotaView`
   - TS cooldown persistence
3. last-provider guard 的行为资产存在，但目前分散在 TS health path / request-executor recoverable wait / Rust unavailable details 之间，仍不是完全单中心。
4. 多 key (`providerKey`) 独立配额与最后一个 provider 恢复策略还没有在 Rust 状态机中被明确固化为唯一模型。

## 收口后的目标架构

### 唯一真源
所有 availability policy 必须收口到 Rust：

- `health.rs`：providerKey 级健康/熔断/冷却状态机
- `quota.rs`：providerKey 级 quota 状态机（包括 exhausted / resetAt / penalty / blacklist / short cooldown）
- `engine/events.rs`：provider success/error -> Rust state mutation 唯一入口
- `engine/selection.rs`：route decision 只消费 Rust availability snapshot

### TS 允许保留的职责
TS Host / Quota / Health 只允许保留：
- provider error/success 事件桥接到 Rust
- 持久化存取（如果底层仍需 TS IO 容器）
- 查询展示壳（admin/quota/status API）
- shadow / replay harness

TS 不再允许：
- 再做第二次 availability 决策
- 再单独维护 cooldown/blacklist 真相
- 再通过 `quotaView` 改写路由结果

## 必须长期成立的约束（Invariants）

1. 唯一真源：route decision 不得再依赖 TS 第二决策中心。
2. 多 key 隔离：quota / health / availability 必须按 `providerKey` 独立管理。
3. quota exhausted 只冻结当前 `providerKey`，不得误伤同 provider 家族其他 key。
4. 最后一个 provider 永远不能被永久打空；只允许短暂冷却后恢复可选。
5. success 必须能精确恢复当前 `providerKey` 的短期失败态；不得全局误恢复。
6. `resetAt` / daily reset / weekly reset 等恢复时间必须进入 Rust 明确字段与判定，不得靠 TS 文案猜测长期主导。
7. recoverable cooldown hints 由 Rust 生成；request-executor 只消费，不再自行重算第二套策略。
8. TS/Rust 双真源只允许在 shadow 过渡期短暂共存；进入 Phase D 后必须以 Rust 为主，Phase E 物理删除残留。

## Phase A：真相审计 + 红测 / replay / shadow 基线（不切主）

### 目标
在不改主行为的前提下，把当前行为基线锁死，避免后续 Rust 收口时“看起来能跑但语义漂移”。

### 必做项
1. 审计现有 provider error/success 事件字段：
   - 若 `ProviderErrorEvent` / `ProviderSuccessEvent` 字段不足，先补标准化字段，再继续 Rust 主链接线。
2. 新增/整理 Rust 单测红绿矩阵，覆盖：
   - transient
   - fatal
   - quota exhausted
   - resetAt
   - last-provider
   - multi-key isolation
3. 形成 replay/shadow 对比输入集：
   - 至少覆盖 429、503、fatal auth、recoverable transport、success reset、多 key route pool。
4. 为当前 TS 决策链和 Rust 决策链产出同 shape 观测结果，建立 diff 报告入口。

### Phase A 验收
- 红测能证明当前缺口或未来 guard 的必要性。
- replay/shadow 输入样本固定。
- 不修改主链选择结果，只增加证据与观测。

## Phase B：Rust 状态机补齐（不切主）

### 目标
让 Rust 具备完整 quota / health / availability 数据模型，但暂时仍处于 shadow 或桥接模式。

### 必做项
1. 补齐 Rust `quota.rs`：从“JS quotaView 读桥”升级为 Rust quota state 结构与判定逻辑。
2. 定义 Rust availability snapshot：
   - providerKey
   - in_pool / selectable
   - reason
   - cooldown_until
   - blacklist_until
   - reset_at
   - selection_penalty
   - last_error_at
   - consecutive_error_count
   - last_provider_guard_applied
3. 把 last-provider guard 写进 Rust 状态机，不再只靠 TS path 辅助保底。
4. 把 `quota exhausted only freezes current providerKey` 与 `last provider recovers after short cooldown` 固化成 Rust 规则与单测。

### Phase B 验收
- Rust 单测已能独立证明 quota/health/availability 规则。
- 即便不接入 TS quotaView，Rust 内部模型也能表达完整状态。
- 仍不切主路由，只做 shadow-ready。

## Phase C：事件接线 + Shadow / Replay 对比（不切主）

### 目标
把真实运行时 provider error/success 事件接到 Rust 状态机，但对外仍以当前主链为准，先比较结果是否收敛。

### 必做项
1. provider success/error 事件统一进 `engine/events.rs`。
2. 建立 Rust state snapshot 导出，用于：
   - shadow compare
   - replay harness
   - focused regression diff
3. request-executor / HubPipeline 增加对比日志：
   - TS decision
   - Rust shadow decision
   - diff reason
4. 修到 replay/shadow 收敛；收敛前不得切主。

### Phase C 验收
- shadow/replay 对比已收敛到可解释范围。
- 所有剩余 diff 都有明确归因，不存在“原因不明但先上线”。

## Phase D：切主到 Rust route decision，TS 收缩为桥

### 目标
route decision 正式只吃 Rust availability 真相；TS 不再作为第二决策中心。

### 必做项
1. Rust `engine/selection.rs` 只消费 Rust quota+health snapshot。
2. 禁止 `quotaView` 再直接决定 in-pool / cooldown / blacklist。
3. TS `QuotaManager` / TS `ProviderHealthManager` / TS `CooldownManager` 收缩为：
   - bridge
   - persistence shell
   - query view
4. request-executor recoverable wait 继续消费 Rust `recoverableCooldownHints`，但不再自行推导 availability policy。

### Phase D 验收
- route decision 不再依赖 TS 第二决策中心。
- focused regression 全绿。
- build:dev / install / smoke 通过。

## Phase E：删除 TS 第二决策中心 + 文档收尾

### 目标
物理删除重复状态机与旧路径，完成 Rust-only closeout。

### 必做项
1. 删除或清空以下“第二决策中心”职责：
   - TS `health-manager.ts` 中实际判定逻辑
   - TS `cooldown-manager.ts` 中 router-local cooldown 真相
   - TS `quota-manager.ts` 中会影响 route decision 的第二判定逻辑
   - `quotaView` 注入主决策能力
2. 更新相关文档/测试，使其明确 Rust 为唯一真源。
3. 清理过渡期 shadow wiring、diff only helper、旧注释叙事。

### Phase E 验收
- 不存在 TS/Rust 双真源长期共存。
- 所有旧逻辑要么被桥接壳化，要么被物理删除。
- 文档、MEMORY、note 已同步。

## 测试 / Replay / Shadow 覆盖矩阵

### Rust 单测必须覆盖
1. transient failure -> 短冷却 / 正常恢复
2. fatal failure -> 更长冷却，但 last-provider 不永久熔断
3. quota exhausted with resetAt -> 当前 providerKey 冻结到 resetAt 或短冷却策略
4. quota exhausted without resetAt -> fail-fast + 明确 fallback-free 策略（不是吞错）
5. multi-key isolation -> A key exhausted 不影响 B key
6. success reset -> 对应 providerKey 状态恢复
7. last-provider guard -> 单 provider / 多 provider 剩一可用 provider 两类场景
8. recoverable cooldown hints -> 输出 waitMs/source/providerKey 正确

### Replay / Shadow 必须覆盖
1. 429 short-lived
2. 429 quota exhausted
3. 503 daily/unavailable
4. auth fatal
5. transport recoverable
6. success after cooldown
7. same provider family multi key rotation
8. singleton route pool / last provider wait-and-recover

### Focused regression
- `tests/sharedmodule/virtual-router-provider-unavailable-cooldown-native.spec.ts`
- `tests/sharedmodule/virtual-router-health-last-provider.spec.ts`
- `tests/servertool/virtual-router-quota-health-override.spec.ts`
- `tests/server/runtime/http-server/request-executor.spec.ts` 中 recoverable cooldown wait / singleton wait 相关用例
- 所有新增 Rust virtual router 定向单测

### 最终验证
1. focused regression 通过
2. replay/shadow 对比收敛
3. `npm run build:dev` 通过
4. installed binary / runtime smoke 通过

## 文件责任与唯一修改面

### Rust 真源
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/health.rs`
- `.../quota.rs`
- `.../engine/events.rs`
- `.../engine/selection.rs`
- 必要时：`.../engine/types.rs` / `.../engine/status.rs`

### TS 桥接 / 展示壳
- `sharedmodule/llmswitch-core/src/quota/quota-manager.ts`
- `sharedmodule/llmswitch-core/src/router/virtual-router/health-manager.ts`
- `sharedmodule/llmswitch-core/src/router/virtual-router/engine/cooldown-manager.ts`
- `src/manager/modules/quota/*`
- `src/server/runtime/http-server/*` 中 quotaView / runtime wiring / admin view

### 规则
- availability policy 改动必须落在 Rust。
- TS 若仍出现“直接决定 provider 是否可选”的逻辑，视为违规残留。
- 删除旧逻辑时必须物理删除，不允许仅闲置。

## 完成标准（Done Definition）

只有同时满足以下条件，才算本目标完成：

1. Rust 成为 quota/health/availability 唯一真源。
2. route decision 不再依赖 TS 第二决策中心。
3. last-provider guard 稳定生效。
4. quota exhausted 只冻结当前 providerKey；多 key 隔离稳定。
5. 最后一个 provider 永远不能被永久打空，只允许短暂冷却后恢复可选。
6. Rust 单测、shadow/replay、focused regression、`npm run build:dev`、installed binary / runtime smoke 全部通过。
7. 旧 TS 重复逻辑已物理删除或收缩成纯桥接/展示壳，无长期双真源残留。
