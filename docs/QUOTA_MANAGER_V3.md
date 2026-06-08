# Quota Manager V3（统一控制面 / Rust 路由真源）

## 目标

- 把 quota 生命周期收口成单一路径：初始化 → Rust host hydrate → admin/control mutate → Rust Virtual Router 选路消费 → 持久化回写。
- quota 真状态必须以 Rust quota host 为准；TS 只允许保留 lifecycle / persist / admin bridge。
- 禁止多重实现：daemon-admin、control-handler、quota-handler 不得各自再造 quota adapter / mutator / snapshot 入口。
- 禁止路由空集修补散落：`route non-empty / route availability floor` 的 owner 只能在 Rust Virtual Router selection。

## 当前真源分层

- Rust 路由真源
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/selection.rs`
  - 负责 quota/health 参与后的最终 route selection，以及后续“路由不能空”不变量。
- Rust provider runtime ingress/bridge
  - `sharedmodule/llmswitch-core/src/native/router-hotpath/native-provider-runtime-ingress.ts`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/provider_runtime_ingress.rs`
  - 负责 runtime 侧 provider error/success 进入 Rust router policy。
- Host 管理模块唯一控制面
  - `src/manager/modules/quota/quota-manager.ts`
  - 负责 store hydrate/persist、manager lifecycle、对外暴露唯一 `getControlSurface()`
- 控制面薄壳
  - `src/manager/modules/quota/quota-adapter.ts`
  - 只允许保留统一 control surface 薄桥；禁止再长第二套 quota 语义。
- Admin / Control HTTP 入口
  - `src/server/runtime/http-server/daemon-admin/quota-handler.ts`
  - `src/server/runtime/http-server/daemon-admin/control-handler.ts`
  - 只能调用 `QuotaManagerModule.getControlSurface()`，禁止自建 `createQuotaManagerAdapter(...)`，禁止直连 virtual router mutator。

## 生命周期

### 1. 初始化

- `QuotaManagerModule.init(...)` 绑定 `ManagerContext`
- 启动时必须先从当前 `config.toml` materialized `virtualrouter.providers` 取“本次配置内 provider 集”
- 不在当前配置里的历史 provider，禁止 hydrate 回 Rust quota host，禁止参与本轮 quota 初始化
- 若 runtime 可见 Rust quota host，则优先从 store hydrate 到 Rust host
- `QuotaManagerModule` 内部缓存唯一 `controlAdapter`
- 模块重新 init 时必须清空旧 `controlAdapter`，防止跨 runtime 污染

### 2. 进入 quota

- provider error / quota depletion / operator disable 等事件，最终都应进入 Rust quota host state
- admin/control 面的 `reset / recover / disable / clearCooldown / restoreNow / setQuota`
  - 必须统一走 `QuotaManagerModule.getControlSurface()`
  - 由同一个 adapter 转发到 Rust host mutate

### 3. 排除 quota

- clear cooldown / recover / reset 仍通过统一 control surface 回到 Rust host
- 禁止 handler 直接调用第二套恢复逻辑
- 禁止 TS core manager 与 Rust host 各做一份恢复判断

### 4. 生命周期持久化

- `QuotaManagerModule.persistNow()` 负责从 Rust host snapshot 回收并写入 store
- persist 只允许写回当前配置内 provider；过期历史 provider 不得继续写回
- `QuotaManagerModule.getAdminSnapshot()` / `getQuotaViewReadOnly()` 统一从 Rust host snapshot 读
- TS manager 仅保留 lifecycle / persistence / bridge，不再拥有独立路由语义真相

## 硬规则

- 单一控制面：只允许 `QuotaManagerModule.getControlSurface()`
- 单一 mutate owner：只允许 control surface 内部调用 Rust host mutator
- 单一 read owner：只允许 `QuotaManagerModule.getAdminSnapshot()` / `getQuotaViewReadOnly()`
- daemon-admin 禁止：
  - 自建 `createQuotaManagerAdapter(...)`
  - 直连 `getVirtualRouter().resetProviderQuota/...`
  - 自己拼第二份 quota snapshot DTO 真相
- “路由不能空” 禁止：
  - 在 handler / executor / provider runtime / quota adapter 层补 fallback
  - 在 TS 层做第二份 candidate recover 逻辑
- default 池保底规则：
  - 选路顺序固定为：高优先级池 → 低优先级池 → `default` 池
  - 只要 `default` 池存在 provider，就不允许返回空池
  - `default` 池最后一个选择不可被 health/quota/concurrency 过滤整体清空；该保底只能在 Rust selection 内实现

## 路由不能空（待 Rust closeout）

- 当前已补上 `default` 池 route availability floor：即使 health/quota/concurrency 让 default 候选都不可用，Rust selection 仍保留 default 最后一跳，不返回空池。
- 后续真正的 `route availability floor` 必须在 Rust Virtual Router selection 落地：
  - 当 quota/health/filter 共同作用后，不允许 route pool 静默掉空
  - 若无法满足 contract，必须显式给出统一错误/证据，而不是在 TS 外围补第二套兜底
- 该能力必须登记到 `docs/architecture/function-map.yml`

## 最小门禁

- `tests/manager/quota/quota-manager-module.spec.ts`
  - 锁 `getControlSurface()` 单例与 `clearCooldown/restoreNow/setQuota` 统一出口
- `tests/server/daemon-admin/quota-rust-host-setquota-control-contract.spec.ts`
  - 锁 control plane 不得回落到 TS 第二中心
- `tests/server/daemon-admin/quota-rust-host-mutate-contract.spec.ts`
  - 锁 quota handler mutate 统一走 Rust host

## 迁移方向

- llmswitch-core 主链继续 Rust-only 收敛
- TS 侧 quota 最终只保留：
  - manager lifecycle
  - persistence I/O
  - HTTP/admin bridge
- 新增 quota 语义、route availability floor、quota 路由判定，一律先进 Rust，不再向 TS 扩散
