# Virtual Router 在线诊查与 Dry-Run 设计

## 目标

为 Virtual Router 增加一个在线诊查面，用于按端口、按 route 查看当前真实路由状态，并对给定样本做 dry-run 命中测试，回答三类问题：

1. 这个端口当前有哪些 route / tier / forwarder / target。
2. 某个样本现在会命中哪里，为什么。
3. 如果最终返回 `PROVIDER_NOT_AVAILABLE`，具体是哪些 blocker 造成的。

## 结论先行

- 语义真源必须在 Rust Virtual Router。
- TS 只能做薄壳：HTTP/CLI 入口、参数解析、结果展示、权限/本地性控制。
- dry-run 必须严格只读，不得推进负载均衡状态、健康状态、sticky 状态、冷却状态或任何持久化状态。
- 不能在 TS 重新计算路由。

## 当前证据

- `VirtualRouterEngineCore::get_status()` 目前只输出 `routes / health / forwarders`，且 `routes` 只有 `providers + hits: 0`，不足以诊查命中原因。
- `selection.rs` 已经有完整的真实判定逻辑，包括：
  - route queue / pool 过滤
  - forwarder 展开
  - `excludedProviderKeys`
  - `default_floor_selection`
  - `unavailable_route_pools`
  - `concurrency_busy / health_cooldown / provider_disabled`
- HTTP 侧已有 local-only 诊断壳 `/_routecodex/diagnostics/virtual-router`，但它只是把 `getStatus()` 原样吐出。
- CLI 侧目前只有 `port doctor` 和 `status`，没有专门的 VR 诊查入口。

## Owner 与边界

### 真源 owner

- `vr.route_selection`
- `vr.metadata_center_surface`
- `vr.route_availability_floor`
- `vr.provider_forwarder_runtime`

### 允许路径

