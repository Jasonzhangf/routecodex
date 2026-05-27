# Virtual Router Unified Quota Rust Host-facing Contract Implementation Slice

## 索引概要
- L1-L8 `purpose`：本文定位与本轮推进目标。
- L10-L35 `field-audit`：现有 ProviderErrorEvent / ProviderSuccessEvent 是否足够。
- L37-L78 `minimal-contract`：最小 Rust host-facing quota contract 定义。
- L80-L121 `bridge-sequence`：分 Phase 接线顺序，避免一次性硬切。
- L123-L158 `red-tests`：实施前必须先补的 focused red tests。
- L160-L196 `cutover-guards`：切主/删 TS 前必须满足的门禁。

## 目的

本文承接：
- `docs/goals/virtual-router-unified-quota-health-rustification-plan.md`
- `docs/goals/virtual-router-unified-quota-host-facing-contract-gap-map.md`

回答下一步真正该做什么：

```text
在不盲删 TS quota-manager 的前提下，Rust host-facing quota contract 的最小 implementation slice 是什么？
```

结论：现有 `ProviderErrorEvent` / `ProviderSuccessEvent` 字段已基本足够支撑下一阶段接线；当前缺口主要不在事件字段，而在 Rust 没有把 quota state 以 host 可消费的 snapshot / mutate / persist contract 暴露出来。

## 事件字段审计结论

### 现有字段已经足够的部分

当前 host/core 共用事件类型已经具备以下关键字段：

`ProviderErrorEvent`
- `runtime.providerKey`
- `runtime.routeName`
- `status`
- `recoverable`
- `affectsHealth`
- `fatal`
- `cooldownOverrideMs`
- `quotaScope`
- `quotaReason`
- `resetAt`
- `errorClassification`
- `details`
- `timestamp`

`ProviderSuccessEvent`
- `runtime.providerKey`
- `runtime.routeName`
- `metadata`
- `details`
- `timestamp`

这些字段已足够支撑：
1. providerKey 级别 isolation
2. recoverable / fatal / special_400 family 判定
3. `QUOTA_DEPLETED + resetAt` 进入 Rust quota state
4. success 恢复对应 providerKey 状态

### 当前真正不足的不是事件字段

当前更大的问题是：
- Rust `VirtualRouterEngineProxy` 只有：
  - `handle_provider_error`
  - `handle_provider_success`
  - `get_status`
- 其中 `get_status().quota` 只是 router-internal snapshot，形状不足以直接替代 host quota control plane。

因此，本轮不应先扩事件字段，而应先补 Rust host-facing contract。

### 仅在以下情形才需要补事件字段

只有当后续实施中发现以下信息必须由事件直接进入 Rust、且无法从现有 config/store 恢复时，才需要新增字段：
- `authType`
- `priorityTier`
- `apikeyDailyResetTime`
- host-side sanitize policy version / snapshot schema version

在当前证据下，这些更适合通过 static config / persist contract 注入，而不是继续扩散到 runtime event。

## 最小 Rust host-facing quota contract

### A. Rust host snapshot DTO

新增一个稳定、面向 host 的 quota snapshot DTO，至少包含：
- `providerKey`
- `inPool`
- `reason`
- `authType`
- `authIssue`
- `priorityTier`
- `cooldownUntil`
- `cooldownKeepsPool`
- `blacklistUntil`
- `resetAt`
- `lastErrorSeries`
- `lastErrorCode`
- `lastErrorAtMs`
- `consecutiveErrorCount`
- `selectionPenalty`
- `lastProviderGuardApplied`

注意：
- 这不是 route decision 新真源；route decision 仍只吃 Rust internal state。
- 这是给 TS host/admin/query shell 用的稳定观察面。

### B. Rust static config registration contract

需要有显式接口把 host provider static config 注册进 Rust：
- `providerKey`
- `authType`
- `priorityTier`
- `apikeyDailyResetTime`

原因：
- 当前 TS `registerProviderStaticConfig()` 仍是 402/resetAt fallback、priorityTier、authType 的来源。
- 若不先把这层迁进 Rust，host snapshot 无法完整 rustify。

### C. Rust admin mutate contract

需要显式接口，而不是继续由 TS state machine 托管：
- `resetProvider(providerKey)`
- `recoverProvider(providerKey)`
- `disableProvider({ providerKey, mode, durationMs, reason? })`

