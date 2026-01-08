# Manager Daemon 规划（Routing / Health / Token）

## 目标

- 用单一 `ManagerDaemon` 进程内模块，统一管理：
  - Token 生命周期（原 token daemon）。
  - Virtual Router 路由状态（sticky / session 级指令）。
  - Provider / 系列级健康与冷却（429 / quota / 熔断）。
- 支持按 **server + session** 维度持久化状态，server 重启后仍能继承冷却/黑名单与 sticky 配置。
- 每个子模块完全解耦，可独立启停与测试。

## 模块划分

- `TokenManager`（模块 id: `token`）
  - 继承现有 token daemon 职责：监控 `~/.routecodex/auth/`、刷新 OAuth token、触发重新认证。
  - API：供 CLI / HTTP server 查询 token 状态与触发刷新。

- `RoutingStateManager`（模块 id: `routing`）
  - 负责 session / conversation 级路由指令状态：
    - sticky target（`forcedTarget` / `stickyTarget`）。
    - `disabledProviders` / `disabledKeys` / `disabledModels`。
    - stopMessage 状态（仅路由层视角）。
  - 与 `VirtualRouterEngine` 的 `RoutingInstructionState` 做双向同步：
    - 启动时从持久化快照恢复；
    - 运行时在指令变更时落盘。

- `HealthManager`（模块 id: `health`）
  - 消费 `providerErrorCenter` / Virtual Router Health 相关事件，维护：
    - `ProviderKeyState`：单个 providerKey 的健康 / 冷却窗口 / 错误计数。
    - `SeriesState`：如 claude / gemini 系列的整段熔断与配额冷却。
  - 对 Virtual Router 暴露 `VirtualRouterHealthStore`：
    - 启动时提供初始 snapshot（只包含未过期条目）。
    - 运行时持久化 series cooldown / trip 事件。

## 文件结构（src）

```text
src/manager/
  index.ts                # ManagerDaemon 实现
  types.ts                # ManagerContext / ManagerModule 等公共类型
  storage/
    base-store.ts         # StateStore 抽象接口
    file-store.ts         # JSONL 文件落盘占位实现（后续补全）
  modules/
    token/
      index.ts            # TokenManagerModule 占位（后续迁移现有 token-daemon 实现）
    routing/
      index.ts            # RoutingStateManagerModule 占位
    health/
      index.ts            # HealthManagerModule 占位
```

> 当前阶段只创建结构和最小占位实现，确保 TypeScript 能编译，通过后再分阶段迁移逻辑与测试。

## 对外集成关系（之后阶段）

- HTTP server 启动：
  - 构造 `ManagerDaemon({ serverId })`，按配置注册 `token/routing/health` 模块并调用 `start()`。
  - 构造 Virtual Router 时，将 `HealthManager` 暴露出的 `VirtualRouterHealthStore` 注入 HubPipeline。
- 错误与健康事件：
  - Provider / Hub 通过 `emitProviderError` → `providerErrorCenter` → VirtualRouter → `HealthManager`。
  - 所有冷却 / 熔断 / 黑名单只在 Virtual Router & HealthManager 合作下维护，Provider/HTTP server 不再各自维护本地状态。

## 交付步骤

1. **阶段 1：骨架搭建**（当前阶段）
   - 建立 `src/manager/**` 文件结构与基础类型，不改变现有行为。
   - 将规划文档落盘（本文件），并在 `task.md` 中新增 Manager Daemon 任务。

2. **阶段 2：TokenManager 迁移**
   - 把现有 `src/token-daemon/*` 逻辑抽取为 `TokenManagerModule` 内部实现。
   - 保持 CLI/脚本行为不变，只调整内部依赖路径。

3. **阶段 3：HealthManager ↔ VirtualRouter 对接（内存版）**
   - 在 sharedmodule 中定义 `VirtualRouterHealthStore` 接口和事件模型。
   - 由 `HealthManagerModule` 提供内存实现，仅反映当前进程的健康状态。

4. **阶段 4：RoutingStateManager 替换 sticky-session 持久化**
   - 用 RoutingStateManager 接管 `sticky-session-store.ts` 的落盘逻辑，统一 SessionRoutingState schema。

5. **阶段 5：HealthManager 持久化**
   - 在 file-store 基础上实现 providerKey / series 级 JSONL 落盘与 snapshot 恢复。

6. **阶段 6：接线 & 调试接口**
   - HTTP server 接入 ManagerDaemon，并提供 `/manager/state/*` 调试端点查看路由池拉黑与 session 状态。
