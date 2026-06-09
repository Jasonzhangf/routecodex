# ProviderForwarder 设计审计与方案（Read-only Audit，待审批）

**状态**: 只读审计，等待 Jason 审批后执行
**日期**: 2026-06-01
**Auditor**: Codex
**作用域**: 同一 provider（同一 model、同一协议、同一 transport backend）下，跨 `baseUrl`/`apiKey`/`endpoint` 的多实例聚合（chatgpt family = "openai-http-provider" + 多个 baseUrl/key 组合）。

---

## 一、现状审计（Read-only Findings）

### 1.1 Provider 协议分层的当前结构

**配置入口** `src/providers/profile/provider-profile.ts`：
- `ProviderProfile.protocol: 'openai' | 'responses' | 'anthropic' | 'gemini'`（4 类协议）
- `ProviderProfile.transport: { baseUrl, endpoint, headers, backend, ... }`
- `ProviderProfile.auth: ApiKeyAuth | OAuthAuth | NoAuth`
- `ApiKeyAuth` 已支持 `entries: ApiKeyEntry[]`（多 key 字段已经在，**但仅作为多 credential 列表**，不是 routing 维度）

**Loader** `src/providers/profile/provider-profile-loader.ts`：
- `buildProviderProfiles(config)` 把 `providers`/`virtualrouter.providers` 节点铺平为 `ProviderProfile[]`
- 每个 entry 落到一个 `ProviderProfile.id`，**key 与 provider 1:1 绑定**（key 字段为必填且唯一）

**Factory** `src/providers/core/runtime/provider-factory.ts`：
- `createProviderFromRuntime(runtime, deps)` 用 `runtime.runtimeKey` 查/建 `IProviderV2` 实例
- LRU 缓存 `PROVIDER_CACHE.MAX_INSTANCES`，以 `runtimeKey` 为缓存键
- `buildConfigFromRuntime(runtime)` 把 `ProviderRuntimeProfile` 投影为 `OpenAIStandardConfig`，**再交给 `HttpTransportProvider`**

**结论**：协议与 provider 实例严格 1:1。要"同协议 + 多 baseUrl/key"，**目前唯一的扩展点是** `ProviderProfile` 配置里**手写 N 个** provider entry，**没有 forwarder 抽象**。

### 1.2 Virtual Router 路由/选路现状（Rust 真源）

**ProviderRegistry** `router-hotpath-napi/src/virtual_router_engine/provider_registry.rs`：
- `providers: HashMap<String, ProviderProfile>`（键为 providerKey）
- `ProviderProfile` 持有 `provider_key / provider_type / enabled / model_id / model_capabilities / series / auth_family / ...`
- `list_provider_keys(provider_id) -> Vec<String>`（按 `"{provider_id}."` 前缀聚合）

**Routing / Pool** `router-hotpath-napi/src/virtual_router_engine/routing/config.rs`：
- `RoutePoolTier { id, targets, priority, mode, backup, force, load_balancing, routeParams, thinking }`
- `load_balancing: LoadBalancingPolicy { strategy, weights, health_weighted, context_weighted }`
- 默认 `strategy = "round-robin"`，可选 `"weighted"`
- `mode` 与 `load_balancing.strategy` 是 **route pool 维度**（route → pool → targets），不是 target/group 维度
- `parse_routing` 按 priority 降序排 tiers；`has_targets`、`flatten_targets` 等工具齐全

**Selection** `routing/selection.rs`：
- `filter_candidates_by_state` 已按 `allowed_providers / disabled_providers / disabled_keys / disabled_models` 过滤
- `resolve_instruction_target` 支持 explicit alias / key_index / model
- **目前没有"模型优先"或"provider 优先"的 top-level 路由策略**；决策完全靠 pool 排序 + candidate 过滤

**Load Balancer** `load_balancer.rs`：
- `RouteLoadBalancer::select(...)` 已支持 `round-robin / weighted / grouped / health_weighted / context_weighted`
- `select_grouped` 先按 group 选一个 group，再在 group 内 round-robin
- **缺口**：group 策略固化（先 group 再 RR），**没有"模型优先+provider 优先"或"provider 优先+模型优先"两个维度的自由组合**

### 1.3 现有等价物

