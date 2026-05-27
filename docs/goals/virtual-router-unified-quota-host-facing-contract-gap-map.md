# Virtual Router Unified Quota Host-facing Contract Gap Map

## 索引概要
- L1-L8 `purpose`：本文定位与当前 closeout 结论。
- L10-L28 `verified-state`：已证实已完成的收口部分。
- L30-L63 `blocking-gaps`：为什么当前还不能删除 TS quota-manager。
- L65-L96 `contract-map`：现有 TS host-facing contract 与 Rust 缺口对照。
- L98-L138 `candidate-inventory`：当前可删候选、必须保留的桥接面、仍活跃 fallback。
- L140-L168 `cutover-sequence`：下一步唯一正确推进顺序。
- L170-L196 `proof-gates`：允许物理删除 TS quota-manager 前必须补齐的证据。

## 目的

本文只回答一个 closeout 问题：

```text
现在是否已经可以物理删除 sharedmodule/llmswitch-core/src/quota/quota-manager.ts ？
```

当前结论：不可以。

原因不是 route decision 仍受 TS `quotaView` 第二中心主导，而是 Rust 还没有提供完整的 host-facing quota contract，无法替代现存 TS `quota-manager.ts` 在 host/admin/persist/query/mutate 路径上的职责。

## 已证实已完成的收口部分

以下事项已经有当前证据支持：

1. route decision 已不再依赖 TS `quotaView` 第二决策中心；same-shape shadow compare 已证明带污染性 TS `quotaView` 与不带 `quotaView` 的结果一致。
2. runtime / HubPipeline / shadow path 上的 `quotaView` 注入/透传 dead bridge 已物理删除。
3. unified quota 模式下，provider success 已能正确恢复 core quota state，不再残留活跃 cooldown/blocker。
4. host snapshot / readOnly / daemon-admin `/quota/providers` 三层当前可以围绕 core TS `QuotaManager` 保持一致。
5. `HTTP_402/resetAt` family 与 `auth/fatal` family 已有 persist/hydrate/admin/recover focused proof。
6. `npm run build:dev`、global install、CLI SSE smoke、5555 restart 当前通过到 `0.90.2291`。

因此，当前剩余问题已经从“TS second center 会不会改写 route decision”转移为“Rust 是否已具备替代 host-facing quota contract 的能力”。

## 当前阻塞缺口

`sharedmodule/llmswitch-core/src/quota/quota-manager.ts` 仍不能删，原因有三类：

### 1. Rust quota 仍主要是 router-internal contract

当前 Rust `virtual_router_engine/quota.rs` 提供的是：
- `record_success`
- `record_error_signal`
- `freeze_quota_depleted`
- `snapshot()`
- `active_blocker()`

这足以支撑 route selection blocker / status 观察，但还不足以承担 host runtime 当前真实在用的 quota control plane。

### 2. host-facing contract 仍由 TS quota-manager 独占

当前 host 真实依赖的接口仍集中在 TS `QuotaManager`：
- `hydrateFromStore()`
- `persistNow()`
- `registerProviderStaticConfig()`
- `getSnapshot()`
- `getQuotaView()`
- `disableProvider()`
- `recoverProvider()`
- `resetProvider()`
- `onProviderError()`
- `onProviderSuccess()`

这些接口被以下主链直接消费：
- `src/manager/modules/quota/quota-manager.ts`
- `src/manager/modules/quota/quota-adapter.ts`
- `src/server/runtime/http-server/daemon-admin/quota-handler.ts`
- `src/server/runtime/http-server/daemon-admin/status-handler.ts` 的 `provider-quota` reset alias/fallback

### 3. Rust 还缺 host 所需字段与语义

Rust 当前 quota snapshot 不承载或未证明承载：
- `authType`
- `authIssue`
- `priorityTier`
- 通用 `cooldownKeepsPool` / selection penalty 投影
- `HTTP_402/resetAt` 的 host-facing持久化恢复 contract
- auth/fatal sanitize-after-restart contract
- admin mutate/query 所需稳定 DTO
- QuotaStore hydrate/persist 契约

只要这些 contract 未被 Rust 直接提供，删除 TS quota-manager 就会打断 `/quota/providers`、persist/hydrate、admin reset/recover/disable，以及现有 provider-quota fallback 兼容层。

## TS 现有 contract → Rust 缺口对照

