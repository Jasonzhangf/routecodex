# Daemon / Token 管理 & Provider Config V2 视图模块结构设计

> 目标：在不破坏现有 HTTP server / Manager 架构的前提下，为 Daemon/Token 管理 UI 和基于 Config V2 的 Provider 管理视图定义清晰的**模块与文件结构**。本设计仅落盘结构与职责，不改动任何实现。

---

## 1. 总体架构与边界

- **HTTP Server 仍然是唯一入口**
  - 继续使用 `src/server/runtime/http-server/index.ts` + `routes.ts` 注册所有 HTTP 路径。
  - 新的管理类 API（daemon/token/health/quota/providers/config-v2）作为一组「管理接口」，挂在 HTTP server 之下。

- **ManagerDaemon 继续作为状态聚合点**
  - 已有的 `src/manager` 模块负责：
    - token 刷新（`TokenManagerModule`）
    - health 持久化（`HealthManagerModule`）
    - quota 追踪（`QuotaManagerModule`）
    - routing 指令状态（`RoutingStateManagerModule`）
  - 新的管理 API 只“读”这些模块暴露的状态或执行低风险动作（例如触发一次 verify），不直接操作 llmswitch-core 的内部路由逻辑。

- **前端 UI 为独立模块**
  - 静态设计页面保留在 `docs/daemon-admin-ui.html`。
  - 真正运行时的管理 UI 视图将作为 HTTP server 提供的静态页面（后续实现阶段接入），前端通过一组只读 JSON API 获取数据。

---

## 2. 后端模块结构（HTTP Server 侧）

### 2.1 入口与路由注册

- 现状：
  - HTTP server 在 `src/server/runtime/http-server/index.ts` 中构造 `RouteCodexHttpServer`。
  - 路由在 `src/server/runtime/http-server/routes.ts` 中通过 `registerHttpRoutes` 注册。

- 规划：
  - 新增一个轻量的“管理 API 路由模块”：
    - 文件：`src/server/runtime/http-server/daemon-admin-routes.ts`
    - 导出函数：`registerDaemonAdminRoutes(options: DaemonAdminRouteOptions): void`
    - 在 `routes.ts` 内部调用 `registerDaemonAdminRoutes(...)`，与现有 `/health`、`/config` 等路由并列。

```ts
// src/server/runtime/http-server/daemon-admin-routes.ts（示意）
export interface DaemonAdminRouteOptions {
  app: Application;
  getManagerDaemon: () => ManagerDaemon | null;
  getServerId: () => string;
}

export function registerDaemonAdminRoutes(options: DaemonAdminRouteOptions): void {
  const { app } = options;
  // 这里仅定义 path → handler 的绑定，具体 handler 抽到子模块。
}
```

### 2.2 管理 API Handler 模块划分

在 `src/server/runtime/http-server` 下增加一个子目录，专门存放管理类 handler：

- 目录：`src/server/runtime/http-server/daemon-admin/`

建议的文件划分：

- `daemon-admin/status-handler.ts`
  - 对应 API：`GET /daemon/status`
  - 依赖：
    - `ManagerDaemon`（读取当前是否为 leader、运行模块列表）
    - `TokenManagerModule`（token Daemon 运行状态）
    - `HealthManagerModule` / `QuotaManagerModule`（用于统计摘要）

- `daemon-admin/credentials-handler.ts`
  - 对应 API：
    - `GET /daemon/credentials`
    - `GET /daemon/credentials/:id`
    - `POST /daemon/credentials/:id/verify`
    - `POST /daemon/credentials/:id/refresh`
  - 依赖：
    - 现有 token 文件扫描、解析工具：
      - `providers/auth/token-scanner` 系列
      - `token-daemon/token-utils` 中的 `readTokenFile` / `evaluateTokenState`
    - 必须避免返回敏感字段（access_token / refresh_token 等），只返回文件路径、issuer、project_id 等非敏感信息。

- `daemon-admin/quota-handler.ts`
  - 对应 API：
    - `GET /quota/summary`
    - `GET /quota/runtime`（按 runtimeKey / providerKey 过滤）
    - `GET /quota/cooldowns`（暴露当前 429 冷却相关信息）
  - 依赖：
    - `QuotaManagerModule` 的 `getRawSnapshot()`。
    - 虚拟路由 cooldown 状态（通过 llmswitch-core 暴露的只读接口，或已有的 series cooldown 统计）。