- **chatgpt family** 现状：用 N 个独立 provider entry 模拟，**没有 family 概念**。
- **多 apiKey** 现状：`ApiKeyAuth.entries` 数组属于单 provider 内部认证配置，不提供跨 provider 调度。
- **provider-direct / router-direct** 现状：direct passthrough 模式只有"单 provider + hooks"，没有聚合。

---

## 二、需求拆解

> 同一个 model 实际上可以由 N 个 provider 提供（不同 baseUrl / apikey）；要有一个 forwarder 抽象，对外表现"同协议同模型"，对内做 N 选 1。

### 2.1 用户原文

1. forwarder 聚合：同 model 多 provider 入口
2. chatgpt family = "openai-http-provider" 协议下，多 baseUrl/apiKey 组合 + round-robin / priority / weighted
3. 两种策略：**模型优先**（按 model 找 forwarder，再选 instance） / **provider 优先**（按 provider 选 forwarder，再选 model）
4. 每个 provider 自己的 per-provider 策略（sticky / cooldown / fallback 等）仍生效

### 2.2 与现有系统兼容性边界

- **不能破坏** `ProviderProtocol` 四分类（openai/responses/anthropic/gemini），forwarder 只是"协议 + model 维度上的 N 选 1"
- **不能旁路** Rust Virtual Router：选路语义真源必须留在 `router-hotpath-napi`
- **不能**新增 fallback / 降级 / 双路径（硬护栏 2）
- **不能**在 Hub Pipeline 写 provider-specific 逻辑（硬护栏 12）
- **必须** 唯一真源 + 唯一修改点（硬护栏 9）

---

## 三、Forwarder 设计（提案）

### 3.1 配置层新增：`ProviderForwarderProfile`

在 `src/providers/profile/provider-profile.ts` 增加 forwarder 声明（type-only）：

```ts
export type ProviderForwarderStrategy = 'round-robin' | 'priority' | 'weighted' | 'least-loaded' | 'health-weighted';

export interface ProviderForwarderTarget {
  /** 引用已有 ProviderProfile.id（必须同 protocol） */
  providerId: string;
  /** 可选 key alias，仅当该 provider 的 ApiKeyAuth.entries 含 alias 时生效 */
  keyAlias?: string;
  /** forwarder 内部权重（weighted 模式使用） */
  weight?: number;
  /** forwarder 内部 priority（priority 模式使用，数字小者优先） */
  priority?: number;
  /** 标记 disabled（与 RoutingInstructionState.disabled_keys 同步） */
  disabled?: boolean;
}

export interface ProviderForwarderProfile {
  id: string;
  protocol: ProviderProtocol;
  model: string;
  /** 模型优先 vs provider 优先的查找维度 */
  resolutionMode: 'model-first' | 'provider-first';
  /** 内部选路策略 */
  strategy: ProviderForwarderStrategy;
  /** 加权策略使用的 weights 兜底（target 未覆盖时） */
  weights?: Record<string, number>;
  targets: ProviderForwarderTarget[];
  /** 可选：sticky session 维度 */
  stickyKey?: 'session' | 'request' | 'none';
}
```

**与现有 `ProviderProfile` 关系**：
- forwarder **不创建** 新的 IProviderV2 实例；它把多个 `ProviderProfile` 在 routing 层折叠成一个 logical target
- forwarder `id` 用 `fwd.<protocol>.<model>` 前缀；**与 provider key 命名空间隔离**（避免误判为 provider_key）
- **命名空间隔离，不解析语义**：forwarder id 中的 model/protocol 字段是显式配置字段；`fwd.` 前缀仅用于 bootstrap 校验前缀，**禁止**按 `split(".")` 推算 model 或 protocol（model 可能含 `.` 如 `claude-sonnet-4-5`、`gpt-4.1`、`MiniMax-M2.7` 或 `provider/model`）

### 3.2 配置 schema（用户配置）

