# Windsurf Chat Provider 设计（云端直连版）

## 目标

定义 RouteCodex 中 Windsurf Provider 的唯一正确设计：

- `HTTP Server -> Hub Pipeline -> Windsurf Provider -> 云端 Chat/Model/Auth 服务`
- Provider 直接面向 **云端 Chat + SeatManagement + ApiServer**
- **不允许**经过本地 WindsurfAPI、本地 Language Server、localhost 端口

---

## 1. 结论与纠偏

历史错误设计：

```text
Provider -> localhost / WindsurfAPI / Local LS -> Cloud
```

该设计已确认错误，原因：

1. Provider 边界职责错位
2. 引入本地 IDE 进程依赖，不稳定且不可控
3. 破坏 `Provider V2 -> upstream` 单一路径真源

唯一正确设计：

```text
Provider -> Windsurf / CloudCode Cloud
```

---

## 2. 分层与职责边界

### 2.1 Hub Pipeline

职责：
- 标准 OpenAI Chat / Responses 语义
- 工具治理
- 路由选择
- 统一响应契约

### 2.2 Windsurf Provider

职责：
- Windsurf 云端认证注入
- Windsurf/CloudCode 协议适配
- 请求发送到云端
- 响应归一为 OpenAI 形状
- 错误分型与上报
- chat cloud 协议未完成时的显式错误

禁止：
- 依赖 localhost / 本地 LS / 本地 CSRF
- 启动、管理、探测本地 IDE 进程
- 把本地 workspace / panel state 当作主链路前置条件

### 2.3 云端真源

当前从 **`/Volumes/extension/code/WindsurfAPI`** 已确认的账号/模型目录服务面：

- `server.codeium.com`
- `server.self-serve.windsurf.com`

当前从 **`/Volumes/extension/code/WindsurfAPI`** 已确认的账号/模型目录接口族：

- `exa.seat_management_pb.SeatManagementService/*`
- `exa.api_server_pb.ApiServerService/*`

当前从 **`WindsurfAPI`** 可直接确认的是：

- 登录/认证 API 存在
- SeatManagement / ApiServer 相关云端 API 存在
- 模型目录与 modelUid / enumValue 真源存在
- 但 chat 主链在参考项目里仍然走本地 Cascade/LS

因此聊天主链必须是 **云端 chat 服务**，而非本地 IDE gRPC；并且在 cloud chat 协议尚未被唯一真源推导完成前，provider 必须显式 fail-fast。

---

## 3. 推荐模块

- `src/providers/core/runtime/windsurf-chat-provider.ts`
  - 唯一 provider 实现

- `src/providers/core/contracts/windsurf-provider-contract.ts`
  - 云端配置 contract

- `src/providers/core/runtime/grpc/*`
  - 仅在“云端仍需 gRPC/Connect/HTTP2”时保留
  - 必须移除 localhost 语义

---

## 4. 配置规范

### 允许的配置

```toml
[provider.extensions.windsurf]
transportBackend = "cascade-cloud"
apiBaseUrl = "https://daily-cloudcode-pa.googleapis.com"
apiBaseUrlFallback = "https://cloudcode-pa.googleapis.com"
modelsApiBaseUrl = "https://server.self-serve.windsurf.com"
modelsApiBaseUrlFallback = "https://server.codeium.com"
pollIntervalMs = 500
pollMaxWaitMs = 600000
```

### 必须退出的错误字段

- `lsPort`
- `csrfToken`
- 本地 `LanguageServerService` 路径配置
- 任何 localhost 端口发现/绑定配置

---

## 5. 认证设计

Windsurf Provider 的认证真源必须面向云端。

当前已知事实：

- `sessionToken` / 云端可接受的账号凭据，才是应交给云端的认证真源
- `email|ott$...`、本地 IDE token、临时本地 session 组合值，都不能被当作 Provider 主链认证真源

Provider 的职责是：

1. 从 provider auth 真源取账号凭据
2. 组装云端请求 metadata / headers
3. 向云端发请求

---

## 6. 运行时路径

### 6.1 状态/额度/模型目录

用途：
- GetUserStatus
- GetCascadeModelConfigs
- CheckUserMessageRateLimit

路径：

```text
Provider -> HTTPS JSON / Connect-RPC -> Cloud
```

### 6.2 聊天

用途：
- 非流式聊天
- 流式聊天
- 工具调用
- 多轮上下文

路径：

```text
Provider -> Cloud Chat
```

当前可确认约束：

- chat 主链最终必须是云端 endpoint
- 但具体 chat 方法/路径在 `WindsurfAPI` 未给出可直接复用的云端 chat 实现前，不能伪造为已验证事实
- 无论底层是 JSON、Connect-RPC、HTTP2 还是其他私有协议，都必须是 **云端 endpoint**，而不是 `localhost:*`。

---

## 7. OpenAI 兼容输出

### non-stream
- `chat.completion`
- `choices[0].message.role = assistant`
- `finish_reason`

### stream
- OpenAI SSE delta
- `[DONE]`

---

## 8. 测试与回归要求

必须新增并锁定：

1. **禁止 localhost 链路**
   - Windsurf Provider 不得请求 `localhost`
   - 不得读取活 `lsPort/csrfToken` 作为主链必要条件

2. **必须面向云端 endpoint**
   - provider 构造出的请求 endpoint 必须是云端 host
   - chat cloud 协议未完成前，provider 必须显式 fail-fast，不能伪装成已命中某个云端 chat path

3. **错误暴露**
   - 云端错误直接透传，不得被伪装成本地端口错误

---

## 9. 实施顺序

1. 先修本文档与总设计文档
2. 再修 contract
3. 再删本地 LS 语义
4. 再仅基于 `WindsurfAPI` 真源补齐云端聊天主链
5. 最后 build / install / restart / live verify
