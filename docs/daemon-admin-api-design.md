# Daemon / Token / Quota / Providers / Config V2 管理 API 设计

> 目标：为 Daemon 管理 UI 和基于 Config V2 的 Provider 管理视图提供一组 **只读或低风险** 的 HTTP JSON API。  
> 所有 API 均由 HTTP server 提供，数据来源于 ManagerDaemon、虚拟路由和 Config V2，禁止在此层做路由/工具语义决策。

---

## 1. 通用约定

- 所有 API 均以 JSON 形式返回。
- 错误返回格式对齐现有 HTTP server：
  - HTTP 状态码 4xx/5xx。
  - Body: `{ "error": { "message": string, "code"?: string, ... } }`
- 仅暴露**非敏感字段**：
  - 不返回 access_token / refresh_token / client_secret 等。
  - 对 token 文件路径等敏感信息仅返回相对路径或掩码版本。

---

## 2. Daemon 状态 API

### 2.1 `GET /daemon/status`

> 展示当前 HTTP server 实例的 daemon/manager 状态，以及关键模块是否运行。

- 响应示例：

```jsonc
{
  "ok": true,
  "serverId": "routecodex-dev-5555",
  "version": "0.89.872",
  "uptimeSec": 1234,
  "manager": {
    "active": true,
    "modules": [
      { "id": "token", "status": "leader", "details": { "intervalSec": 60 } },
      { "id": "quota", "status": "running" },
      { "id": "health", "status": "running" },
      { "id": "routing", "status": "running", "stickyEnabled": true }
    ]
  }
}
```

- 数据来源：
  - `RouteCodexHttpServer`（serverId、版本、uptime）。
  - `ManagerDaemon` + 各 `ManagerModule` 的只读状态。

---

## 3. Credentials 管理 API

> 注意：所有 API 必须避免泄露敏感字段，只用于展示凭证状态和触发安全的 verify/refresh 操作。

### 3.1 `GET /daemon/credentials`

- 用途：列出 daemon 管理下已知的 credential 条目。
- 响应示例：

```jsonc
[
  {
    "id": "iflow-oauth-1-186",
    "kind": "oauth",
    "providerFamily": "gemini",
    "alias": "iflow-186",
    "tokenFile": "~/.routecodex/auth/iflow-oauth-1-186.json",
    "projectId": "my-project",
    "expiresAt": 1736500000000,
    "expiresInSec": 3600,
    "status": "valid", // valid | expiring | expired | invalid
    "lastError": null
  }
]
```

- 数据来源：
  - Token 文件扫描器（现有 `scanProviderTokenFiles` 等）。
  - `readTokenFile` + `evaluateTokenState`。

### 3.2 `GET /daemon/credentials/:id`

- 用途：查看单个 credential 的详细信息（仍然不包含密钥本体）。
- 响应字段在列表基础上可增加：

```jsonc
{
  "id": "iflow-oauth-1-186",
  "kind": "oauth",
  "providerFamily": "gemini",
  "alias": "iflow-186",
  "tokenFile": "~/.routecodex/auth/iflow-oauth-1-186.json",
  "projectId": "my-project",
  "expiresAt": 1736500000000,
  "expiresInSec": 3600,
  "status": "valid",
  "lastError": null,
  "issuer": "https://accounts.google.com",
  "scopes": ["https://www.googleapis.com/auth/cloud-platform"],
  "createdAt": 1736400000000,
  "updatedAt": 1736499900000
}
```

### 3.3 `POST /daemon/credentials/:id/verify`

- 用途：触发一次“最佳努力”的远端验证（例如调用 userinfo 或简单的 API ping）。
- 请求体：可为空 `{}`。
- 响应示例：

```jsonc
{
  "ok": true,
  "id": "iflow-oauth-1-186",
  "status": "valid", // valid | invalid | error
  "checkedAt": 1736500100000,
  "message": "Token accepted by upstream."
}
```

- 行为约束：
  - 仅在本地发起一次轻量级验证，不做重试风暴。
  - 失败时只记录错误，不修改配置文件。

### 3.4 `POST /daemon/credentials/:id/refresh`

- 用途：在安全前提下触发一次刷新（如果支持 refresh_token）。
- 响应示例：

```jsonc
{
  "ok": true,
  "id": "iflow-oauth-1-186",
  "status": "refreshed",
  "expiresAt": 1736503600000
}
```

- 约束：
  - 必须遵守现有 token-daemon 的刷新策略，不与后台自动刷新逻辑冲突。
  - 若不支持手动刷新，应返回 `400` 或 `409` 并给出明确错误信息。

---

## 4. Quota & 429 冷却 API

### 4.1 `GET /quota/summary`

- 用途：展示所有受管配额（目前主要是 Antigravity）的摘要。
- 响应示例：

```jsonc
{
  "updatedAt": 1736500000000,
  "records": [
    {
      "key": "antigravity://jasonqueque/gemini-3-pro-low",
      "alias": "jasonqueque",
      "modelId": "gemini-3-pro-low",
      "remainingFraction": 0.42,
      "resetAt": 1736503600000
    }
  ]
}
```

- 数据来源：
  - `QuotaManagerModule.getRawSnapshot()`。

### 4.2 `GET /quota/runtime`

- 用途：按 runtimeKey 或 providerKey 过滤配额状态。
- 查询参数：
  - `runtimeKey?: string`
  - `providerKey?: string`