```jsonc
{
  "providers": {
    "openai-prod-1":   { "type": "openai-http-provider", "providerType": "openai", "baseURL": "https://api.openai.com/v1", "auth": { "type": "apikey", "env": "OPENAI_API_KEY" } },
    "openai-prod-2":   { "type": "openai-http-provider", "providerType": "openai", "baseURL": "https://api.openai.com/v1", "auth": { "type": "apikey", "env": "OPENAI_API_KEY_2" } },
    "azure-gpt-4o":    { "type": "openai-http-provider", "providerType": "openai", "baseURL": "https://myres.openai.azure.com/openai/deployments/gpt-4o", "auth": { "type": "apikey", "env": "AZURE_OPENAI_KEY" } },
    "openrouter-gpt4": { "type": "openai-http-provider", "providerType": "openai", "baseURL": "https://openrouter.ai/api/v1", "auth": { "type": "apikey", "env": "OPENROUTER_KEY" } }
  },
  "forwarders": {
    "fwd.openai.gpt-4o": {
      "protocol": "openai",
      "model": "gpt-4o",
      "resolutionMode": "model-first",
      "strategy": "weighted",
      "weights": { "openai-prod-1": 5, "openai-prod-2": 3, "azure-gpt-4o": 2, "openrouter-gpt4": 1 },
      "targets": [
        { "providerId": "openai-prod-1",   "weight": 5 },
        { "providerId": "openai-prod-2",   "weight": 3 },
        { "providerId": "azure-gpt-4o",    "weight": 2 },
        { "providerId": "openrouter-gpt4", "weight": 1 }
      ]
    }
  }
}
```

**与 `virtualrouter.providers` 关系**：
- forwarder 是 routing layer 概念，**不污染** `ProviderProfile` 本身
- `ProviderFactory` 看到 `runtimeKey = "openai-prod-1.key1"`（forwarder 在 Rust selection 侧已解析为 real key），完全透传原 `buildConfigFromRuntime` 路径


### 3.3 Routing 层（Rust 真源）

**新增文件** `router-hotpath-napi/src/virtual_router_engine/forwarder.rs`：

```rust
pub(crate) struct ForwarderEntry {
    pub forwarder_id: String,
    pub protocol: String,
    pub model_id: String,
    pub resolution_mode: ResolutionMode, // ModelFirst | ProviderFirst
    pub strategy: ForwarderStrategy,
    pub targets: Vec<ForwarderTarget>,
    pub weights: Option<HashMap<String, i64>>,
    pub sticky_key: StickyKey,
}

pub(crate) struct ForwarderTarget {
    pub provider_key: String, // real ProviderProfile.provider_key
    pub weight: Option<i64>,
    pub priority: Option<i64>,
    pub disabled: bool,
}

pub(crate) struct ForwarderRegistry {
    entries: HashMap<String, ForwarderEntry>,  // forwarder_id -> entry
    by_model: HashMap<(String, String), Vec<String>>,    // (protocol, model) -> [forwarder_id]
    by_provider: HashMap<String, Vec<String>>,           // provider_key -> [forwarder_id]
}
```

**核心 API**：
- `bootstrap_forwarders(json: &Map) -> Vec<ForwarderEntry>`（由 NAPI 暴露）
- `ForwarderRegistry::resolve(protocol, model, provider_key?) -> Option<ForwarderEntry>`
  - `resolution_mode=model-first`：按 (protocol, model) 查 `by_model`
  - `resolution_mode=provider-first`：按 provider_key 查 `by_provider`，再在 entry 内部按 model 过滤
- `ForwarderEntry::select(availability, sticky_hint) -> Option<String>`：返回 `provider_key`，策略与 `RouteLoadBalancer` 对齐（复用 weighted / round-robin 逻辑）

**与 `RouteLoadBalancer` 关系**：
- forwarder 内部选路**复用** `RouteLoadBalancer::select(...)`（不重建 weighted/round-robin）
- forwarder 的"state" 用 `forwarder_id` 作 `route_name`，避免污染 route-level state

**Selection 链路（推荐方案 1）**：
- `VirtualRouter::select(...)` 增加 `forwarder_resolve: bool` 参数或 wrapper 函数 `select_with_forwarder_resolution(...)`
- 展开 forwarder targets → 对每个 real provider_key 跑 availability 检查（enabled / health / cooldown / disabled_providers / disabled_keys / disabled_models / capability / model match）
- `RouteLoadBalancer::select(...)` 在 real candidates 上执行 weighted / round-robin / priority
- 返回的 `provider_key` **已经是 real key**；`target.runtimeKey` 直接输出 real key
- **`build_target` 维持原样**，不增加 fwd 分支

