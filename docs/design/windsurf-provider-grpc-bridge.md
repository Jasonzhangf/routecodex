# Windsurf Provider gRPC Bridge 设计规范（HubPipeline → 云端）

## 目标
在 **单一 `windsurf-chat-provider`** 内实现协议桥接：

- 上游输入：HubPipeline 的 OpenAI Chat 协议（JSON / SSE）
- 下游输出：Windsurf Language Server gRPC（protobuf / HTTP2）
- 禁止重复 provider 实现；禁止并行双实现长期共存

---

## 架构原则

1. **单 provider 真源**
   - 仅保留 `windsurf-chat-provider`
   - 不新增 `windsurf-grpc-provider` 平行实现

2. **协议职责分离**
   - Provider 负责编排与生命周期
   - gRPC transport 负责传输与帧处理
   - proto codec 负责编码/解码
   - bridge 负责 OpenAI Chat ↔ Windsurf proto 语义映射

3. **Fail-fast / no fallback**
   - 连接错误、鉴权错误、模型错误直接透传
   - 禁止 silent fallback 到其他 provider 或 HTTP 假路径

4. **HubPipeline 协议不变**
   - 客户端侧始终是 OpenAI Chat
   - provider 内部做协议桥，不污染 HubPipeline

---

## 模块分层

- `src/providers/core/runtime/windsurf-chat-provider.ts`
  - 单 provider 入口
  - `transportBackend` 路由（http/grpc）
  - request 生命周期控制
  - non-stream / stream 统一出 OpenAI 语义

- `src/providers/core/runtime/grpc/proto.ts`
  - protobuf wire codec（varint / field writer / parse）

- `src/providers/core/runtime/grpc/grpc-client.ts`
  - HTTP2 session 池
  - unary / stream 调用
  - gRPC frame 解析

- `src/providers/core/runtime/grpc/windsurf-grpc-bridge.ts`
  - OpenAI message → Raw/Cascade protobuf
  - provider chunk → OpenAI delta 事件

---

## 配置规范

`[provider.extensions.windsurf]` 至少包含：

```toml
transportBackend = "grpc"
lsPort = 42100
csrfToken = "..."
pollIntervalMs = 500
pollMaxWaitMs = 600000
```

并在 contract 中规范字段：

- `transportBackend: 'http' | 'grpc'`
- `lsPort: number`
- `csrfToken: string`
- `pollIntervalMs: number`
- `pollMaxWaitMs: number`

---

## 运行时路径（必须实现两条）

### A. RawGetChatMessage 路径（兼容）
适用：enum-only 老模型或轻量路径。

流程：
1. Build Raw request
2. gRPC stream `/RawGetChatMessage`
3. parse delta chunk
4. 转 OpenAI SSE delta

### B. Cascade 主路径（主推荐）
适用：新模型与完整语义场景。

流程：
1. `StartCascade`
2. `SendUserCascadeMessage`
3. `GetCascadeTrajectorySteps`（轮询/流）
4. 聚合/转换为 OpenAI chat 输出

> 仅实现 Raw 会出现“grpc-status=0 但 0 帧”假阳性风险。

---

## 强制前置初始化（每个 LS session）

在 chat 请求前必须完成：

1. `InitializeCascadePanelState`
2. `AddTrackedWorkspace`
3. `UpdateWorkspaceTrust`
4. `Heartbeat`

若任一步失败，直接 fail-fast 返回错误。

---

## 鉴权与上下文真源

1. `apiKey` 必须来自 provider auth 真源（真实账号）
2. `csrfToken` 必须与当前 `lsPort` 对应同一进程实例
3. `sessionId` 每 LS 实例稳定复用（同窗口会话）
4. workspace 与 trust 状态需与 session 绑定

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
- 严格输出 `[DONE]` 语义（若当前框架要求）

---

## 错误分型（必须可观测）

至少区分：
- network / transport（HTTP2/gRPC）
- auth（csrf/apiKey/session）
- model unsupported / deprecated
- context init missing
- empty-frame / no-chunk anomaly

错误日志必须包含：
- provider key
- lsPort
- grpc method
- grpc-status / grpc-message
- request id / session id

---

## 验收标准（DoD）

### 功能
- [ ] 单 `windsurf-chat-provider` 同时支持 http/grpc backend
- [ ] gRPC backend 可处理 non-stream + stream
- [ ] Raw 与 Cascade 路径都可用

### 运行证据
- [ ] 前置 4 RPC 全部 `grpc-status=0`
- [ ] 至少 1 条 non-stream chat 返回 assistant 文本
- [ ] 至少 1 条 stream chat 返回多段 delta chunk

### 兼容性
- [ ] HubPipeline 无需改协议
- [ ] OpenAI 客户端无需改接入方式

### 可靠性
- [ ] 失败直接暴露，无 fallback
- [ ] 日志可定位到唯一阶段与方法

---

## 当前已知风险

1. 连接到非目标 LS（例如其他 app 的 language_server）会导致“链路通但 chat 空”
2. 使用 test-key 等伪鉴权会导致业务 RPC 无输出
3. 模型 enum/uid 映射不完整会触发 silent no-output 或 model error

---

## 实施顺序（推荐）

1. 固化配置与 contract 字段
2. 打通 provider 内 `sendRequestInternal` gRPC 分支
3. 实现前置初始化器（session-aware）
4. 实现 Raw 路径
5. 实现 Cascade 路径
6. 完成 non-stream / stream 双验收
7. 补齐模型映射表与错误分型