- `daemon-admin/providers-runtime-handler.ts`
  - 对应 API：`GET /providers/runtimes`
  - 依赖：
    - `RouteCodexHttpServer` 内部已维护的 `providerHandles` / `providerKeyToRuntimeKey` 映射。
    - `HealthManagerModule` / `QuotaManagerModule` 的统计，用于补充 runtime 健康/配额状态。

- `daemon-admin/config-providers-v2-handler.ts`
  - 对应 API：
    - `GET /config/providers/v2`
    - `GET /config/providers/v2/:id`
    - `GET /config/providers/v2/:id/preview-route`
  - 依赖：
    - 未来的 Config V2 loader / Virtual Router builder：
      - provider 定义集合（id/family/protocol/runtimeKey/route/series/defaultModels/credentialsRef/flags）。
    - 虚拟路由中的路由规则（用于 preview-route 的人类可读描述）。

> 以上 handler 模块均保持「薄层」：只做数据组装与序列化，不直接参与路由决策或工具语义处理。

### 2.3 与 ManagerDaemon 的绑定

- `RouteCodexHttpServer` 构造时已经创建并启动了 `ManagerDaemon`：
  - 在 `src/server/runtime/http-server/index.ts` 中：
    - 创建 `ManagerDaemon`；
    - 注册 `HealthManagerModule` / `RoutingStateManagerModule` / `TokenManagerModule` / `QuotaManagerModule`；
    - 持有一个 `managerDaemon` 字段。

- 新的 `registerDaemonAdminRoutes` 需要能够访问这个实例：
  - 在 `RouteCodexHttpServer` 内暴露一个 `getManagerDaemon(): ManagerDaemon | null` 的只读方法。
  - 调用 `registerHttpRoutes` 时，将此方法以闭包形式传递给 `registerDaemonAdminRoutes`，实现解耦：

```ts
// routes.ts（示意）
registerDaemonAdminRoutes({
  app,
  getManagerDaemon: () => this.managerDaemon,
  getServerId: () => this.config.server.serverId
});
```

---

## 3. 前端静态资源结构

### 3.1 设计稿与运行时文件的关系

- 设计稿：
  - `docs/daemon-admin-ui.html` 保留为设计 Mock，展示完整的 UI 布局和交互。

- 运行时静态页面（后续实现阶段）：
  - 计划通过 HTTP server 暴露一个只读页面，例如：
    - `GET /daemon/admin` → 返回一个内嵌或打包好的 HTML。
  - 为了减少重复，推荐方案：
    - 在构建流程中，将 `docs/daemon-admin-ui.html` 复制/压缩到构建输出目录（例如 `dist/daemon-admin/index.html`）。
    - 在 HTTP server 中提供一个简单的静态文件响应（不在本次设计中实现具体逻辑）。

### 3.2 前端脚本组织（后续）

- 前端 JS/CSS 初期可以内联在单一 HTML 中（如当前 mock）。
- 一旦接入真实 API，可将脚本拆分为：
  - `daemon-admin.js`：负责 Tab 切换、调用 JSON API、渲染数据。
  - 后续如有必要，再拆分子模块（例如 `credentials-panel.js`、`providers-panel.js`），但这不是当前阶段的目标。

---

## 4. 与现有路由的关系与约束

- 所有新 API 都必须遵守现有 HTTP server 的约束：
  - 不在管理 API 中直接调用 provider 上游或 llmswitch-core 的 Hub Pipeline。
  - 错误处理统一走现有的 `reportRouteError` + `mapErrorToHttp` 逻辑（通过封装好的 helper）。
  - 只暴露只读或低风险的动作，不提供重写配置、强制路由等高风险操作。

- 管理 UI 相关路径建议统一在以下空间之内：
  - `/daemon/*`：daemon 自身状态、tokens、credentials。
  - `/quota/*`：配额快照与 429 冷却视图。
  - `/providers/*`：runtime 级别的 provider 运行状态。
  - `/config/providers/v2*`：Config V2 声明性配置视图。

> 本文档仅定义结构与边界，实际实现将严格参考本结构，并在实现前再与现有代码和运行约束对齐。实现阶段需同时更新对应的 API 设计文档。