| 现有 TS 职责 | 当前消费方 | Rust 是否已有等价 contract | closeout 结论 |
|---|---|---|---|
| `hydrateFromStore()` | `QuotaManagerModule.init()` | 否 | 必须先补 Rust/bridge hydrate contract |
| `persistNow()` | `QuotaManagerModule.stop()/reset/recover/disable` | 否 | 必须先补 Rust/bridge persist contract |
| `registerProviderStaticConfig()` | host provider bootstrap | 部分；router 内注册 provider keys，不等价 | 仍缺 host-facing static config contract |
| `onProviderError()/onProviderSuccess()` | runtime quota hooks | 部分；Rust 有 router event mutation | 还缺对 host snapshot/persist/admin 的直接导出 contract |
| `getSnapshot()` | admin/readOnly/projection | 否，Rust `status().quota` 形状不足 | 必须先定义稳定 host snapshot DTO |
| `getQuotaView()` | host readOnly/admin adapter | 否 | 需桥接 Rust availability snapshot → host readOnly view |
| `disable/recover/resetProvider()` | admin mutate | 否 | 必须先补 Rust admin mutate API |
| `HTTP_402/resetAt` hydrate/recover | focused regressions | 否 | 需 Rust 原生持久化与恢复语义 |
| `auth/fatal` sanitize on restart | focused regressions | 否 | 需 Rust 原生 sanitize contract |

## 当前删除候选 / 保留面清单

这部分只回答“现在哪些面已经确认不是 route decision 真源、但暂时还不能删”，以及“哪些 fallback 仍是 live contract”。

### A. 已确认不再属于 route decision 真源，但仍是 host-facing bridge 的面

以下职责当前已被证实不再主导 availability policy，只服务 host/admin/query/persist：

1. `src/manager/modules/quota/quota-manager.ts`
   - `getQuotaViewReadOnly()`
   - `getAdminSnapshot()`
   - `persistNow()`
   - `refreshNow()`
   - 结论：读桥 / 持久化桥 / admin 观察面，暂不可删。

2. `src/manager/modules/quota/quota-adapter.ts`
   - `getAdminSnapshot()`
   - `readRustHostSnapshot()`
   - control/quota handler 的 adapter facade
   - 结论：admin/query shell，暂不可删；最终应继续收缩成纯 Rust snapshot 投影壳。

3. `sharedmodule/llmswitch-core/src/quota/quota-manager.ts`
   - `getSnapshot()`
   - `getQuotaView()`
   - `persistNow()`
   - `hydrateFromStore()`
   - 结论：当前仍承担 host-facing state machine，不能误删；但它已不是 route decision 真源。

### B. 已确认可继续推进物理删除的旧第二中心

以下面已经有 closeout 证据，不应再回流：

1. `sharedmodule/llmswitch-core/src/router/virtual-router/health-manager.ts`
2. `sharedmodule/llmswitch-core/src/router/virtual-router/engine/cooldown-manager.ts`

这两处已被物理删除，说明“router-local health/cooldown TS 第二中心”不再是保留选项。

### B1. 已被 focused proof 证明仍必须保留的 live fallback

1. `QuotaManagerModule.getQuotaViewReadOnly()` / `getAdminSnapshot()` -> `core.getSnapshot()`
   - 在有 hubPipeline / Rust host snapshot 时，这层只是第二优先级 fallback；
   - 但在 unified quota 已开启、且 `getHubPipeline()` 缺失的场景，它仍是 live contract；
   - 已有 focused proof 证明：若没有它，no-hubPipeline unified 场景下的 admin/readOnly 投影会直接失真。

### C. 当前仍活着、但只能作为过渡桥的 fallback

这些分支当前仍是 live contract，不能口头当作“已经删掉”：

1. `QuotaManagerModule.init()/stop()/persistNow()`
   - `hydrateRustQuotaHostSnapshotFromStore(...)` 失败时回落 `coreManager.hydrateFromStore()`
   - `persistRustQuotaHostSnapshotToStore(...)` 失败时回落 `coreManager.persistNow()`
   - 结论：这是 host persist/hydrate fallback，不是 route decision fallback；删它前必须先补 Rust persist/hydrate contract focused proof。

2. `QuotaManagerModule.start()`
   - 若拿不到 Rust `handleProviderError/handleProviderSuccess`，仍回落 `coreManager.onProviderError/onProviderSuccess`
   - 结论：这是 runtime event bridge fallback；删它前必须证明 Rust hooks 在统一主链上已成为强制前提。