这些 mutate 必须直接改 Rust quota state；TS 只保留 admin route shell。

### D. Rust persist/hydrate contract

需要一个可桥接的 snapshot serialize / hydrate contract：
- `exportQuotaSnapshot()`
- `hydrateQuotaSnapshot(snapshot)`

要求：
- 保持 providerKey 级状态完整 round-trip
- 明确 schema version
- 对 `auth/fatal` family 支持 hydrate sanitize 规则
- 对 `402/resetAt` family 支持恢复后继续可观测/可恢复

## 分 Phase 最小接线顺序

### Slice 1：先补导出，不切主

1. Rust 提供 host snapshot DTO 导出接口
2. TS 新增只读 bridge，读取 Rust snapshot
3. focused test 比较：
   - TS `QuotaManager.getSnapshot()`
   - Rust host snapshot DTO
   - `/quota/providers`

此阶段不切 admin mutate/persist。

### Slice 2：再补 static config + mutate

1. host provider bootstrap 把 static config 注册给 Rust
2. admin `reset/recover/disable` 改为直接调 Rust mutate API
3. TS quota-manager 保留读桥与 persist shell，不再负责状态 mutation

### Slice 3：最后补 persist/hydrate

1. 持久化改为直接存 Rust host snapshot
2. 重启 hydrate 直接恢复 Rust quota state
3. `quota-handler` / `quota-adapter` 改为只投影 Rust snapshot

### Slice 4：清理兼容层

当且仅当以上三步都完成后，才允许：
- 删除 `sharedmodule/llmswitch-core/src/quota/quota-manager.ts` 中剩余状态机职责
- 删除 `status-handler.ts` 的 `provider-quota` alias/reset fallback
- 同步修正测试/UI 契约

## 实施前必须先补的 focused red tests

### Red test 1：Rust host snapshot contract

目标：证明当前 Rust `get_status().quota` 形状不足，不能直接替代 host snapshot。

建议新增测试入口：
- `tests/sharedmodule/virtual-router-rust-host-quota-snapshot-contract.spec.ts`

锁定点：
- 缺 `authType/authIssue/priorityTier/lastErrorSeries/lastErrorCode`
- 缺 stable host DTO shape

### Red test 2：Rust mutate API contract

目标：证明当前 admin `reset/recover/disable` 仍必须依赖 TS quota-manager。

建议新增测试入口：
- `tests/server/daemon-admin/quota-rust-host-mutate-contract.spec.ts`

锁定点：
- 若仅有当前 Rust proxy，admin mutate 无法直接改 Rust quota state

### Red test 3：Rust persist/hydrate contract

目标：证明当前重启恢复仍依赖 TS quota-manager hydrate 语义。

建议新增测试入口：
- `tests/server/daemon-admin/quota-rust-host-persist-hydrate-contract.spec.ts`

锁定点：
- `402/resetAt`
- `auth/fatal sanitize`
- success after hydrate

### Red test 4：provider-quota alias closeout gate

目标：锁定 `status-handler.ts` 当前 fallback 仍是 live contract，不得口头删除。

现有测试：
- `tests/server/daemon-admin/status-handler-reset-provider-quota-fallback.spec.ts`

下一步不是删除它，而是等 Rust mutate/persist contract 补齐后，再替换其行为与测试预期。

## 切主/删 TS 前的强制门禁

以下门禁未满足前，不得宣称 host-facing quota 已 rustified：

1. `ProviderErrorEvent` / `ProviderSuccessEvent` 不再需要额外字段补丁，或补丁已先落盘并覆盖测试。
2. Rust host snapshot DTO 已存在，且 `/quota/providers` 可直接消费。
3. Rust mutate API 已存在，且 `reset/recover/disable` 已不再经 TS quota-manager 改状态。
4. Rust persist/hydrate contract 已存在，且 focused proof 覆盖：
   - `402/resetAt`
   - `auth/fatal sanitize`
   - success after hydrate
5. `provider-quota` alias/fallback 已被新 contract 替代或删除，并同步测试。
6. 删除 TS quota-manager 后，route decision / host snapshot / admin query/mutate / persist 都不回退到第二状态机。

在这些门禁满足前，当前唯一正确推进方式是：
- 先补 Rust host-facing contract
- 再迁 host/admin/persist
- 最后删 TS 状态机

而不是直接继续做“删除 TS quota-manager”的表面 closeout。
