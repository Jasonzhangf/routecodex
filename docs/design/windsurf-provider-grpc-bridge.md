# Windsurf Provider 云端 Chat 桥接设计（Hub Pipeline → Provider → Cloud）

## 目标
在 **单一 `windsurf-chat-provider`** 内实现唯一正确链路：

- 上游输入：Hub Pipeline 的标准 OpenAI Chat / Responses 语义
- 下游输出：**云端 Windsurf/CloudCode Chat 服务**
- **禁止**任何本地 Language Server / localhost / 本地监听端口 参与请求主链路

---

## 结论先行（硬约束）

### 唯一正确执行路径

```text
HTTP Server
  -> llmswitch-core Hub Pipeline
  -> windsurf-chat-provider
  -> Windsurf / CloudCode Cloud Chat
```

### 明确禁止的错误路径

```text
Hub Pipeline
  -> Provider
  -> localhost / 本地 LS / 本地 gRPC 端口
  -> 云端
```

### 原因

Provider 的职责是 **连接 Hub Pipeline 与云端上游**，不是连接本地 IDE 进程。

本地 Language Server / 本地端口 / 本地 CSRF：
- 不是稳定云端协议真源
- 不是 RouteCodex 可控运行时契约
- 会把 Provider 设计成 IDE 代理，而不是云端 Provider
- 与本项目 `HTTP server -> llmswitch-core Hub Pipeline -> Provider V2 -> upstream` 的单一路径真源冲突

---

## 架构原则

1. **单 provider 真源**
   - 仅保留 `windsurf-chat-provider`
   - 不新增并行 `windsurf-local-ls-provider` / `windsurf-grpc-provider`

2. **Provider 只桥接 Hub Pipeline 与云端**
   - Provider 负责协议适配、认证注入、错误映射、流式输出归一
   - Provider 不负责本地 IDE/LS 生命周期

3. **Fail-fast / no fallback**
   - 云端认证错误、模型错误、协议错误直接暴露
   - 禁止 fallback 到 localhost、本地 LS、假 HTTP 路径、其他 provider

4. **Hub Pipeline 协议不变**
   - 客户端仍使用标准 OpenAI Chat / Responses
   - provider 内部完成 Windsurf/CloudCode 特定协议桥接

---

## 模块分层

- `src/providers/core/runtime/windsurf-chat-provider.ts`
  - 唯一 provider 入口
  - 负责：请求预处理、云端认证、云端传输、响应归一、错误分型

- `src/providers/core/runtime/grpc/`
  - 如继续保留，只能服务 **云端 gRPC/HTTP2/Connect 协议**
  - **不得**再隐含 `localhost:${port}` / 本地 session 池语义

- `src/providers/core/contracts/windsurf-provider-contract.ts`
  - 只定义云端 Provider 需要的运行时配置
  - 不再承载本地 LS 端口/本地 CSRF 语义

---

## 下游真源

当前从 **`/Volumes/extension/code/WindsurfAPI`** 已验证的账号/模型目录服务面包括：

- `server.codeium.com`
- `server.self-serve.windsurf.com`

当前从 **`/Volumes/extension/code/WindsurfAPI`** 已验证的账号/模型目录接口族包括：

- `exa.seat_management_pb.SeatManagementService/*`
- `exa.api_server_pb.ApiServerService/*`

当前从 **`/Volumes/extension/code/WindsurfAPI`** 可直接确认的是：

- 登录/认证相关云端 API 存在
- 账号状态/模型目录相关云端 API 存在
- 模型目录真源在 `src/models.js`
- 参考项目当前 chat 主链 **仍是本地 Cascade/LS**

因此当前**不能把外部日志里的 cloud chat endpoint 当作 Windsurf 真源**。
对 RouteCodex 来说，正确做法是：

- 设计目标仍然是 `Provider -> Cloud`
- 但在真正推导出 chat cloud 协议之前，provider 必须 **fail-fast**
- 禁止继续走 `localhost / LS / gRPC` 假装“先跑通”

若后续聊天主链补出更多云端服务，也必须遵循同一原则：

- **云端 endpoint 显式配置或内建真源**
- **不得依赖本地 IDE 端口转发**

---

## 配置规范（修正后）

`[provider.extensions.windsurf]` 只允许承载 **云端** 运行时语义，例如：

