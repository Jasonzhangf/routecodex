# Task: Manager Daemon & Routing/Health Persistence

## 目标

- 建立 `ManagerDaemon` 进程内模块，统一但解耦地管理：
  - Token 生命周期（TokenManager）。
  - Virtual Router 路由状态（RoutingStateManager）。
  - Provider / 系列级健康与冷却（HealthManager）。
- 支持按 server + session 维度持久化路由和健康状态，server 重启后仍能继承冷却/黑名单与 sticky 状态。

## 子任务

1. **规划与文件结构搭建**
   - [x] 梳理 ManagerDaemon 架构与各模块职责（已落盘至 `docs/plans/manager-daemon/PLAN.md`）。
   - [x] 创建 `src/manager/` 目录与基础骨架：
     - `index.ts`：ManagerDaemon 框架；
     - `types.ts`：`ManagerContext` / `ManagerModule` 类型；
     - `storage/base-store.ts` / `storage/file-store.ts`：持久化抽象与文件存储占位；
     - `modules/token|routing|health/index.ts`：三个模块占位实现。
   - [x] 在 server 启动流程中预留 ManagerDaemon 初始化 hook（当前仅注册占位模块，保持行为不变）。

2. **TokenManager 迁移（与现有 token daemon 对齐）**
   - [x] 将 `TokenDaemon` 自动刷新逻辑接入 `TokenManagerModule`，由 ManagerDaemon 在 server 进程内周期执行。
   - [x] 为 TokenManager/CLI 引入基于锁文件的 leader 选举，确保任意时刻仅有一个 Token 刷新器实例（server 内置 TokenManager 与外部 `token-daemon` 互斥）。
   - [x] 将 `src/token-daemon/*` 进一步抽象为可复用的 Token 管理服务，供 ManagerDaemon 与 CLI 共享。
   - [x] 保持 token daemon CLI 行为（start/status/refresh）与现有一致，同时在有 server 进程持有 leader 时拒绝启动第二个刷新器，避免与 TokenManager 重复刷新同一 token。

3. **HealthManager ↔ VirtualRouter 集成（内存版）**
   - [x] 在 sharedmodule/llmswitch-core 中定义 `VirtualRouterHealthStore` 接口与事件模型，并由 `VirtualRouterEngine` 在 `handleProviderError`/cooldown 过程中调用。
   - [x] 由 `HealthManagerModule` 提供进程级 `VirtualRouterHealthStore` 实现，通过 ManagerDaemon 注入 HubPipeline/VirtualRouter。
   - [x] 保持 429 / series cooldown 行为与现状一致，在此基础上增加健康状态快照持久化。

4. **RoutingStateManager 替换 sticky-session 持久化**
   - [x] 用 RoutingStateManager 接管 `sticky-session-store` 的磁盘读写，实现统一的 `SessionRoutingState` schema。
   - [x] 确保 servertool / VirtualRouter 在 session/sticky 场景下行为与现状保持一致。

5. **HealthManager 持久化与恢复**
   - [x] 在 `JsonlFileStore` 基础上实现健康快照和 ProviderError 事件的 JSONL 落盘与 snapshot 恢复（按 serverId 分目录）。
   - [x] 使用 ManagerContext.serverId 作为 server 级标识，落盘路径形如 `~/.routecodex/state/router/<serverId>/health.jsonl`。
   - [x] 设计并实现 TTL / compact 策略，避免长期堆积过期冷却记录（当前 `compact` 仍为占位实现）。

6. **接线与调试接口**
   - [x] 在 HTTP server 启动流程中注入 ManagerDaemon，并将 HealthStore/RoutingState 管理接入 HubPipeline/VirtualRouter。
   - [x] 新增 `/manager/state/health`、`/manager/state/routing/:sessionId` 等内部调试端点，便于观测路由池拉黑与 session sticky 状态。

## 进度
- [x] 架构规划与文档（ManagerDaemon/TokenManager/RoutingStateManager/HealthManager 职责梳理）。
- [x] ManagerDaemon 与模块骨架文件结构搭建。
- [x] TokenManager 初步迁移：server 进程内由 ManagerDaemon 驱动 TokenDaemon 自动刷新。
- [x] HealthManager/VirtualRouter 集成（内存版 + 快照持久化）。
- [x] RoutingStateManager 与 sticky-session 持久化替换。
- [x] RoutingStateManager 与 sticky-session 持久化替换。
- [x] HealthManager TTL/compact 策略与调试接口（/manager/state/*）。

---

# Archive: stopMessage 持久化与回放复盘（历史任务，仅保留记录）

> stopMessage 相关的路由指令持久化、servertool 行为与文档更新已基本完成，尚余的 Codex sample 回放与人工验证可作为低优先级后续工作。

## 未完成检查项（低优先级）

- [ ] 启动 dev 服务器并回放「小红书 native click」 Codex sample，检查 sticky state 文件中的 stopMessage 字段。
- [ ] 在真实请求或最小样本中，验证 `:stop_followup` provider-request 末条 user 消息包含 stopMessage 内容。