### 3.4 Selection 维度

`resolutionMode` 在 routing 入口判定：

- `model-first`：classifier 产出 `(protocol, model)` 后，**先**查 forwarder 命中，命中后再选 instance；未命中走原 route 流程
- `provider-first`：classifier 产出 `(provider_key, model)` 后，**先**查该 provider_key 是否挂在某个 forwarder 下，挂载则走 forwarder 选 instance；未挂载走原 route 流程

两种模式**互斥**于同一 (protocol, model) 命中（不允许同时存在两个 forwarder 解析同一对）；bootstrap 阶段 fail-fast。

### 3.5 Health / Cooldown / Sticky
- **per-provider 策略不变**：health/cooldown/series 仍走 `ProviderProfile` + `health.rs`
- **forwarder 内部对 real candidates 做 availability 检查**：
  - 展开 forwarder targets → 对每个 real provider_key 跑 enabled / health / cooldown / disabled_providers / disabled_keys / disabled_models / capability / model match
  - 全不可用 → `ERR_FORWARDER_NO_AVAILABLE_TARGET`（fail-fast，不回退 route pool 其他 target）
- **sticky session**（Rust 侧，host 只传 sessionId）：
  - `forwarder.rs` 持有 sticky map：`HashMap<(session_id, forwarder_id), real_provider_key>`
  - `stickyKey = 'session'` 时用 sessionId 哈希固定 target；session 内不再切换
  - **只属于 forwarder 自身**，不复用任何 provider runtime 内部账号池或状态机

| 层 | 新增 | 修改 |
| --- | --- | --- |
| **Profile** | `src/providers/profile/forwarder-types.ts` | `provider-profile-loader.ts`（识别 `forwarders` 节点） |
| **ProviderRegistry** | — | `router-hotpath-napi/src/virtual_router_engine/routing/bootstrap.rs`（生成虚拟 entries） |
| **Rust 引擎** | `router-hotpath-napi/src/virtual_router_engine/forwarder.rs` <br> `router-hotpath-napi/src/virtual_router_engine/forwarder_tests.rs` | `routing/selection.rs`（新增 `select_with_forwarder_resolution`）<br> `lib.rs`（NAPI 绑定） |
| **配置** | `configsamples/forwarder-example.json` | `routecodex-config-loader`（forwarders 节点透传） |
| **测试** | `tests/providers/forwarder-selection.test.ts` <br> `crates/router-hotpath-napi/src/virtual_router_engine/forwarder_tests.rs` | `tests/pipeline/blueprint-regression.test.ts`（回归） |

**核心约束**：
1. Hub Pipeline 不写 forwarder 逻辑（硬护栏 12）
2. 不引入 fallback（硬护栏 2）：forwarder 全 disabled → fail-fast `ERR_FORWARDER_NO_AVAILABLE_TARGET`
3. 不创建新 IProviderV2（`ProviderFactory` 只收到 real runtimeKey，forwarder 解析 100% 在 Rust 侧完成）
4. 不修改 `RouteLoadBalancer` 已有策略语义，仅暴露复用接口


---


### 3.7 最终架构（简化视图）

```
RoutePool target
  |
  +-- normal provider_key
  |     +--> build_target(provider_key) --> real target fields
  |
  +-- fwd.* logical target
        +--> ForwarderRegistry::resolve(forwarder_id)
             |
             +--> expand to real provider_keys
             +--> run availability checks on real keys
             |     (enabled / health / cooldown / disabled_* / capability)
             +--> RouteLoadBalancer::select(real_candidates)
             +--> sticky / weighted / rr / priority
             +--> return real_provider_key
                  |
                  +--> build_target(real_provider_key) --> real fields

Host 收到:
  runtimeKey = real_provider_key   (不是 fwd.xxx#real)
```

## 四、不在本次范围（Out of Scope）

- **OAuth 跨 provider 共享 token**：forwarder 仅在 `auth: apikey` 维度复用；如果需要"同一 OAuth token 跨 N 个 baseUrl"，放到后续 phase
- **chat-process 层合并多 provider 响应**：forwarder 只做"选 1"，不做"多 provider stream merge"（避免引入 fallback 语义）
- **runtime metadata**：forwarder 解析在 selection 阶段完成；`target.runtimeKey` 输出 real key，host 不感知 forwarder 存在