- Rust: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/**`
- TS 壳层:
  - `src/server/runtime/http-server/routes.ts`
  - `src/server/runtime/http-server/daemon-admin/*`
  - `src/cli/commands/*`

### 禁止路径

- `src/server/runtime/http-server/executor/**` 里重新推导路由真相
- `src/providers/**` 里重建 VR 诊断语义
- `src/client/**` 里做路由 owner

## 推荐 API 形状

我建议复用现有 diagnostics namespace，不另起一套平行 surface。

### HTTP

- `GET /_routecodex/diagnostics/virtual-router`
  - 返回端口级总览
  - 保持 local-only
- `GET /_routecodex/diagnostics/virtual-router/status`
  - 返回按 route / tier / forwarder / target 展开的结构化状态
- `POST /_routecodex/diagnostics/virtual-router/dry-run`
  - 输入样本，返回命中路径、候选集、排除原因、是否会落到 default pool

### CLI

- 推荐复用现有 `port` 命令族，不新造顶层 `diagnostics`
- 可落成以下两种之一：
  - `routecodex port doctor <port> --vr`
  - `routecodex port dry-run <port> --vr --input <file>`

## Rust Contract 设计

### 1. `VrDiag01StatusSnapshot`

用途：端口级只读状态快照。

建议字段：

- `serverId`
- `port`
- `routingPolicyGroup`
- `version`
- `routes[]`
- `health`
- `forwarders[]`
- `metadataCenterScope`（只读摘要）

`routes[]` 至少要展开：

- `routeName`
- `poolId`
- `poolPriority`
- `poolMode`
- `routeParams`
- `configuredTargets`
- `resolvedTargets`
- `resolvedForwarders`
- `availableTargets`
- `excludedTargets`
- `unavailableProviders`
- `defaultFloor`

`forwarders[]` 至少要展开：

- `forwarderId`
- `protocol`
- `modelId`
- `strategy`
- `stickyKey`
- `targets[]`
- `available`
- `blockedReason`

### 2. `VrDiag02DryRunInput`

用途：只读模拟一次真实 route 决策。

建议输入字段：

- `port`
- `routingPolicyGroup`
- `entryEndpoint`
- `request`
- `metadata`
- `metadataCenterSnapshot`
- `excludedProviderKeys`
- `retryProviderKey`
- `routeHint`
- `providerProtocolLock`
- `serverToolRequired`
- `streamIntent`

输入必须允许两类形态：

- 完整请求样本
- 轻量诊查样本

但两者都必须映射到同一个 Rust truth path。

### 3. `VrDiag03DryRunDecision`

用途：解释“会命中哪里”。

建议字段：

- `selectedRouteName`
- `selectedPoolId`
- `selectedProviderKey`
- `selectedForwarderId`
- `selectedRuntimeKey`
- `selectedReasoningTags`
- `candidateProviderKeys`
- `candidatePools`
- `unavailableRoutePools`
- `filteredOutBy`
- `defaultFloorSelection`
- `wouldReturnProviderNotAvailable`
- `errorDetails`

### 4. `VrDiag04ErrorExplain`

用途：解释为什么某些样本会落 `PROVIDER_NOT_AVAILABLE`。

建议原因分类：

- `provider_disabled`
- `health_cooldown`
- `health_unavailable`
- `concurrency_busy`
- `excluded_by_request`
- `protocol_locked_out`
- `forwarder_no_available_target`
- `context_overflow`
- `default_pool_empty`

## Dry-Run 语义

dry-run 必须满足：

1. 不修改 `load_balancer` 状态。
2. 不修改 `health_manager` 状态。
3. 不修改 `routing_state_store`。
4. 不修改 sticky / retry / cooldown 持久态。
5. 不写 provider stats。
6. 不吞错。

推荐实现方式：

- Rust 增加独立 `diagnose_route(...)` / `dry_run_route(...)` 入口。
- 该入口复用 selection 的同一套过滤与解释逻辑。
- 如有 round-robin / weighted 选择，dry-run 返回“理论命中候选顺序”或“当前将选中者”，但不能消耗真实游标。

## TS 薄壳边界

TS 只做：

- 读取本地端口 / routingPolicyGroup
- 解析 HTTP body / CLI 参数
- 调用 Rust binding / runtime proxy
- 将 Rust 输出原样投影到 HTTP/CLI
- 做 local-only / auth gate

TS 不做：

- route queue 计算
- forwarder 展开
- default floor 推导
- health / cooldown 判定
- candidate 排除重算

## 建议的实现分层

### Rust

1. 在 `virtual_router_engine` 内新增诊断 contract。
2. 复用 selection/filter/forwarder/status 的真源逻辑。
3. 为 diagnostics 输出补足结构化原因。
4. 暴露 NAPI 方法给 TS。

### TS

1. 在 `native-virtual-router-runtime.ts` / proxy 增加只读诊断方法。
2. 在 `routes.ts` 里把现有 `/_routecodex/diagnostics/virtual-router` 升级为结构化状态面。
3. 在 `port.ts` 或新的轻量子命令里增加 dry-run 展示。

## 验证门禁

必须有以下验证：

- Rust 单测：
  - status snapshot 展开正确
  - dry-run 不变异
  - default pool last-provider 仍可解释
  - forwarder 为空 / disabled / cooldown 可解释
- TS 集成测试：
  - HTTP diagnostics endpoint 返回结构化状态
  - CLI 能显示按端口诊断结果
- 真实样本回放：
  - 用已有失败样本重放，确认诊断输出能解释实际命中
  - 至少覆盖一个 `PROVIDER_NOT_AVAILABLE`

## 实施顺序

1. 补 architecture map：新增 `vr.online_diagnostics` feature_id，并把 owner、allowed paths、forbidden paths、required gates 写入 function map / verification map / mainline call map。
2. Rust 先红：补 native/Rust 测试证明现有 `getStatus()` 无法解释 route/tier/forwarder/default floor，dry-run 入口不存在或会变异状态。
3. Rust contract：新增 `VrDiag01StatusSnapshot`、`VrDiag02DryRunInput`、`VrDiag03DryRunDecision`、`VrDiag04ErrorExplain`，输出结构化 route availability trace。
4. Rust dry-run：从 selection 真源抽取只读 explain path，复用真实 route/filter/forwarder/default floor/blocker 逻辑，但不推进 load-balancer/health/routing-state/stats。
5. NAPI/TS runtime proxy：只增加薄调用方法，不在 TS 里计算候选或解释原因。
6. HTTP thin shell：扩展现有 `/_routecodex/diagnostics/virtual-router`，并新增 `/status` 与 `/dry-run` 子路由，保持 local-only / admin policy。
7. CLI thin shell：在 `port` 命令族下增加 VR status/dry-run 展示，默认可 JSON 输出。
8. 端到端验证：用真实端口与旧失败样本证明诊断输出能解释 live route hit 与 `PROVIDER_NOT_AVAILABLE`。

## 风险与规避

- 风险：TS/HTTP 为了快速展示重算 route。规避：所有候选、blocker、default floor、forwarder 展开均来自 Rust 输出；TS 测试/gate 禁止重建语义。
- 风险：dry-run 消耗 round-robin/weighted 游标。规避：Rust 测试连续 dry-run 前后真实 route 命中状态一致。
- 风险：诊断输出泄漏 secret。规避：只允许 providerKey/runtimeKey/model/protocol/health/cooldown，不输出 auth/header/api key/raw provider options。
- 风险：诊断面变成第二套 debug 系统。规避：保留在 VR runtime diagnostics contract，不迁入 debug artifact/error diag。
- 风险：`PROVIDER_NOT_AVAILABLE` 仍只返回总错误。规避：红测要求 error explanation 中包含每个候选的具体 blocker 和 default pool 状态。

## 推荐落点

我建议先只做一个 Rust-only 诊断 contract，然后让 HTTP/CLI 共用同一个 native API。原因很简单：

- 避免 TS/HTTP/CLI 各自拼一份路由解释逻辑。
- 避免 status 面和 dry-run 面分裂出两套语义。
- 后续如果要加 UI / daemon-admin 页面，也只是在同一个 contract 上再投影一层。

## 未决问题

需要你确认以下边界再进入实现：

1. 入口形状
   - 继续扩展现有 `/_routecodex/diagnostics/virtual-router`
   - 还是拆出新的 `/status` / `/dry-run` 子路由

2. CLI 形状
   - 继续挂在 `port doctor`
   - 还是新开 `vr` 子命令

3. dry-run 是否必须完全非变异
   - 我的建议是必须完全非变异

4. 输出粒度
   - 是否要直接回 `candidateProviderKeys` / `unavailableReasons` / `defaultFloorSelection`
   - 是否要暴露 forwarder target 级别的可用性

5. 样本输入形状
   - 是否接受完整请求体
   - 是否还要支持一个轻量的纯诊查 schema

## 完成定义

- `vr.online_diagnostics` 在 function map / verification map / mainline call map 中可查询。
- Rust status 输出能按 route/tier/forwarder/target/default pool 展开当前端口状态。
- Rust dry-run 能对完整请求样本返回选中 route/provider 与所有候选排除原因。
- dry-run 经过测试证明不修改 load-balancer、health、routing-state、sticky、cooldown、provider stats。
- HTTP/CLI 只透传 Rust 诊断结果，不重算 VR 语义。
- 至少一个 live 端口样本和一个 `PROVIDER_NOT_AVAILABLE` 样本能被诊断输出解释。
- 必跑验证与 build 通过，必要时完成全局安装和受管端口重启验证。