- 响应示例：

```jsonc
{
  "runtimeKey": "antigravity.jasonqueque",
  "items": [
    {
      "providerKey": "antigravity.jasonqueque.gemini-3-pro-low",
      "modelId": "gemini-3-pro-low",
      "remainingFraction": 0.42,
      "resetAt": 1736503600000
    }
  ]
}
```

### 4.3 `GET /quota/cooldowns`

- 用途：展示当前虚拟路由层面的 series cooldown 状态（与 429 相关）。
- 响应示例（形态示意）：

```jsonc
[
  {
    "providerId": "antigravity.jasonqueque",
    "providerKey": "antigravity.jasonqueque.gemini-3-pro-low",
    "series": "gemini-pro",
    "cooldownMs": 300000,
    "until": 1736500200000
  }
]
```

- 数据来源：
  - llmswitch-core virtual router 暴露的 cooldown 只读视图（或内部缓存）。

---

## 5. Providers 运行时视图 API

### 5.1 `GET /providers/runtimes`

- 用途：展示当前 virtual router 中实际存在的 provider runtimes 及其状态。
- 响应示例：

```jsonc
[
  {
    "providerKey": "antigravity.jasonqueque.gemini-3-pro-low",
    "runtimeKey": "antigravity.jasonqueque",
    "family": "gemini",
    "protocol": "gemini-chat",
    "series": "gemini-pro",
    "enabled": true,
    "boundCredentialId": "iflow-oauth-1-186",
    "health": {
      "status": "ok",
      "lastErrorAt": null,
      "recent429Count": 2
    }
  }
]
```

- 数据来源：
  - `RouteCodexHttpServer` 中的 provider runtime 映射。
  - Health/quota manager 模块。
  - Credential 绑定信息从 Config 解析（不直接读取密钥）。

---

## 6. Config V2 Provider 视图 API

> 与 `docs/provider-config-v2-ui-design.md` 对应，只读展示 Config V2 中声明的 provider 定义，并与 runtime/credentials 形成弱关联。

### 6.1 `GET /config/providers/v2`

- 用途：列出 Config V2 中声明的 provider 定义摘要。

```jsonc
[
  {
    "id": "antigravity.jasonqueque.gemini-3-pro-low",
    "family": "gemini",
    "protocol": "gemini-chat",
    "runtimeKey": "antigravity.jasonqueque",
    "route": "default",
    "series": "gemini-pro",
    "enabled": true,
    "source": "virtualrouter.v2.json#providers[3]",
    "defaultModels": ["gemini-3-pro-low"],
    "credentialsRef": "antigravity-oauth-2-jasonqueque.json"
  }
]
```

### 6.2 `GET /config/providers/v2/:id`

- 用途：查看单个 provider 的详细 Config V2 配置。
- 在 6.1 的基础上，增加：

```jsonc
{
  "id": "antigravity.jasonqueque.gemini-3-pro-low",
  "family": "gemini",
  "protocol": "gemini-chat",
  "runtimeKey": "antigravity.jasonqueque",
  "route": "default",
  "series": "gemini-pro",
  "enabled": true,
  "source": "virtualrouter.v2.json#providers[3]",
  "defaultModels": ["gemini-3-pro-low"],
  "allowedModels": ["gemini-3-pro-low", "gemini-3-pro-high"],
  "aliases": {
    "thinking": "gemini-3-pro-high",
    "low": "gemini-3-pro-low"
  },
  "credentialsRef": "antigravity-oauth-2-jasonqueque.json",
  "quota": {
    "perMinuteLimit": 60,
    "perHourLimit": 2000
  },
  "flags": {
    "beta": false,
    "internalOnly": false
  },
  "notes": "Primary Gemini Pro provider for Antigravity runtime."
}
```

### 6.3 `GET /config/providers/v2/:id/preview-route`

- 用途：把该 provider 在虚拟路由中的路由规则用人类可读的方式展示出来。

```jsonc
{
  "id": "antigravity.jasonqueque.gemini-3-pro-low",
  "route": "default",
  "series": "gemini-pro",
  "description": [
    "Matched when route=default and series=gemini-pro.",
    "Primary for tools: tool-request-detected, last-tool-other.",
    "Cooldown series: gemini-pro (300000 ms)."
  ]
}
```

- 数据来源：
  - Virtual Router 的内部路由表，序列化为文本说明。

---

## 7. 安全与访问控制（设计约束）

- 初期阶段，所有管理 API 仅对 `localhost` 暴露：
  - 与现有 `/shutdown` 路由类似，限制 remoteAddress 为 127.0.0.1 / ::1。
- 不在管理 API 中提供：
  - 修改配置、强制切换路由、直接操作上游 provider 的危险动作。
- 日志：
  - 重要错误统一走 `RouteErrorHub`，标记 `scope: 'http' | 'daemon'`，但避免在日志中打印敏感字段。

---

## 8. 与任务规划的对应关系

- 「文件结构落盘」：
  - 对应 `docs/daemon-admin-module-structure.md` 中的模块/路径设计。
- 「文档详细设计更新」：
  - 对应本文件中对各 API 的输入/输出定义。
- 后续实现步骤：
  - 在 HTTP server 中新增 `daemon-admin-routes` 与各 handler。
  - 在前端 UI 中按本 API 规范对接数据。
  - 最终做一轮端到端集成测试（含 429 冷却/配额展示/credential 状态联动）。