---

## 五、验证标准（执行后必跑）

### 5.1 单元 / 红绿
- Rust: `cargo test -p router-hotpath-napi forwarder::` 全绿，覆盖：
  - model-first / provider-first 解析
  - weighted / priority / round-robin 三策略
  - 全 disabled → ERR_FORWARDER_NO_AVAILABLE_TARGET
  - 同一 (protocol, model) 双 forwarder → bootstrap fail-fast
- TS: `npm test -- tests/providers/forwarder-selection.test.ts --runInBand`

### 5.2 回归
- `node scripts/build-core.mjs && npx tsc --noEmit` exit 0
- `cargo test -p router-hotpath-napi --lib virtual_router_engine::routing` 维持 37/37
- `npm test -- tests/pipeline/blueprint-regression.test.ts --runInBand`

### 5.3 端到端（手测）
- 配置 4 个 openai provider + 1 个 forwarder，发送 100 次请求，统计每个 provider 命中比例 = weights 比例 ± 5%
- 强制 disable 最高权重 provider，forwarder 自动降级到次高
- session sticky 模式下，同 sessionId 始终命中同一 provider

### 5.4 红测试门禁
- 新增 `tests/red-tests/no_provider_specific_in_hub_pipeline.test.ts`：扫描 hub_bridge_actions / req_process / resp_process 不得出现 forwarder 字符串

---

## 六、风险与待定项

1. **provider 命名空间冲突**：forwarder id 用 `fwd.` 前缀，与 ProviderProfile id 隔离；但需要 bootstrap 阶段校验前缀唯一
2. **跨 forwarder 共享 runtimeKey**：不允许。两个 forwarder 不能 resolve 同一 (provider_key, model)，bootstrap 阶段 fail-fast
3. **加权策略 + health 的优先级**：weighted 模式下 health 未达标的 target 是直接跳过还是降权？提案：**直接跳过**（与 `RouteLoadBalancer` 现有行为一致），不引入新语义
4. **配置漂移**：forwarder 引用了不存在的 providerId，bootstrap 阶段 fail-fast（不静默跳过）

---

## 七、审批前请 Jason 确认

- [ ] forwarder 配置前缀 `fwd.` 是否同意？
- [ ] model-first / provider-first 二选一机制是否覆盖需求？
- [ ] weighted / round-robin / priority 三策略够用？还是需要 least-loaded / health-weighted 一起落地？
- [ ] 是否同意"forwarder 全 disabled → fail-fast"，不引入 fallback？
- [ ] 是否同意把 forwarder 语义真源放在 `router-hotpath-napi/src/virtual_router_engine/forwarder.rs`（Rust）？

审批后我会按 §3.6 文件改动总览执行，按 §5 验证标准回归。

---
## 八、设计定稿（审计后修订版）

基于 Jason 审计 3 项 P0 必改点，修订如下：

| P0 | 修订内容 | 结果 |
| --- | --- | --- |
| P0-1 sticky 必须 Rust 持有 | 删除 `forwarder-sticky-state.ts`（host-side）；`forwarder.rs` 持有 `HashMap<(session_id, forwarder_id), real_provider_key>`，Host 仅传 sessionId | ✅ |
| P0-2 fwd id opaque | `fwd.` 前缀仅作命名空间隔离，**禁止按 `split(".")` 推算 model**（model 可能含 `.`）；显式 `model` 字段 bootstrap 校验 | ✅ |
| P0-3 availability 检查 real provider | forwarder 内对 real candidates 跑 enabled/health/cooldown/disabled_*/capability；全不可用 → `ERR_FORWARDER_NO_AVAILABLE_TARGET` | ✅ |

**删除方案**（P5 方案 1 优先）：
- 删 `fwd.xxx#real` runtimeKey 格式
- 删 `build_target` 内 fwd 递归分支（`build_target` 维持原样）
- 删 `ProviderFactory` fwd 解析

**最终架构**：forwarder 解析 100% 在 `select_with_forwarder_resolution` 完成；Host 永远只收到 real `runtimeKey`；forwarder 对 Host 完全透明。

**状态**：设计定稿，等待执行。