3. `QuotaManagerModule.reset/recover/disableProvider()`
   - 若拿不到 Rust mutate API，仍回落 TS `coreManager`
   - 结论：这是 admin mutate fallback；删它前必须证明 Rust reset/recover/disable contract 在所有 live 入口可用。

4. `status-handler.ts` 的 `provider-quota` alias/reset fallback
   - 当前仍是 live UI/admin 兼容契约
   - 结论：删它前必须先用 Rust host snapshot + mutate/persist contract 替掉整条 alias 语义。

### D. 当前最接近可删的残留

从 closeout 角度，最接近“先删职责、后删文件”的是：

1. `createQuotaManagerAdapter().onProviderError/onProviderSuccess`
   - 已确认 unified path 无真实 runtime consumer；
   - 本轮已从 adapter 接口与实现中物理删除；legacy 行为改由 `ProviderQuotaDaemonModule.onProviderSuccess()` 直测覆盖。

2. `QuotaManagerModule.getQuotaView() -> coreManager.getQuotaView()`
   - 当前 route decision 已证明不再消费该接口；
   - unified 模式的 `QuotaManagerModule.getQuotaView()` 已收口到 `getQuotaViewReadOnly()`，不再直接暴露 `coreManager.getQuotaView()`；
   - 已删除 `createQuotaManagerAdapter().getQuotaView()` 中对 `core.getQuotaView()` 的最后回退，当前 unified host path 只保留 Rust host snapshot -> `core.getSnapshot()` -> legacy view；
   - 本轮继续从 bridge/core-like type surface 中移除了 `getQuotaView` 声明，证明 unified path 已不再依赖这层桥接类型；
   - 结论：`core.getQuotaView()` 已不再是 unified host path 的 live 读取面，剩余保留主要只属 legacy/compat/test surface。

## 下一步唯一正确推进顺序

### Step 1：先定义 Rust host-facing quota contract

至少明确以下桥接 API 或 snapshot/export contract：
- Rust availability/quota snapshot DTO
- Rust admin mutate API：`reset/recover/disable`
- Rust persist/hydrate contract
- Rust static config registration contract
- Rust special-family contract：`402/resetAt`、`auth/fatal sanitize`

### Step 2：用 focused proof 把 host-facing contract 补齐

不是先删 TS，而是先让下列证据成立：
- admin `/quota/providers` 直接消费 Rust snapshot，不再依赖 TS state machine 二次投影
- persist/hydrate round-trip 直接走 Rust contract
- `provider-quota` reset alias/fallback 要么被替代，要么被正式删除并同步更新测试与 UI 契约

### Step 3：在 shadow/replay 之外再做一次 host-facing closeout audit

需要重新逐项确认：
- route decision
- host snapshot
- readOnly view
- admin query/mutate
- persist/hydrate
- special family
- multi-key isolation
- last-provider guard

全部都直接或唯一依赖 Rust 真源后，才允许进入物理删除。

## 允许删除 TS quota-manager 前必须补齐的证明门槛

以下任一缺失，都不得宣称可以删除 `sharedmodule/llmswitch-core/src/quota/quota-manager.ts`：

1. Rust 已提供稳定的 host-facing snapshot DTO，且 `/quota/providers` 已直接消费该 DTO。
2. Rust 已提供 persist/hydrate contract，且 focused test 证明重启后 state 不依赖 TS quota-manager 恢复。
3. Rust 已提供 admin mutate contract（reset/recover/disable），并覆盖 focused regression。
4. `HTTP_402/resetAt` 与 `auth/fatal` family 的 host/admin/persist/recover 语义已由 Rust 直接保证。
5. `tests/server/daemon-admin/status-handler-reset-provider-quota-fallback.spec.ts` 对应兼容层已被新契约替代或删除，并同步修正测试与实现。
6. 删除后 `QuotaManagerModule`、`quota-adapter`、`quota-handler` 不再持有第二状态机，只剩桥接/查询展示壳。

在这些门槛满足之前，当前唯一正确叙事是：

- Rust 已成为 route decision / availability policy 的主真源；
- 但 host-facing quota control plane 仍未完全 rustified；
- TS `quota-manager.ts` 还不是可删除死代码。