```toml
transportBackend = "cascade-cloud"
apiBaseUrl = "https://daily-cloudcode-pa.googleapis.com"
apiBaseUrlFallback = "https://cloudcode-pa.googleapis.com"
modelsApiBaseUrl = "https://server.self-serve.windsurf.com"
modelsApiBaseUrlFallback = "https://server.codeium.com"
pollIntervalMs = 500
pollMaxWaitMs = 600000
```

推荐 contract 字段：

- `transportBackend: 'cascade-cloud'`
- `apiBaseUrl?: string`
- `apiBaseUrlFallback?: string`
- `modelsApiBaseUrl?: string`
- `modelsApiBaseUrlFallback?: string`
- `pollIntervalMs?: number`
- `pollMaxWaitMs?: number`

### 明确删除的错误字段

以下字段属于错误架构，必须退出主设计：

- `lsPort`
- `csrfToken`
- 任何 `localhost` / 本地 `LanguageServerService` 绑定字段

---

## 运行时路径

### A. 账号/状态/模型目录路径

适用：账号状态、额度、模型能力、预检

流程：
1. Build cloud metadata/auth body
2. 请求云端 SeatManagement / ApiServer 接口
3. 归一化响应到 Provider / Host 可消费语义

当前已验证 host：

- `server.codeium.com`
- `server.self-serve.windsurf.com`

### B. 聊天主路径

适用：聊天、工具、多轮、流式输出

流程：
1. 标准请求进入 `windsurf-chat-provider`
2. provider 将 OpenAI Chat / Responses 语义映射到 CloudCode chat 云端语义
3. provider 直连云端聊天服务（chat cloud 协议未由 `WindsurfAPI` 唯一真源推导完成前，必须显式 fail-fast）
4. provider 将云端输出归一为 OpenAI chat/non-stream 或 SSE stream

当前状态：

- 目标架构：直连云端
- 真源约束：仅可参考 `WindsurfAPI`
- 实现策略：在 chat cloud 协议未完成前，provider 显式报错，不得回退到本地 LS

---

## 明确删除的旧设计

以下旧设计已经被确认错误，不得继续作为活设计：

1. **本地 LS 前置初始化**
   - `InitializeCascadePanelState`
   - `AddTrackedWorkspace`
   - `UpdateWorkspaceTrust`
   - `Heartbeat`

2. **本地 session / workspace 绑定**
   - 本地 `sessionId`
   - 本地 workspace trust
   - 本地 IDE panel state

3. **本地 gRPC health check**
   - 对 `localhost:${lsPort}` 做 provider 健康检查

这些都属于 IDE/本地代理语义，不是 RouteCodex Provider 的真源职责。

---

## OpenAI 兼容输出规范

### non-stream
返回：
- `object=chat.completion`
- `choices[0].message.role=assistant`
- `choices[0].finish_reason`

### stream
返回 SSE：
- `data: {choices:[{delta:{content:"..."}}]}`
- 最终 `finish_reason=stop`
- 严格输出 `[DONE]`

---

## 错误分型（必须可观测）

至少区分：

- cloud network / transport
- auth / account invalid
- entitlement / quota / rate limit
- model unsupported
- cloud chat protocol error
- malformed / empty upstream payload

错误日志必须包含：

- provider key
- cloud endpoint
- cloud method / path
- request id
- upstream status / code / error body 摘要

---

## 验收标准（DoD）

### 功能
- [ ] `windsurf-chat-provider` 不再依赖 localhost / 本地 LS
- [ ] `windsurf-chat-provider` 不再把 `lsPort/csrfToken` 当作活运行时语义
- [ ] chat 协议未完成时显式 fail-fast，而不是静默回退到本地 gRPC
- [ ] Provider 主链路直连云端聊天服务
- [ ] non-stream / stream 都可输出标准 OpenAI 语义

### 运行证据
- [ ] 活请求日志不再出现 `localhost` / `lsPort` / `LanguageServerService`
- [ ] 至少 1 条非流式请求成功命中云端
- [ ] 至少 1 条流式请求成功命中云端

### 架构
- [ ] Provider 只桥接 Hub Pipeline 与云端
- [ ] 本地 LS / 端口 / CSRF 字段从活 contract 中退出

### 可靠性
- [ ] 失败直接暴露，无 fallback
- [ ] 日志能定位到唯一云端请求阶段

---

## 实施顺序（修正版）

1. 先修设计文档与 contract
2. 删除本地 LS / localhost 依赖语义
3. 建立云端 endpoint + auth 真源
4. 接通云端状态/模型目录接口
5. 接通云端 Cascade 聊天主链
6. 补“禁止 localhost 链路”回归
7. build / install / restart / live verify
